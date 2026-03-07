/**
 * Local type definitions for types used across the Gmail plugin.
 *
 * These were previously imported from "openclaw/plugin-sdk" but never
 * actually existed in the SDK (they resolved to `any` through the
 * Jiti type-stripping runtime). Now defined locally for correctness.
 */

/**
 * Inbound message from a channel, dispatched to the agent for processing.
 * Modeled after the shape used by OpenClaw's internal dispatch pipeline.
 */
export interface InboundMessage {
  channelId: string;
  accountId?: string;
  channelMessageId: string;
  threadId: string;
  text: string;
  sender: {
    id: string;
    name?: string;
    isBot: boolean;
  };
  raw?: any;
  isGroup: boolean;
  replyTo?: {
    channelMessageId: string;
  };
  timestamp?: number;
  mediaPath?: string;
  mediaType?: string;
  mediaUrl?: string;
}

/**
 * Base shape for a resolved channel account.
 * Extended by ResolvedGmailAccount with Gmail-specific fields.
 */
export interface ResolvedChannelAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  allowFrom?: string[];
}
