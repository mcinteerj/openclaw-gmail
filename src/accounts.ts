import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/compat";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { ResolvedChannelAccount } from "./types.js";

export interface ResolvedGmailAccount extends ResolvedChannelAccount {
  email: string;
  historyId?: string;
  delegate?: string;
  pollIntervalMs?: number;
  includeThreadContext?: boolean;
  backend?: "gog" | "api";
  oauth?: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  };
}

/**
 * Normalize an account key the same way the gateway's routing layer does
 * (replace non-alphanumeric chars with hyphens). This allows matching
 * "honk-keithy-gmail-com" back to "honk.keithy@gmail.com".
 */
function canonicalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

export function resolveGmailAccount(
  cfg: OpenClawConfig,
  accountId?: string,
): ResolvedGmailAccount {
  const resolvedId = accountId || DEFAULT_ACCOUNT_ID;
  const accounts = cfg.channels?.['openclaw-gmail']?.accounts;
  let account = accounts?.[resolvedId];

  // If direct lookup fails, try matching against canonicalized account keys.
  // The gateway's routing layer normalizes email-format accountIds (e.g.
  // "honk.keithy@gmail.com" -> "honk-keithy-gmail-com"), so we need to
  // reverse-match by canonicalizing each config key the same way.
  if (!account && accounts && resolvedId !== DEFAULT_ACCOUNT_ID) {
    const canonicalizedId = canonicalizeKey(resolvedId);
    for (const key of Object.keys(accounts)) {
      if (canonicalizeKey(key) === canonicalizedId) {
        account = accounts[key];
        break;
      }
    }
  }

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

  const defaults = cfg.channels?.['openclaw-gmail']?.defaults;

  return {
    accountId: resolvedId,
    name: account.name || account.email,
    enabled: account.enabled,
    email: account.email,
    historyId: account.historyId,
    delegate: account.delegate,
    allowFrom: account.allowFrom,
    pollIntervalMs: account.pollIntervalMs,
    includeThreadContext: account.includeThreadContext ?? (defaults as any)?.includeThreadContext ?? false,
    backend: account.backend,
    oauth: account.oauth,
  };
}

export function listGmailAccountIds(cfg: OpenClawConfig): string[] {
  return Object.keys(cfg.channels?.['openclaw-gmail']?.accounts || {});
}

export function resolveDefaultGmailAccountId(cfg: OpenClawConfig): string {
  const ids = listGmailAccountIds(cfg);
  if (ids.length === 0) return DEFAULT_ACCOUNT_ID;
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0]; // Fallback to first
}
