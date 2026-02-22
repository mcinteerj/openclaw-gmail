import {
  type ChannelConfig,
  type ResolvedChannelAccount,
  DEFAULT_ACCOUNT_ID,
} from "openclaw/plugin-sdk";
import type { GmailConfig } from "./config.js";

export interface ResolvedGmailAccount extends ResolvedChannelAccount {
  email: string;
  historyId?: string;
  delegate?: string;
  pollIntervalMs?: number;
  backend?: "gog" | "api";
  oauth?: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  };
}

export function resolveGmailAccount(
  cfg: ChannelConfig<GmailConfig>,
  accountId?: string,
): ResolvedGmailAccount {
  const resolvedId = accountId || DEFAULT_ACCOUNT_ID;
  const account = cfg.channels?.['openclaw-gmail']?.accounts?.[resolvedId];

  if (!account) {
    // Graceful fallback for UI logic that queries 'default' on unconfigured channels
    return {
        accountId: resolvedId,
        name: resolvedId,
        enabled: false,
        email: "",
        historyId: undefined,
        delegate: undefined,
        allowFrom: [],
        pollIntervalMs: undefined,
    };
  }

  return {
    accountId: resolvedId,
    name: account.name || account.email,
    enabled: account.enabled,
    email: account.email,
    historyId: account.historyId,
    delegate: account.delegate,
    allowFrom: account.allowFrom,
    pollIntervalMs: account.pollIntervalMs,
    backend: account.backend,
    oauth: account.oauth,
  };
}

export function listGmailAccountIds(cfg: ChannelConfig<GmailConfig>): string[] {
  return Object.keys(cfg.channels?.['openclaw-gmail']?.accounts || {});
}

export function resolveDefaultGmailAccountId(cfg: ChannelConfig<GmailConfig>): string {
  const ids = listGmailAccountIds(cfg);
  if (ids.length === 0) return DEFAULT_ACCOUNT_ID;
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0]; // Fallback to first
}
