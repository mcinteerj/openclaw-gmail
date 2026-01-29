import { type InboundMessage } from "moltbot/plugin-sdk";
import { extractTextBody } from "./strip-quotes.js";
import { extractAttachments } from "./attachments.js";

// Type for the payload from gog (simplified)
export interface GogPayload {
  account: string;
  id: string; // messageId
  threadId: string;
  historyId: string;
  labelIds: string[];
  snippet: string;
  payload: GogMessagePart;
  sizeEstimate: number;
  internalDate: string;
}

export interface GogMessagePart {
  partId: string;
  mimeType: string;
  filename: string;
  headers: { name: string; value: string }[];
  body?: { size: number; data?: string; attachmentId?: string };
  parts?: GogMessagePart[];
}

export function parseInboundGmail(payload: GogPayload, accountId?: string): InboundMessage | null {
  const headers = payload.payload.headers || [];
  const getHeader = (name: string) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value;
  
  const from = getHeader("From");
  if (!from) return null;
  
  // Normalize From: "Name <email>"
  const nameMatch = from.match(/^(.*) <(.*)>$/);
  const senderName = nameMatch ? nameMatch[1].replace(/^"|"$/g, "").trim() : undefined;
  const senderId = nameMatch ? nameMatch[2].trim() : from.trim();

  // Self-reply prevention - skip if sender is the account itself
  if (senderId.toLowerCase() === payload.account.toLowerCase()) {
    return null;
  }
  
  const subject = getHeader("Subject") || "(no subject)";
  
  // Extract both HTML and plain text parts
  const { html, plain } = extractBody(payload.payload);
  const cleanText = extractTextBody(html, plain);
  
  // Only fall back to snippet if we have no body content at all
  let finalText = cleanText;
  if (!html && !plain) {
    finalText = payload.snippet || "";
  }
  
  // Extract and append attachment metadata
  const attachments = extractAttachments(payload.payload);
  let attachmentContext = "";
  if (attachments.length > 0) {
    const seenNames = new Map<string, number>();
    attachmentContext = "\n\n### Attachments\n" + attachments.map(att => {
      let displayPath = att.filename;
      const count = seenNames.get(att.filename) || 0;
      if (count > 0) {
        // Handle duplicate filenames in the same message by appending short ID
        const ext = att.filename.includes(".") ? att.filename.split(".").pop() : "";
        const base = att.filename.includes(".") ? att.filename.split(".").slice(0, -1).join(".") : att.filename;
        displayPath = `${base}_${att.attachmentId.substring(0, 6)}${ext ? "." + ext : ""}`;
      }
      seenNames.set(att.filename, count + 1);

      return `- **${displayPath}** (Type: ${att.mimeType}, Size: ${formatBytes(att.size)}, ID: \`${att.attachmentId}\`)`;
    }).join("\n");
  }
  
  const fullText = `[Thread Context: ID=${payload.threadId}, Subject="${subject}"]\n\n${finalText}${attachmentContext}`;

  return {
    channelId: "gmail",
    accountId,
    channelMessageId: payload.id,
    threadId: payload.threadId,
    text: fullText,
    sender: {
      id: senderId,
      name: senderName,
      isBot: false,
    },
    raw: payload,
    isGroup: false, // Treat as direct by default for session consistency
    replyTo: {
      channelMessageId: payload.id,
    },
  };
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

export interface GogSearchMessage {
  id: string;
  threadId: string;
  date: string;
  from: string;
  subject: string;
  body: string;
  labels: string[];
}

export function parseSearchGmail(msg: GogSearchMessage, accountId?: string, accountEmail?: string): InboundMessage | null {
  const from = msg.from;
  if (!from) return null;

  // Normalize From: "Name <email>"
  const nameMatch = from.match(/^(.*) <(.*)>$/);
  const senderName = nameMatch ? nameMatch[1].replace(/^"|"$/g, "").trim() : undefined;
  const senderId = nameMatch ? nameMatch[2].trim() : from.trim();

  // Self-reply prevention
  if (accountEmail && senderId.toLowerCase() === accountEmail.toLowerCase()) {
    return null;
  }

  const subject = msg.subject || "(no subject)";
  
  // The body from search --include-body is plain text (decoded)
  // We still want to try stripping quotes if possible
  const cleanText = extractTextBody(undefined, msg.body);
  const finalText = cleanText || msg.body || "";

  // For Search messages, gog doesn't give us the part structure needed for attachment ID extraction
  // in the same sync tick. If user sees an empty body, they'll know something is there from the snippet.
  const fullText = `[Thread Context: ID=${msg.threadId}, Subject="${subject}"]\n\n${finalText}`;

  return {
    channelId: "gmail",
    accountId,
    channelMessageId: msg.id,
    threadId: msg.threadId,
    text: fullText,
    sender: {
      id: senderId,
      name: senderName,
      isBot: false,
    },
    raw: msg,
    isGroup: false,
    replyTo: {
      channelMessageId: msg.id,
    },
    timestamp: Date.parse(msg.date),
  };
}

function extractBody(part: GogMessagePart): { html?: string; plain?: string } {
  let html: string | undefined;
  let plain: string | undefined;

  if (part.mimeType === "text/html" && part.body?.data) {
    html = Buffer.from(part.body.data, "base64").toString("utf-8");
  } else if (part.mimeType === "text/plain" && part.body?.data) {
    plain = Buffer.from(part.body.data, "base64").toString("utf-8");
  } else if (part.parts) {
    if (part.mimeType === "multipart/alternative") {
      const htmlPart = part.parts.find(p => p.mimeType === "text/html");
      const plainPart = part.parts.find(p => p.mimeType === "text/plain");
      if (htmlPart) html = extractBody(htmlPart).html;
      if (plainPart) plain = extractBody(plainPart).plain;
    } else {
      const parts = part.parts.map(p => extractBody(p));
      const htmlParts = parts.map(p => p.html).filter(Boolean);
      const plainParts = parts.map(p => p.plain).filter(Boolean);
      if (htmlParts.length > 0) html = htmlParts.join("\n");
      if (plainParts.length > 0) plain = plainParts.join("\n");
    }
  }
  return { html, plain };
}
