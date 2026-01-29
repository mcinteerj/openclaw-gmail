import { spawn } from "node:child_process";

export interface ThreadMessage {
  id: string;
  threadId: string;
  date: string;
  from: string;
  to?: string;
  cc?: string;
  subject: string;
  body: string;
  labels: string[];
}

export interface ThreadResponse {
  id: string;
  historyId: string;
  messages: ThreadMessage[];
}

// Raw gog output types
interface GogThreadOutput {
  downloaded: unknown;
  thread: {
    id: string;
    historyId: string;
    messages: GogRawMessage[];
  };
}

interface GogRawMessage {
  id: string;
  threadId: string;
  internalDate: string;
  labelIds: string[];
  payload: {
    headers: { name: string; value: string }[];
    parts?: { body?: { data?: string }; mimeType: string }[];
    body?: { data?: string };
  };
}

/**
 * Extract header value from gog message payload
 */
function getHeader(msg: GogRawMessage, name: string): string | undefined {
  return msg.payload.headers.find(
    (h) => h.name.toLowerCase() === name.toLowerCase()
  )?.value;
}

/**
 * Extract plain text body from gog message
 */
function extractBody(msg: GogRawMessage): string {
  // Try multipart first
  if (msg.payload.parts) {
    const plainPart = msg.payload.parts.find((p) => p.mimeType === "text/plain");
    if (plainPart?.body?.data) {
      return Buffer.from(plainPart.body.data, "base64").toString("utf-8");
    }
  }
  // Fallback to direct body
  if (msg.payload.body?.data) {
    return Buffer.from(msg.payload.body.data, "base64").toString("utf-8");
  }
  return "";
}

/**
 * Convert gog raw message to our ThreadMessage format
 */
function parseGogMessage(raw: GogRawMessage): ThreadMessage {
  const from = getHeader(raw, "From") || "";
  const date = getHeader(raw, "Date") || new Date(parseInt(raw.internalDate)).toISOString();
  const subject = getHeader(raw, "Subject") || "";
  const body = extractBody(raw);

  return {
    id: raw.id,
    threadId: raw.threadId,
    date,
    from,
    subject,
    body,
    labels: raw.labelIds || [],
  };
}

/**
 * Fetch thread data from gog CLI
 */
async function fetchThread(threadId: string, account?: string): Promise<ThreadResponse | null> {
  const args = ["gmail", "thread", "get", threadId, "--full", "--json"];
  if (account) {
    args.push("--account", account);
  }

  return new Promise((resolve) => {
    const proc = spawn("gog", args, { stdio: "pipe" });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("error", (e) => {
      console.error(`[gmail] Failed to spawn gog for thread fetch: ${e.message}`);
      resolve(null);
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        console.error(`[gmail] gog thread get failed (code ${code}): ${stderr}`);
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as GogThreadOutput;
        // gog wraps the thread in { downloaded, thread }
        const thread = parsed.thread;
        if (!thread || !thread.messages) {
          resolve(null);
          return;
        }
        resolve({
          id: thread.id,
          historyId: thread.historyId,
          messages: thread.messages.map(parseGogMessage),
        });
      } catch (e) {
        console.error(`[gmail] Failed to parse thread JSON: ${e}`);
        resolve(null);
      }
    });

    // Timeout after 15s
    setTimeout(() => {
      proc.kill();
      console.error(`[gmail] gog thread get timed out`);
      resolve(null);
    }, 15000);
  });
}

/**
 * Format a date string for the quote header
 */
function formatQuoteDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleString("en-US", {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return dateStr;
  }
}

/**
 * Extract display name or email from "Name <email>" format
 */
function extractSenderDisplay(from: string): string {
  const match = from.match(/^(.*?)\s*<(.*)>$/);
  if (match) {
    const name = match[1].replace(/^"|"$/g, "").trim();
    return name || match[2];
  }
  return from;
}

/**
 * Include message body as-is (flat, no ">" prefix to avoid staggered indentation)
 */
function quoteBody(body: string): string {
  return body;
}

/**
 * Build quoted context from the most recent non-self message.
 * Gmail standard: only quote the last message (which itself contains older quotes).
 * This avoids nested/staggered quoting.
 */
export function buildQuotedThread(
  messages: ThreadMessage[],
  accountEmail: string
): string {
  // Filter out messages from the account itself
  const otherMessages = messages.filter((msg) => {
    const emailMatch = msg.from.match(/<(.*)>/);
    const senderEmail = emailMatch ? emailMatch[1] : msg.from;
    return senderEmail.toLowerCase() !== accountEmail.toLowerCase();
  });

  if (otherMessages.length === 0) {
    return "";
  }

  // Only quote the most recent message from others (last in array = newest)
  const lastMsg = otherMessages[otherMessages.length - 1];
  const sender = extractSenderDisplay(lastMsg.from);
  const date = formatQuoteDate(lastMsg.date);
  const header = `On ${date}, ${sender} wrote:`;
  const quoted = quoteBody(lastMsg.body.trim());

  return `${header}\n\n${quoted}`;
}

/**
 * Fetch and format quoted context for a thread reply.
 * Returns the formatted quote block or empty string if unavailable.
 */
export async function fetchQuotedContext(
  threadId: string,
  accountEmail: string,
  accountArg?: string
): Promise<string> {
  const thread = await fetchThread(threadId, accountArg);
  if (!thread || !thread.messages || thread.messages.length === 0) {
    return "";
  }

  return buildQuotedThread(thread.messages, accountEmail);
}
