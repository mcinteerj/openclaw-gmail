import type { ResolvedGmailAccount } from "./accounts.js";
import type { ThreadResponse } from "./quoting.js";
import type { GogSearchMessage } from "./inbound.js";
import { GogGmailClient } from "./gog-client.js";

export interface GmailClient {
  send(opts: {
    account?: string;
    to?: string;
    subject: string;
    textBody: string;
    htmlBody?: string;
    threadId?: string;
    replyToMessageId?: string;
    replyAll?: boolean;
  }): Promise<void>;

  getThread(threadId: string, opts?: { full?: boolean }): Promise<ThreadResponse | null>;
  getMessage(messageId: string): Promise<Record<string, unknown> | null>;
  searchMessages(query: string, opts?: { maxResults?: number; includeBody?: boolean }): Promise<GogSearchMessage[]>;
  searchThreads(query: string, opts?: { maxResults?: number }): Promise<Record<string, unknown> | null>;
  modifyLabels(id: string, opts: { add?: string[]; remove?: string[] }): Promise<void>;
  modifyThreadLabels(threadId: string, opts: { add?: string[]; remove?: string[] }): Promise<void>;
  listLabels(): Promise<{ id: string; name: string }[]>;
  createLabel(name: string): Promise<void>;
  downloadAttachment(messageId: string, attachmentId: string, outPath: string): Promise<void>;
  getSendAs(): Promise<{ displayName?: string; email: string; isPrimary?: boolean }[]>;
}

export function createGmailClient(account: ResolvedGmailAccount): GmailClient {
  return new GogGmailClient(account.email);
}
