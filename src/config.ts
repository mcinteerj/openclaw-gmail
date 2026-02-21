import { z } from "zod";

export const GmailAccountSchema = z.object({
  accountId: z.string().optional(),
  name: z.string().optional(),
  enabled: z.boolean().default(true),
  email: z.string(), // The Gmail email address
  allowFrom: z.array(z.string()).default([]),
  // Gmail specific settings
  historyId: z.string().optional(), // For resuming history
  delegate: z.string().optional(), // If using delegation
  pollIntervalMs: z.number().optional(), // Polling interval in ms (default 60s)
  // Reply behavior
  includeQuotedReplies: z.boolean().optional(), // Include thread history in replies (default: true)
  // Outbound restrictions (security)
  allowOutboundTo: z.array(z.string()).optional(), // Who we can SEND to (if not set, falls back to allowFrom)
  threadReplyPolicy: z.enum(["open", "allowlist", "sender-only"]).optional(), // Default: "open" for backwards compat
  archiveOnReply: z.boolean().optional(), // Archive thread after reply (default: true)
});

export const GmailConfigSchema = z.object({
  enabled: z.boolean().default(true),
  blockStreaming: z.boolean().optional(), // Enable block streaming for email (default: false — emails send as one message)
  accounts: z.record(GmailAccountSchema).optional(),
  defaults: z.object({
    allowFrom: z.array(z.string()).optional(),
    includeQuotedReplies: z.boolean().default(true), // Global default for quoted replies
    allowOutboundTo: z.array(z.string()).optional(), // Global default for outbound allowlist
    threadReplyPolicy: z.enum(["open", "allowlist", "sender-only"]).optional(), // Global default
    archiveOnReply: z.boolean().optional(), // Global default for archive on reply (default: true)
  }).optional(),
});

export type GmailConfig = z.infer<typeof GmailConfigSchema>;
export type GmailAccount = z.infer<typeof GmailAccountSchema>;
