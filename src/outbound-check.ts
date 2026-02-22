/**
 * Thread recipient validation for Gmail outbound.
 *
 * Validates that thread reply recipients are permitted by allowOutboundTo.
 */

import type { GmailClient } from "./gmail-client.js";

export interface ThreadParticipant {
  email: string;
  name?: string;
}

export interface ThreadData {
  participants: ThreadParticipant[];
  originalSender: string | null;
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
    // First pattern: quoted name with possible escaped quotes inside
    // Second pattern: unquoted name
    const match =
      trimmed.match(/^"((?:[^"\\]|\\.)*?)"\s*<([^>]+)>$/) ||
      trimmed.match(/^(?:([^"<]*)\s+)?<([^>]+)>$/);

    if (match) {
      const name = match[1]?.trim().replace(/\\"/g, '"');
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
 * Extract ThreadData (participants + original sender) from thread messages.
 * Replaces the old fetchThreadData() that spawned gog directly.
 */
function extractThreadData(
  messages: { from: string; to?: string; cc?: string }[],
  accountEmail: string,
): ThreadData {
  const participants = new Map<string, ThreadParticipant>();
  let originalSender: string | null = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const fields: string[] = [msg.from, msg.to, msg.cc].filter(Boolean) as string[];

    for (const field of fields) {
      const addresses = parseEmailAddresses(field);
      for (const addr of addresses) {
        if (addr.email.toLowerCase() !== accountEmail.toLowerCase()) {
          participants.set(addr.email.toLowerCase(), addr);
        }

        // Capture original sender from first message's From field
        if (i === 0 && field === msg.from && !originalSender) {
          originalSender = addr.email;
        }
      }
    }
  }

  return {
    participants: Array.from(participants.values()),
    originalSender,
  };
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
  policy: "open" | "allowlist" | "sender-only",
  client: GmailClient,
): Promise<ValidationResult> {
  if (policy === "open") {
    return { ok: true };
  }

  let threadData: ThreadData;
  try {
    const thread = await client.getThread(threadId);
    if (!thread) {
      return { ok: false, reason: "Could not fetch thread data" };
    }
    threadData = extractThreadData(thread.messages, accountEmail);
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
