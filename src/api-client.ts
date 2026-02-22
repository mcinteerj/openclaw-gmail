import { gmail as gmailApi, type gmail_v1 } from "@googleapis/gmail";
import type { OAuth2Client } from "google-auth-library";
import fs from "node:fs/promises";
import type { GmailClient } from "./gmail-client.js";
import type { ThreadResponse, GogRawMessage } from "./quoting.js";
import type { GogSearchMessage } from "./inbound.js";

/**
 * Gmail API client using googleapis library directly.
 * Implements GmailClient interface for the "api" backend.
 *
 * Read operations are implemented here (gmail-2.3).
 * Send is deferred to gmail-2.4 (MIME construction).
 */
export class ApiGmailClient implements GmailClient {
  private gmail: gmail_v1.Gmail;

  constructor(auth: OAuth2Client) {
    this.gmail = gmailApi({ version: "v1", auth });
  }

  async send(_opts: {
    account?: string;
    to?: string;
    subject: string;
    textBody: string;
    htmlBody?: string;
    threadId?: string;
    replyToMessageId?: string;
    replyAll?: boolean;
  }): Promise<void> {
    throw new Error("ApiGmailClient.send() not yet implemented (see gmail-2.4)");
  }

  async getThread(threadId: string, opts?: { full?: boolean }): Promise<ThreadResponse | null> {
    try {
      const res = await this.gmail.users.threads.get({
        userId: "me",
        id: threadId,
        format: opts?.full ? "full" : "metadata",
      });

      const thread = res.data;
      if (!thread || !thread.messages) return null;

      return {
        id: thread.id!,
        historyId: thread.historyId!,
        messages: thread.messages.map((msg) => {
          const raw = mapApiMessage(msg);
          return parseRawToThreadMessage(raw);
        }),
      };
    } catch (err: any) {
      if (err?.code === 404) return null;
      throw err;
    }
  }

  async getMessage(messageId: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await this.gmail.users.messages.get({
        userId: "me",
        id: messageId,
        format: "full",
      });

      // Wrap in { message: ... } to match gog output shape consumed by monitor.ts
      return { message: mapApiMessage(res.data) };
    } catch (err: any) {
      if (err?.code === 404) return null;
      throw err;
    }
  }

  async searchMessages(
    query: string,
    opts?: { maxResults?: number; includeBody?: boolean },
  ): Promise<GogSearchMessage[]> {
    const res = await this.gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: opts?.maxResults ?? 50,
    });

    const ids = res.data.messages || [];
    if (ids.length === 0) return [];

    // Fetch full message details in parallel (N+1 pattern)
    const messages = await Promise.all(
      ids.map(async (m) => {
        try {
          const detail = await this.gmail.users.messages.get({
            userId: "me",
            id: m.id!,
            format: "full",
          });
          return detail.data;
        } catch {
          return null;
        }
      }),
    );

    return messages
      .filter((m): m is gmail_v1.Schema$Message => m !== null)
      .map((msg) => {
        const headers = msg.payload?.headers || [];
        const getH = (n: string) =>
          headers.find((h) => h.name?.toLowerCase() === n.toLowerCase())?.value || "";

        const body = extractPlainText(msg.payload ?? {});

        return {
          id: msg.id!,
          threadId: msg.threadId!,
          date: getH("Date"),
          from: getH("From"),
          subject: getH("Subject"),
          body,
          labels: msg.labelIds || [],
        };
      });
  }

  async searchThreads(
    query: string,
    opts?: { maxResults?: number },
  ): Promise<Record<string, unknown> | null> {
    const res = await this.gmail.users.threads.list({
      userId: "me",
      q: query,
      maxResults: opts?.maxResults ?? 50,
    });
    return res.data as Record<string, unknown>;
  }

  async modifyLabels(id: string, opts: { add?: string[]; remove?: string[] }): Promise<void> {
    await this.gmail.users.messages.modify({
      userId: "me",
      id,
      requestBody: {
        addLabelIds: opts.add,
        removeLabelIds: opts.remove,
      },
    });
  }

  async modifyThreadLabels(
    threadId: string,
    opts: { add?: string[]; remove?: string[] },
  ): Promise<void> {
    await this.gmail.users.threads.modify({
      userId: "me",
      id: threadId,
      requestBody: {
        addLabelIds: opts.add,
        removeLabelIds: opts.remove,
      },
    });
  }

  async listLabels(): Promise<{ id: string; name: string }[]> {
    const res = await this.gmail.users.labels.list({ userId: "me" });
    return (res.data.labels || []).map((l) => ({
      id: l.id!,
      name: l.name!,
    }));
  }

  async createLabel(name: string): Promise<void> {
    await this.gmail.users.labels.create({
      userId: "me",
      requestBody: { name },
    });
  }

  async downloadAttachment(
    messageId: string,
    attachmentId: string,
    outPath: string,
  ): Promise<void> {
    const res = await this.gmail.users.messages.attachments.get({
      userId: "me",
      messageId,
      id: attachmentId,
    });
    // Gmail API returns base64url-encoded data
    const buf = Buffer.from(res.data.data!, "base64url");
    await fs.writeFile(outPath, buf);
  }

  async getSendAs(): Promise<{ displayName?: string; email: string; isPrimary?: boolean }[]> {
    const res = await this.gmail.users.settings.sendAs.list({ userId: "me" });
    return (res.data.sendAs || []).map((s) => ({
      displayName: s.displayName || undefined,
      email: s.sendAsEmail!,
      isPrimary: s.isPrimary || false,
    }));
  }
}

// ── Response mapping helpers ──────────────────────────────────────────

/**
 * Map Gmail API Schema$Message to GogRawMessage shape.
 * This keeps all downstream consumers (quoting.ts, inbound.ts, monitor.ts) working
 * without changes.
 */
function mapApiMessage(msg: gmail_v1.Schema$Message): GogRawMessage {
  return {
    id: msg.id!,
    threadId: msg.threadId!,
    internalDate: msg.internalDate!,
    labelIds: msg.labelIds || [],
    payload: mapPayload(msg.payload ?? {}),
  };
}

function mapPayload(
  p: gmail_v1.Schema$MessagePart,
): GogRawMessage["payload"] {
  return {
    headers: (p.headers || []).map((h) => ({
      name: h.name!,
      value: h.value!,
    })),
    parts: p.parts?.map((part) => ({
      body: part.body?.data ? { data: part.body.data } : undefined,
      mimeType: part.mimeType!,
    })),
    body: p.body?.data ? { data: p.body.data } : undefined,
  };
}

/**
 * Parse a GogRawMessage into a ThreadMessage (same logic as quoting.ts:parseGogMessage).
 */
function parseRawToThreadMessage(raw: GogRawMessage) {
  const getH = (name: string) =>
    raw.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

  const body = extractPlainFromRaw(raw);
  const bodyHtml = extractHtmlFromRaw(raw);

  return {
    id: raw.id,
    threadId: raw.threadId,
    date: getH("Date") || new Date(parseInt(raw.internalDate)).toISOString(),
    from: getH("From") || "",
    to: getH("To"),
    cc: getH("Cc"),
    subject: getH("Subject") || "",
    body,
    bodyHtml,
    labels: raw.labelIds,
  };
}

function extractPlainFromRaw(raw: GogRawMessage): string {
  if (raw.payload.parts) {
    const plain = raw.payload.parts.find((p) => p.mimeType === "text/plain");
    if (plain?.body?.data) return Buffer.from(plain.body.data, "base64").toString("utf-8");
  }
  if (raw.payload.body?.data) return Buffer.from(raw.payload.body.data, "base64").toString("utf-8");
  return "";
}

function extractHtmlFromRaw(raw: GogRawMessage): string {
  if (raw.payload.parts) {
    const html = raw.payload.parts.find((p) => p.mimeType === "text/html");
    if (html?.body?.data) return Buffer.from(html.body.data, "base64").toString("utf-8");
  }
  if (raw.payload.body?.data) return Buffer.from(raw.payload.body.data, "base64").toString("utf-8");
  return "";
}

/**
 * Extract plain text body from a Gmail API MessagePart.
 */
function extractPlainText(part: gmail_v1.Schema$MessagePart): string {
  if (part.mimeType === "text/plain" && part.body?.data) {
    return Buffer.from(part.body.data, "base64").toString("utf-8");
  }
  if (part.parts) {
    // multipart/alternative: prefer text/plain
    if (part.mimeType === "multipart/alternative") {
      const plain = part.parts.find((p) => p.mimeType === "text/plain");
      if (plain) return extractPlainText(plain);
    }
    // Recurse into sub-parts
    for (const sub of part.parts) {
      const text = extractPlainText(sub);
      if (text) return text;
    }
  }
  return "";
}
