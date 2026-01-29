import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import lockfile from "proper-lockfile";
import type { ChannelLogSink, InboundMessage } from "moltbot/plugin-sdk";
import type { ResolvedGmailAccount } from "./accounts.js";
import { loadHistoryId, saveHistoryId } from "./history-store.js";
import { parseInboundGmail, parseSearchGmail, type GogPayload, type GogSearchMessage } from "./inbound.js";
import { extractAttachments, type GmailAttachment } from "./attachments.js";
import { isAllowed } from "./normalize.js";

const execFileAsync = promisify(execFile);

// Polling interval: Default 60s, override via env for testing
const DEFAULT_POLL_INTERVAL = 60_000;
const POLL_INTERVAL_MS = process.env.GMAIL_POLL_INTERVAL_MS
  ? parseInt(process.env.GMAIL_POLL_INTERVAL_MS, 10)
  : DEFAULT_POLL_INTERVAL;
const MAX_AUTO_DOWNLOAD_SIZE = 5 * 1024 * 1024; // 5MB
const QUARANTINE_LABEL = "not-allow-listed";

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
        clearTimeout(timeout);
        resolve();
    }, { once: true });
});

const GOG_TIMEOUT_MS = 30_000;
const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Local deduplication cache to prevent re-dispatching messages before Gmail updates labels
const dispatchedMessageIds = new Set<string>();
// Clear cache periodically to prevent memory growth (every hour)
setInterval(() => dispatchedMessageIds.clear(), 60 * 60 * 1000).unref();

interface CircuitState {
  consecutiveFailures: number;
  lastFailureAt: number;
  backoffUntil: number;
}

const CIRCUIT_CONFIG = {
  maxFailures: 3,
  initialBackoffMs: 60_000, // 1 minute
  maxBackoffMs: 15 * 60_000, // 15 minutes
};

const circuitStates = new Map<string, CircuitState>();

function getCircuit(email: string): CircuitState {
  if (!circuitStates.has(email)) {
    circuitStates.set(email, { consecutiveFailures: 0, lastFailureAt: 0, backoffUntil: 0 });
  }
  return circuitStates.get(email)!;
}

async function checkGogExists(): Promise<boolean> {
  try {
    await execFileAsync("gog", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function runGog(args: string[], accountEmail: string, retries = 3): Promise<Record<string, unknown> | null> {
  const circuit = getCircuit(accountEmail);
  const now = Date.now();

  if (now < circuit.backoffUntil) {
    throw new Error(`Circuit breaker active for ${accountEmail}. Backing off until ${new Date(circuit.backoffUntil).toISOString()}`);
  }

  const allArgs = ["--json", "--account", accountEmail, ...args];
  let lastErr: any;

  for (let i = 0; i < retries; i++) {
    try {
      const { stdout } = await execFileAsync("gog", allArgs, { 
        maxBuffer: 10 * 1024 * 1024,
        timeout: GOG_TIMEOUT_MS,
      });

      // Success - reset circuit
      circuit.consecutiveFailures = 0;
      circuit.backoffUntil = 0;

      if (!stdout.trim()) return null;
      return JSON.parse(stdout) as Record<string, unknown>;
    } catch (err: unknown) {
      lastErr = err;
      const msg = String(err);
      
      // Don't retry/backoff on certain errors (e.g. 404 means no messages, not a failure)
      if (msg.includes("404")) {
         return null;
      }

      if (msg.includes("403") || msg.includes("invalid_grant") || msg.includes("ETIMEDOUT") || msg.includes("500")) {
        circuit.consecutiveFailures++;
        circuit.lastFailureAt = Date.now();
        
        if (circuit.consecutiveFailures >= CIRCUIT_CONFIG.maxFailures) {
          const backoff = Math.min(
            CIRCUIT_CONFIG.initialBackoffMs * Math.pow(2, circuit.consecutiveFailures - CIRCUIT_CONFIG.maxFailures),
            CIRCUIT_CONFIG.maxBackoffMs
          );
          circuit.backoffUntil = Date.now() + backoff;
        }
        break; 
      }

      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
      }
    }
  }

  const error = lastErr as { stderr?: string; message?: string };
  throw new Error(`gog failed: ${error.stderr || error.message || String(lastErr)}`);
}

export async function quarantineMessage(id: string, accountEmail: string, log: ChannelLogSink) {
  try {
    // Add 'not-allow-listed', remove 'INBOX', leave UNREAD
    await runGog(["gmail", "labels", "modify", id, "--add", "not-allow-listed", "--remove", "INBOX"], accountEmail);
    log.info(`Quarantined message ${id} from disallowed sender (moved to not-allow-listed, removed from INBOX)`);
  } catch (err) {
    log.error(`Failed to quarantine message ${id}: ${String(err)}`);
  }
}

async function markAsRead(id: string, threadId: string | undefined, accountEmail: string, log: ChannelLogSink) {
  try {
    // Prefer thread-level modification as it's more robust in Gmail for label propagation
    if (threadId) {
        await runGog(["gmail", "thread", "modify", threadId, "--remove", "UNREAD"], accountEmail);
    } else {
        await runGog(["gmail", "labels", "modify", id, "--remove", "UNREAD"], accountEmail);
    }
  } catch (err) {
    log.error(`Failed to mark ${id} as read: ${String(err)}`);
  }
}

/**
 * Prune old Gmail sessions and their associated attachments.
 */
async function pruneGmailSessions(account: ResolvedGmailAccount, log: ChannelLogSink) {
  const ttlMs = account.sessionTtlDays * 24 * 60 * 60 * 1000;
  const stateDir = path.join(os.homedir(), ".clawdbot", "agents", "main", "sessions");
  const storePath = path.join(stateDir, "sessions.json");

  // Base directory for agent workspace (where attachments are stored)
  const agentDir = process.env.CLAWDBOT_AGENT_DIR || path.join(os.homedir(), "keith");
  const attachmentsDir = path.join(agentDir, ".attachments");

  try {
    // Check if store exists
    await fs.access(storePath);

    const release = await lockfile.lock(storePath, {
      stale: 10000,
      retries: {
        retries: 5,
        factor: 3,
        minTimeout: 1000,
        maxTimeout: 5000,
        randomize: true,
      },
    });

    try {
      const data = await fs.readFile(storePath, "utf-8");
      const store = JSON.parse(data);
      let changed = false;
      const now = Date.now();

      for (const key of Object.keys(store)) {
        if (key.startsWith(`gmail:${account.email}:`)) {
          const entry = store[key];
          if (entry.updatedAt && now - entry.updatedAt > ttlMs) {
            // Found an expired session
            const threadId = key.split(":").pop();
            
            // Delete associated attachments directory if it exists
            if (threadId) {
              const threadAttachmentsDir = path.join(attachmentsDir, threadId);
              try {
                await fs.rm(threadAttachmentsDir, { recursive: true, force: true });
                log.info(`Pruned attachments for expired Gmail session: ${threadId}`);
              } catch (err) {
                log.error(`Failed to prune attachments for ${threadId}: ${String(err)}`);
              }
            }

            delete store[key];
            changed = true;
            log.info(`Pruned expired Gmail session: ${key}`);
          }
        }
      }

      if (changed) {
        await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
      }
    } finally {
      await release();
    }
  } catch (err) {
    // Ignore errors (e.g. file not found)
    if ((err as any).code !== "ENOENT") {
      log.error(`Failed to prune Gmail sessions: ${String(err)}`);
    }
  }
}

async function fetchMessageDetails(
  id: string,
  account: ResolvedGmailAccount,
  log: ChannelLogSink,
  ignoreLabels = false
): Promise<InboundMessage | null> {
  try {
    const res = await runGog(["gmail", "get", id], account.email);
    if (!res) return null;

    const message = (res.message || res) as Record<string, unknown>;
    const labelIds = (message.labelIds || []) as string[];

    // Must be INBOX + UNREAD unless ignoring labels (e.g. from explicit search)
    if (!ignoreLabels && (!labelIds.includes("INBOX") || !labelIds.includes("UNREAD"))) {
      return null;
    }

    const payload: GogPayload = {
      ...message,
      account: account.email,
    } as GogPayload;

    return parseInboundGmail(payload, account.accountId);
  } catch (err) {
    log.error(`Failed to fetch message ${id}: ${String(err)}`);
    return null;
  }
}

async function downloadAttachmentsIfSmall(
  msg: InboundMessage, 
  account: ResolvedGmailAccount, 
  log: ChannelLogSink
): Promise<string[]> {
    if (!msg.raw || !msg.raw.payload) return [];
    
    const attachments = extractAttachments(msg.raw.payload);
    const downloaded: string[] = [];

    const agentDir = process.env.CLAWDBOT_AGENT_DIR || path.join(os.homedir(), "keith");
    const threadAttachmentsDir = path.join(agentDir, ".attachments", msg.threadId);

    for (const att of attachments) {
        if (att.size <= MAX_AUTO_DOWNLOAD_SIZE) {
            try {
                // Determine extension and safe filename
                const ext = path.extname(att.filename) || "";
                const safeName = path.basename(att.filename, ext).replace(/[^a-z0-9]/gi, '_') + ext;
                const outPath = path.join(threadAttachmentsDir, safeName);
                
                await fs.mkdir(threadAttachmentsDir, { recursive: true });
                
                // Use gog to download
                await execFileAsync("gog", [
                    "gmail", "attachment", 
                    msg.channelMessageId, 
                    att.attachmentId, 
                    "--account", account.email,
                    "--out", outPath
                ]);
                
                downloaded.push(outPath);
                log.info(`Auto-downloaded attachment ${att.filename} to ${outPath}`);
            } catch (err) {
                log.error(`Failed to auto-download attachment ${att.filename}: ${err}`);
            }
        }
    }
    return downloaded;
}

async function performFullSync(
  account: ResolvedGmailAccount,
  onMessage: (msg: InboundMessage) => Promise<void>,
  signal: AbortSignal,
  log: ChannelLogSink
): Promise<string | null> {
  // Use label:INBOX label:UNREAD for the most reliable bot inbox pattern
  // We explicitly ask for JSON output and include-body
  const searchResult = await runGog([
    "gmail", "messages", "search", 
    "label:INBOX label:UNREAD", 
    "--include-body", 
    "--max", "50"
  ], account.email);
  
  if (!searchResult || !Array.isArray((searchResult as any).messages)) {
    return null;
  }

  const rawMessages = (searchResult as any).messages as GogSearchMessage[];
  const inboundMessages: InboundMessage[] = [];

  for (const raw of rawMessages) {
    if (signal.aborted) break;
    
    // Parse the simplified search result
    const msg = parseSearchGmail(raw, account.accountId, account.email);
    
    if (msg) {
      if (!isAllowed(msg.sender.id, account.allowFrom || [])) {
        log.warn(`Quarantining email from non-whitelisted sender: ${msg.sender.id}`);
        await quarantineMessage(msg.channelMessageId, account.email, log);
        continue;
      }
      inboundMessages.push(msg);
    }
  }

  const threads = new Map<string, InboundMessage[]>();
  for (const msg of inboundMessages) {
    const list = threads.get(msg.threadId) || [];
    list.push(msg);
    threads.set(msg.threadId, list);
  }

     for (const [threadId, messages] of threads) {
        if (signal.aborted) break;
        
        // Filter out messages we've already dispatched in this session
        const newMessages = messages.filter(msg => !dispatchedMessageIds.has(msg.channelMessageId));
        if (newMessages.length === 0) continue;

        log.info(`[Sync] Processing thread ${threadId} with ${newMessages.length} new messages`);
        newMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        
        for (const msg of newMessages) {
            if (signal.aborted) break;

            // Add to local dedupe set to prevent race conditions during async processing
            dispatchedMessageIds.add(msg.channelMessageId);

            // To get attachments, we need the full message details (search --include-body only gives text)
            const fullMsg = await fetchMessageDetails(msg.channelMessageId, account, log, true);
            const msgToDispatch = fullMsg || msg;

            try {
                // Auto-download small attachments
                if (fullMsg) {
                    const downloadedPaths = await downloadAttachmentsIfSmall(fullMsg, account, log);
                    if (downloadedPaths.length > 0) {
                        msgToDispatch.text += "\n\n### Auto-downloaded Files\n" + 
                            downloadedPaths.map(p => `- \`${p}\``).join("\n");
                    }
                }

                await onMessage(msgToDispatch);
                
                // CRITICAL: Only mark as read after successful dispatch
                await markAsRead(msg.channelMessageId, msg.threadId, account.email, log);
            } catch (err) {
                log.error(`Failed to dispatch message ${msg.channelMessageId}, leaving as UNREAD: ${String(err)}`);
                // Remove from dedupe so it's retried next tick
                dispatchedMessageIds.delete(msg.channelMessageId);
            }
        }
     }

  // Get latest history ID to resume polling
  const latest = await runGog(["gmail", "search", "label:INBOX", "--max", "1"], account.email);
  if ((latest as any)?.threads?.[0]) {
     // We still need a separate fetch for historyId as search result (thread list) might not have it
     // But this is just 1 call.
     const thread = await runGog(["gmail", "get", (latest as any).threads[0].id], account.email);
     const nextId = (thread as any)?.message?.historyId || (thread as any)?.historyId || null;
     return nextId;
  }
  return null;
}

async function ensureQuarantineLabel(accountEmail: string, log: ChannelLogSink) {
  try {
    const res = await runGog(["gmail", "labels", "list"], accountEmail);
    // res.labels is likely the array from the JSON output
    const labels = (res as any)?.labels || [];
    const exists = labels.some((l: any) => l.name === QUARANTINE_LABEL);

    if (!exists) {
      log.info(`Creating quarantine label '${QUARANTINE_LABEL}'...`);
      await runGog(["gmail", "labels", "create", QUARANTINE_LABEL], accountEmail);
    }
  } catch (err) {
    // If this fails, quarantine attempts will also fail, but we don't block startup
    log.error(`Failed to ensure quarantine label exists: ${String(err)}`);
  }
}

export async function monitorGmail(params: {
  account: ResolvedGmailAccount;
  onMessage: (msg: InboundMessage) => Promise<void>;
  signal: AbortSignal;
  log: ChannelLogSink;
  setStatus: (status: any) => void;
}) {
  const { account, onMessage, signal, log, setStatus } = params;
  
  // Doctor check
  if (!(await checkGogExists())) {
    log.error("gog CLI not found in PATH. Gmail channel disabled.");
    setStatus({ accountId: account.accountId, running: false, connected: false, error: "gog CLI missing" });
    return;
  }

  log.info(`Starting monitor for ${account.email}`);

  // Ensure quarantine label exists
  await ensureQuarantineLabel(account.email, log);

  // Prune on start
  await pruneGmailSessions(account, log);
  let lastPruneAt = Date.now();

  let isSyncing = false;

  // Polling Loop
  while (!signal.aborted) {
    try {
      const interval = account.pollIntervalMs || POLL_INTERVAL_MS;
      await sleep(interval, signal);
      if (signal.aborted) break;

      if (isSyncing) {
        log.warn(`Sync already in progress for ${account.email}, skipping this tick`);
        continue;
      }

      // Periodically prune (once a day)
      if (Date.now() - lastPruneAt > 24 * 60 * 60 * 1000) {
        await pruneGmailSessions(account, log);
        lastPruneAt = Date.now();
      }

      // Use Search-based polling (simpler and more robust than history API for this use case)
      // We rely on the "UNREAD" label as our queue state.
      isSyncing = true;
      try {
        log.debug("Performing full search sync...");
        await performFullSync(account, onMessage, signal, log);
        setStatus({ accountId: account.accountId, running: true, connected: true, lastError: undefined });
      } finally {
        isSyncing = false;
      }

    } catch (err: unknown) {
      const msg = String(err);
      log.error(`Monitor loop error: ${msg}`);
      setStatus({ accountId: account.accountId, running: true, connected: false, lastError: msg });
    }
  }
}
