import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GmailClient } from "./gmail-client.js";
import type { ThreadResponse } from "./quoting.js";
import { parseGogThreadOutput } from "./quoting.js";
import type { GogSearchMessage } from "./inbound.js";

const execFileAsync = promisify(execFile);

const GOG_TIMEOUT_MS = 30_000;

interface CircuitState {
  consecutiveFailures: number;
  lastFailureAt: number;
  backoffUntil: number;
}

const CIRCUIT_CONFIG = {
  maxFailures: 3,
  initialBackoffMs: 60_000,
  maxBackoffMs: 15 * 60_000,
};

export class GogGmailClient implements GmailClient {
  private circuit: CircuitState = { consecutiveFailures: 0, lastFailureAt: 0, backoffUntil: 0 };

  constructor(private accountEmail: string) {}

  /**
   * Check if the gog CLI is available on PATH.
   */
  static async checkExists(): Promise<boolean> {
    try {
      await execFileAsync("gog", ["--version"]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Write operation via spawn() — fire-and-forget style with retries.
   * Mirrors outbound.ts:17-44.
   */
  private async execGog(args: string[], retries = 3): Promise<void> {
    for (let i = 0; i < retries; i++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const proc = spawn("gog", args, { stdio: "pipe" });
          let err = "";
          let out = "";
          proc.stderr.on("data", (d) => (err += d.toString()));
          proc.stdout.on("data", (d) => (out += d.toString()));
          proc.on("error", (e) => reject(new Error(`gog failed to spawn: ${e.message}`)));
          proc.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`gog failed (code ${code}): ${err || out}`));
          });
          setTimeout(() => {
            proc.kill();
            reject(new Error("gog timed out after 30s"));
          }, GOG_TIMEOUT_MS);
        });
        return;
      } catch (err) {
        if (i === retries - 1) throw err;
        await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
      }
    }
  }

  /**
   * Read operation via execFileAsync() with circuit breaker.
   * Mirrors monitor.ts:70-125.
   */
  private async runGog(args: string[], retries = 3): Promise<Record<string, unknown> | null> {
    const circuit = this.circuit;
    const now = Date.now();

    if (now < circuit.backoffUntil) {
      throw new Error(
        `Circuit breaker active for ${this.accountEmail}. Backing off until ${new Date(circuit.backoffUntil).toISOString()}`,
      );
    }

    const allArgs = ["--json", "--account", this.accountEmail, ...args];
    let lastErr: any;

    for (let i = 0; i < retries; i++) {
      try {
        const { stdout } = await execFileAsync("gog", allArgs, {
          maxBuffer: 10 * 1024 * 1024,
          timeout: GOG_TIMEOUT_MS,
        });

        // Success — reset circuit
        circuit.consecutiveFailures = 0;
        circuit.backoffUntil = 0;

        if (!stdout.trim()) return null;
        return JSON.parse(stdout) as Record<string, unknown>;
      } catch (err: unknown) {
        lastErr = err;
        const msg = String(err);

        // 404 → not found, not a failure
        if (msg.includes("404")) return null;

        // Trip circuit breaker on auth / server errors
        if (msg.includes("403") || msg.includes("invalid_grant") || msg.includes("ETIMEDOUT") || msg.includes("500")) {
          circuit.consecutiveFailures++;
          circuit.lastFailureAt = Date.now();

          if (circuit.consecutiveFailures >= CIRCUIT_CONFIG.maxFailures) {
            const backoff = Math.min(
              CIRCUIT_CONFIG.initialBackoffMs * Math.pow(2, circuit.consecutiveFailures - CIRCUIT_CONFIG.maxFailures),
              CIRCUIT_CONFIG.maxBackoffMs,
            );
            circuit.backoffUntil = Date.now() + backoff;
          }
          break;
        }

        if (i < retries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
        }
      }
    }

    const error = lastErr as { stderr?: string; message?: string };
    throw new Error(`gog failed: ${error.stderr || error.message || String(lastErr)}`);
  }

  // ── GmailClient interface ──────────────────────────────────────────

  async send(opts: {
    account?: string;
    to?: string;
    subject: string;
    textBody: string;
    htmlBody?: string;
    threadId?: string;
    replyToMessageId?: string;
    replyAll?: boolean;
  }): Promise<void> {
    const args = ["gmail", "send"];
    if (this.accountEmail) args.push("--account", this.accountEmail);
    if (opts.to) args.push("--to", opts.to);
    if (opts.subject) args.push("--subject", opts.subject);
    if (opts.threadId) args.push("--thread-id", opts.threadId);
    if (opts.replyToMessageId) args.push("--reply-to-message-id", opts.replyToMessageId);
    if (opts.replyAll) args.push("--reply-all");
    if (opts.htmlBody) args.push("--body-html", opts.htmlBody);
    args.push("--body", opts.textBody);
    await this.execGog(args);
  }

  async getThread(threadId: string, opts?: { full?: boolean }): Promise<ThreadResponse | null> {
    const args = ["gmail", "thread", "get", threadId];
    if (opts?.full !== false) args.push("--full");
    const data = await this.runGog(args);
    if (!data) return null;
    return parseGogThreadOutput(data);
  }

  async getMessage(messageId: string): Promise<Record<string, unknown> | null> {
    return this.runGog(["gmail", "get", messageId]);
  }

  async searchMessages(
    query: string,
    opts?: { maxResults?: number; includeBody?: boolean },
  ): Promise<GogSearchMessage[]> {
    const args = ["gmail", "messages", "search", query];
    if (opts?.includeBody !== false) args.push("--include-body");
    args.push("--max", String(opts?.maxResults ?? 50));
    const res = await this.runGog(args);
    if (!res || !Array.isArray((res as any).messages)) return [];
    return (res as any).messages as GogSearchMessage[];
  }

  async searchThreads(query: string, opts?: { maxResults?: number }): Promise<Record<string, unknown> | null> {
    const args = ["gmail", "search", query];
    args.push("--max", String(opts?.maxResults ?? 50));
    return this.runGog(args);
  }

  async modifyLabels(id: string, opts: { add?: string[]; remove?: string[] }): Promise<void> {
    const args = ["gmail", "labels", "modify", id];
    if (opts.add) for (const l of opts.add) args.push("--add", l);
    if (opts.remove) for (const l of opts.remove) args.push("--remove", l);
    await this.runGog(args);
  }

  async modifyThreadLabels(threadId: string, opts: { add?: string[]; remove?: string[] }): Promise<void> {
    const args = ["gmail", "thread", "modify", threadId];
    if (opts.add) for (const l of opts.add) args.push("--add", l);
    if (opts.remove) for (const l of opts.remove) args.push("--remove", l);
    await this.runGog(args);
  }

  async listLabels(): Promise<{ id: string; name: string }[]> {
    const res = await this.runGog(["gmail", "labels", "list"]);
    return ((res as any)?.labels || []) as { id: string; name: string }[];
  }

  async createLabel(name: string): Promise<void> {
    await this.runGog(["gmail", "labels", "create", name]);
  }

  async downloadAttachment(messageId: string, attachmentId: string, outPath: string): Promise<void> {
    // No circuit breaker for attachment downloads
    await execFileAsync("gog", [
      "gmail",
      "attachment",
      messageId,
      attachmentId,
      "--account",
      this.accountEmail,
      "--out",
      outPath,
    ]);
  }

  async getSendAs(): Promise<{ displayName?: string; email: string; isPrimary?: boolean }[]> {
    const res = await this.runGog(["gmail", "settings", "sendas", "list"]);
    return ((res as any)?.sendAs || []) as { displayName?: string; email: string; isPrimary?: boolean }[];
  }
}
