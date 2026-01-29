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

/**
 * Fetch all participants (To, CC, From) from a Gmail thread.
 */
export async function fetchThreadParticipants(
  threadId: string, 
  accountEmail: string
): Promise<ThreadParticipant[]> {
  return new Promise((resolve, reject) => {
    const args = ["gmail", "thread", "get", threadId, "--json", "--account", accountEmail];
    const proc = spawn("gog", args, { stdio: "pipe" });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Failed to fetch thread: ${stderr}`));
        return;
      }

      try {
        const data = JSON.parse(stdout);
        const messages = data.thread?.messages || [];
        const participants = new Map<string, ThreadParticipant>();

        for (const msg of messages) {
          const headers = msg.payload?.headers || [];
          
          for (const header of headers) {
            const name = header.name.toLowerCase();
            if (["from", "to", "cc"].includes(name)) {
              const addresses = parseEmailAddresses(header.value);
              for (const addr of addresses) {
                if (addr.email.toLowerCase() !== accountEmail.toLowerCase()) {
                  participants.set(addr.email.toLowerCase(), addr);
                }
              }
            }
          }
        }

        resolve(Array.from(participants.values()));
      } catch (e) {
        reject(new Error(`Failed to parse thread: ${e}`));
      }
    });

    setTimeout(() => {
      proc.kill();
      reject(new Error("Timeout fetching thread participants"));
    }, 10000);
  });
}

/**
 * Parse email addresses from a header value like "Name <email>, Other <email2>"
 */
function parseEmailAddresses(value: string): ThreadParticipant[] {
  const results: ThreadParticipant[] = [];
  
  // Split by comma, but be careful of commas in quoted names
  const parts = value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  
  for (const part of parts) {
    const trimmed = part.trim();
    const match = trimmed.match(/^(?:"?([^"<]*)"?\s*)?<([^>]+)>$/);
    
    if (match) {
      results.push({
        name: match[1]?.trim(),
        email: match[2].trim().toLowerCase(),
      });
    } else if (trimmed.includes("@")) {
      // Plain email address
      results.push({ email: trimmed.toLowerCase() });
    }
  }
  
  return results;
}

/**
 * Check if an email is allowed by the allowlist.
 */
export function isEmailAllowed(email: string, allowList: string[]): boolean {
  if (allowList.length === 0) return true; // Empty list = no restriction
  if (allowList.includes("*")) return true;

  const normalized = email.toLowerCase();
  
  return allowList.some((entry) => {
    const e = entry.toLowerCase().trim();
    if (!e) return false;
    if (normalized === e) return true;
    if (e.startsWith("@") && normalized.endsWith(e)) return true;
    return false;
  });
}

/**
 * Get the original sender of a thread (first message's From).
 */
export async function fetchThreadOriginalSender(
  threadId: string,
  accountEmail: string
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const args = ["gmail", "thread", "get", threadId, "--json", "--account", accountEmail];
    const proc = spawn("gog", args, { stdio: "pipe" });
    let stdout = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));

    proc.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }

      try {
        const data = JSON.parse(stdout);
        const messages = data.thread?.messages || [];
        if (messages.length === 0) {
          resolve(null);
          return;
        }

        // First message is the thread starter
        const firstMsg = messages[0];
        const headers = firstMsg.payload?.headers || [];
        const fromHeader = headers.find((h: any) => h.name.toLowerCase() === "from");
        
        if (fromHeader) {
          const addresses = parseEmailAddresses(fromHeader.value);
          if (addresses.length > 0) {
            resolve(addresses[0].email);
            return;
          }
        }
        
        resolve(null);
      } catch (e) {
        resolve(null);
      }
    });

    setTimeout(() => {
      proc.kill();
      resolve(null);
    }, 10000);
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

  if (policy === "sender-only") {
    const sender = await fetchThreadOriginalSender(threadId, accountEmail);
    if (!sender) {
      return { ok: false, reason: "Could not determine thread sender" };
    }
    
    if (!isEmailAllowed(sender, allowOutboundTo)) {
      return { ok: false, blocked: [sender], reason: "Thread sender not in allowOutboundTo" };
    }
    
    return { ok: true };
  }

  // policy === "allowlist"
  const participants = await fetchThreadParticipants(threadId, accountEmail);
  const blocked: string[] = [];

  for (const p of participants) {
    if (!isEmailAllowed(p.email, allowOutboundTo)) {
      blocked.push(p.email);
    }
  }

  if (blocked.length > 0) {
    return { ok: false, blocked, reason: "Recipients not in allowOutboundTo" };
  }

  return { ok: true };
}
