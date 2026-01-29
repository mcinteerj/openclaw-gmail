/**
 * Thread recipient validation for Gmail outbound.
 * 
 * Validates that thread reply recipients are permitted by allowOutboundTo.
 */

import { spawn } from "node:child_process";

export interface ThreadParticipant {
  email: string;
  name?: string;
}

export interface ThreadData {
  participants: ThreadParticipant[];
  originalSender: string | null;
}

/**
 * Fetch thread data (participants and original sender) in a single call.
 */
export async function fetchThreadData(
  threadId: string, 
  accountEmail: string
): Promise<ThreadData> {
  return new Promise((resolve, reject) => {
    const args = ["gmail", "thread", "get", threadId, "--json", "--account", accountEmail];
    const proc = spawn("gog", args, { stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        reject(new Error("Timeout fetching thread data"));
      }
    }, 10000);

    const cleanup = () => {
      clearTimeout(timeout);
    };

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();

      if (code !== 0) {
        reject(new Error(`Failed to fetch thread: ${stderr}`));
        return;
      }

      try {
        const data = JSON.parse(stdout);
        const messages = data.thread?.messages || [];
        const participants = new Map<string, ThreadParticipant>();
        let originalSender: string | null = null;

        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];
          const headers = msg.payload?.headers || [];
          
          for (const header of headers) {
            const name = header.name.toLowerCase();
            if (["from", "to", "cc"].includes(name)) {
              const addresses = parseEmailAddresses(header.value);
              for (const addr of addresses) {
                if (addr.email.toLowerCase() !== accountEmail.toLowerCase()) {
                  participants.set(addr.email.toLowerCase(), addr);
                }
                
                // Capture original sender from first message's From header
                if (i === 0 && name === "from" && !originalSender) {
                  originalSender = addr.email;
                }
              }
            }
          }
        }

        resolve({
          participants: Array.from(participants.values()),
          originalSender,
        });
      } catch (e) {
        reject(new Error(`Failed to parse thread: ${e}`));
      }
    });

    proc.on("error", (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Failed to spawn gog: ${e.message}`));
    });
  });
}

/**
 * Parse email addresses from a header value like "Name <email>, Other <email2>"
 * 
 * Handles:
 * - Simple: email@example.com
 * - Named: Name <email@example.com>
 * - Quoted names with commas: "Last, First" <email@example.com>
 * - Multiple addresses separated by commas
 */
export function parseEmailAddresses(value: string): ThreadParticipant[] {
  const results: ThreadParticipant[] = [];
  if (!value || typeof value !== "string") return results;
  
  // Split by comma, but respect quoted strings
  // This regex splits on commas that are NOT inside quotes
  const parts = value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    
    // Try to match "Name" <email> or Name <email>
    const match = trimmed.match(/^(?:"?([^"<]*)"?\s*)?<([^>]+)>$/);
    
    if (match) {
      const name = match[1]?.trim().replace(/^"|"$/g, "");
      const email = match[2].trim().toLowerCase();
      if (email.includes("@")) {
        results.push({ name: name || undefined, email });
      }
    } else if (trimmed.includes("@")) {
      // Plain email address
      results.push({ email: trimmed.toLowerCase() });
    }
  }
  
  return results;
}

/**
 * Check if an email is allowed by the allowlist.
 * 
 * Rules:
 * - Empty list = no restriction (returns true)
 * - "*" in list = allow all
 * - Exact match (case-insensitive)
 * - Domain wildcard: "@company.com" matches any @company.com address
 */
export function isEmailAllowed(email: string, allowList: string[]): boolean {
  // Empty list = no restriction
  if (allowList.length === 0) return true;
  if (allowList.includes("*")) return true;
  
  if (!email) return false;
  const normalized = email.toLowerCase();
  
  return allowList.some((entry) => {
    const e = entry.toLowerCase().trim();
    if (!e) return false;
    if (normalized === e) return true;
    // Domain wildcard: must start with @ and email must end with it
    if (e.startsWith("@") && normalized.endsWith(e)) return true;
    return false;
  });
}

export interface ValidationResult {
  ok: boolean;
  blocked?: string[];
  reason?: string;
}

/**
 * Validate thread recipients against policy.
 * 
 * Policies:
 * - "open": Allow replies to anyone (default, backwards compatible)
 * - "allowlist": All recipients must be in allowOutboundTo
 * - "sender-only": Only reply if original sender is allowed (ignore CC'd parties)
 */
export async function validateThreadReply(
  threadId: string,
  accountEmail: string,
  allowOutboundTo: string[],
  policy: "open" | "allowlist" | "sender-only"
): Promise<ValidationResult> {
  if (policy === "open") {
    return { ok: true };
  }

  let threadData: ThreadData;
  try {
    threadData = await fetchThreadData(threadId, accountEmail);
  } catch (err) {
    console.error(`[gmail] Failed to fetch thread data for validation: ${err}`);
    return { ok: false, reason: `Could not fetch thread data: ${err}` };
  }

  if (policy === "sender-only") {
    if (!threadData.originalSender) {
      console.error(`[gmail] Could not determine original sender for thread ${threadId}`);
      return { ok: false, reason: "Could not determine thread sender" };
    }
    
    if (!isEmailAllowed(threadData.originalSender, allowOutboundTo)) {
      return { 
        ok: false, 
        blocked: [threadData.originalSender], 
        reason: "Thread sender not in allowOutboundTo" 
      };
    }
    
    return { ok: true };
  }

  // policy === "allowlist"
  const blocked: string[] = [];

  for (const p of threadData.participants) {
    if (!isEmailAllowed(p.email, allowOutboundTo)) {
      blocked.push(p.email);
    }
  }

  if (blocked.length > 0) {
    return { ok: false, blocked, reason: "Recipients not in allowOutboundTo" };
  }

  return { ok: true };
}
