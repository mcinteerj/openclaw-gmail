import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import lockfile from "proper-lockfile";
import type { ChannelLogSink, InboundMessage } from "openclaw/plugin-sdk";
import type { ResolvedGmailAccount } from "./accounts.js";
import { parseInboundGmail, parseSearchGmail, type GogPayload, type GogSearchMessage } from "./inbound.js";
import { extractAttachments } from "./attachments.js";
import { isAllowed } from "./normalize.js";
import type { GmailClient } from "./gmail-client.js";
import { GogGmailClient } from "./gog-client.js";

// Polling interval: Default 60s, override via env for testing
const DEFAULT_POLL_INTERVAL = 60_000;
const POLL_INTERVAL_MS = process.env.GMAIL_POLL_INTERVAL_MS
  ? parseInt(process.env.GMAIL_POLL_INTERVAL_MS, 10)
  : DEFAULT_POLL_INTERVAL;
const MAX_AUTO_DOWNLOAD_SIZE = 5 * 1024 * 1024; // 5MB
const QUARANTINE_LABEL = "not-allow-listed";

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
        clearTimeout(timeout);
        resolve();
    }, { once: true });
});

// Local deduplication cache to prevent re-dispatching messages before Gmail updates labels
const dispatchedMessageIds = new Set<string>();
// Clear cache periodically to prevent memory growth (every hour)
setInterval(() => dispatchedMessageIds.clear(), 60 * 60 * 1000).unref();

export async function quarantineMessage(id: string, log: ChannelLogSink, client: GmailClient) {
  try {
    // Add 'not-allow-listed', remove 'INBOX', leave UNREAD
    await client.modifyLabels(id, { add: [QUARANTINE_LABEL], remove: ["INBOX"] });
    log.info(`Quarantined message ${id} from disallowed sender (moved to ${QUARANTINE_LABEL}, removed from INBOX)`);
  } catch (err) {
    log.error(`Failed to quarantine message ${id}: ${String(err)}`);
  }
}

async function markAsRead(id: string, threadId: string | undefined, log: ChannelLogSink, client: GmailClient) {
  try {
    // Prefer thread-level modification as it's more robust in Gmail for label propagation
    if (threadId) {
        await client.modifyThreadLabels(threadId, { remove: ["UNREAD"] });
    } else {
        await client.modifyLabels(id, { remove: ["UNREAD"] });
    }
  } catch (err) {
    log.error(`Failed to mark ${id} as read: ${String(err)}`);
  }
}

/**
 * Prune old Gmail sessions and their associated attachments.
 */
async function pruneGmailSessions(account: ResolvedGmailAccount, log: ChannelLogSink) {
  const ttlMs = account.sessionTtlDays * 24 * 60 * 60 * 1000;
  const stateDir = path.join(os.homedir(), ".clawdbot", "agents", "main", "sessions");
  const storePath = path.join(stateDir, "sessions.json");

  // Base directory for agent workspace (where attachments are stored)
  const agentDir = process.env.CLAWDBOT_AGENT_DIR || path.join(os.homedir(), "keith");
  const attachmentsDir = path.join(agentDir, ".attachments");

  try {
    // Check if store exists
    await fs.access(storePath);

    const release = await lockfile.lock(storePath, {
      stale: 10000,
      retries: {
        retries: 5,
        factor: 3,
        minTimeout: 1000,
        maxTimeout: 5000,
        randomize: true,
      },
    });

    try {
      const data = await fs.readFile(storePath, "utf-8");
      const store = JSON.parse(data);
      let changed = false;
      const now = Date.now();

      for (const key of Object.keys(store)) {
        if (key.startsWith(`gmail:${account.email}:`)) {
          const entry = store[key];
          if (entry.updatedAt && now - entry.updatedAt > ttlMs) {
            // Found an expired session
            const threadId = key.split(":").pop();

            // Delete associated attachments directory if it exists
            if (threadId) {
              const threadAttachmentsDir = path.join(attachmentsDir, threadId);
              try {
                await fs.rm(threadAttachmentsDir, { recursive: true, force: true });
                log.info(`Pruned attachments for expired Gmail session: ${threadId}`);
              } catch (err) {
                log.error(`Failed to prune attachments for ${threadId}: ${String(err)}`);
              }
            }

            delete store[key];
            changed = true;
            log.info(`Pruned expired Gmail session: ${key}`);
          }
        }
      }

      if (changed) {
        await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
      }
    } finally {
      await release();
    }
  } catch (err) {
    // Ignore errors (e.g. file not found)
    if ((err as any).code !== "ENOENT") {
      log.error(`Failed to prune Gmail sessions: ${String(err)}`);
    }
  }
}

async function fetchMessageDetails(
  id: string,
  account: ResolvedGmailAccount,
  log: ChannelLogSink,
  client: GmailClient,
  ignoreLabels = false
): Promise<InboundMessage | null> {
  try {
    const res = await client.getMessage(id);
    if (!res) return null;

    const message = (res.message || res) as Record<string, unknown>;
    const labelIds = (message.labelIds || []) as string[];

    // Must be INBOX + UNREAD unless ignoring labels (e.g. from explicit search)
    if (!ignoreLabels && (!labelIds.includes("INBOX") || !labelIds.includes("UNREAD"))) {
      return null;
    }

    const payload: GogPayload = {
      ...message,
      account: account.email,
    } as GogPayload;

    return parseInboundGmail(payload, account.accountId);
  } catch (err) {
    log.error(`Failed to fetch message ${id}: ${String(err)}`);
    return null;
  }
}

async function downloadAttachmentsIfSmall(
  msg: InboundMessage,
  account: ResolvedGmailAccount,
  log: ChannelLogSink,
  client: GmailClient,
): Promise<string[]> {
    if (!msg.raw || !msg.raw.payload) return [];

    const attachments = extractAttachments(msg.raw.payload);
    const downloaded: string[] = [];

    const agentDir = process.env.CLAWDBOT_AGENT_DIR || path.join(os.homedir(), "keith");
    const threadAttachmentsDir = path.join(agentDir, ".attachments", msg.threadId);

    for (const att of attachments) {
        if (att.size <= MAX_AUTO_DOWNLOAD_SIZE) {
            try {
                // Determine extension and safe filename
                const ext = path.extname(att.filename) || "";
                const safeName = path.basename(att.filename, ext).replace(/[^a-z0-9]/gi, '_') + ext;
                const outPath = path.join(threadAttachmentsDir, safeName);

                await fs.mkdir(threadAttachmentsDir, { recursive: true });

                await client.downloadAttachment(msg.channelMessageId, att.attachmentId, outPath);

                downloaded.push(outPath);
                log.info(`Auto-downloaded attachment ${att.filename} to ${outPath}`);
            } catch (err) {
                log.error(`Failed to auto-download attachment ${att.filename}: ${err}`);
            }
        }
    }
    return downloaded;
}

async function performFullSync(
  account: ResolvedGmailAccount,
  onMessage: (msg: InboundMessage) => Promise<void>,
  signal: AbortSignal,
  log: ChannelLogSink,
  client: GmailClient,
): Promise<string | null> {
  // Use label:INBOX label:UNREAD for the most reliable bot inbox pattern
  const rawMessages = await client.searchMessages("label:INBOX label:UNREAD", {
    maxResults: 50,
    includeBody: true,
  });

  if (rawMessages.length === 0) return null;

  const inboundMessages: InboundMessage[] = [];

  for (const raw of rawMessages) {
    if (signal.aborted) break;

    // Parse the simplified search result
    const msg = parseSearchGmail(raw, account.accountId, account.email);

    if (msg) {
      if (!isAllowed(msg.sender.id, account.allowFrom || [])) {
        log.warn(`Quarantining email from non-whitelisted sender: ${msg.sender.id}`);
        await quarantineMessage(msg.channelMessageId, log, client);
        continue;
      }
      inboundMessages.push(msg);
    }
  }

  const threads = new Map<string, InboundMessage[]>();
  for (const msg of inboundMessages) {
    const list = threads.get(msg.threadId) || [];
    list.push(msg);
    threads.set(msg.threadId, list);
  }

     for (const [threadId, messages] of threads) {
        if (signal.aborted) break;

        // Filter out messages we've already dispatched in this session
        const newMessages = messages.filter(msg => !dispatchedMessageIds.has(msg.channelMessageId));
        if (newMessages.length === 0) continue;

        log.info(`[Sync] Processing thread ${threadId} with ${newMessages.length} new messages`);
        newMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

        for (const msg of newMessages) {
            if (signal.aborted) break;

            // Add to local dedupe set to prevent race conditions during async processing
            dispatchedMessageIds.add(msg.channelMessageId);

            // To get attachments, we need the full message details (search --include-body only gives text)
            const fullMsg = await fetchMessageDetails(msg.channelMessageId, account, log, client, true);
            const msgToDispatch = fullMsg || msg;

            try {
                // Auto-download small attachments
                if (fullMsg) {
                    const downloadedPaths = await downloadAttachmentsIfSmall(fullMsg, account, log, client);
                    if (downloadedPaths.length > 0) {
                        msgToDispatch.text += "\n\n### Auto-downloaded Files\n" +
                            downloadedPaths.map(p => `- \`${p}\``).join("\n");
                    }
                }

                await onMessage(msgToDispatch);

                // CRITICAL: Only mark as read after successful dispatch
                await markAsRead(msg.channelMessageId, msg.threadId, log, client);
            } catch (err) {
                log.error(`Failed to dispatch message ${msg.channelMessageId}, leaving as UNREAD: ${String(err)}`);
                // Remove from dedupe so it's retried next tick
                dispatchedMessageIds.delete(msg.channelMessageId);
            }
        }
     }

  // Get latest history ID to resume polling
  const latest = await client.searchThreads("label:INBOX", { maxResults: 1 });
  if ((latest as any)?.threads?.[0]) {
     const thread = await client.getMessage((latest as any).threads[0].id);
     const nextId = (thread as any)?.message?.historyId || (thread as any)?.historyId || null;
     return nextId;
  }
  return null;
}

async function ensureQuarantineLabel(log: ChannelLogSink, client: GmailClient) {
  try {
    const labels = await client.listLabels();
    const exists = labels.some((l) => l.name === QUARANTINE_LABEL);

    if (!exists) {
      log.info(`Creating quarantine label '${QUARANTINE_LABEL}'...`);
      await client.createLabel(QUARANTINE_LABEL);
    }
  } catch (err) {
    // If this fails, quarantine attempts will also fail, but we don't block startup
    log.error(`Failed to ensure quarantine label exists: ${String(err)}`);
  }
}

export async function monitorGmail(params: {
  account: ResolvedGmailAccount;
  onMessage: (msg: InboundMessage) => Promise<void>;
  signal: AbortSignal;
  log: ChannelLogSink;
  setStatus: (status: any) => void;
  client: GmailClient;
}) {
  const { account, onMessage, signal, log, setStatus, client } = params;

  // Doctor check — only require gog CLI for the gog backend
  if (account.backend !== "api" && !(await GogGmailClient.checkExists())) {
    log.error("gog CLI not found in PATH. Gmail channel disabled.");
    setStatus({ accountId: account.accountId, running: false, connected: false, error: "gog CLI missing" });
    return;
  }

  log.info(`Starting monitor for ${account.email}`);

  // Ensure quarantine label exists
  await ensureQuarantineLabel(log, client);

  // Prune on start
  await pruneGmailSessions(account, log);
  let lastPruneAt = Date.now();

  let isSyncing = false;

  // Polling Loop
  while (!signal.aborted) {
    try {
      const interval = account.pollIntervalMs || POLL_INTERVAL_MS;
      await sleep(interval, signal);
      if (signal.aborted) break;

      if (isSyncing) {
        log.warn(`Sync already in progress for ${account.email}, skipping this tick`);
        continue;
      }

      // Periodically prune (once a day)
      if (Date.now() - lastPruneAt > 24 * 60 * 60 * 1000) {
        await pruneGmailSessions(account, log);
        lastPruneAt = Date.now();
      }

      // Use Search-based polling (simpler and more robust than history API for this use case)
      // We rely on the "UNREAD" label as our queue state.
      isSyncing = true;
      try {
        log.debug("Performing full search sync...");
        await performFullSync(account, onMessage, signal, log, client);
        setStatus({ accountId: account.accountId, running: true, connected: true, lastError: undefined });
      } finally {
        isSyncing = false;
      }

    } catch (err: unknown) {
      const msg = String(err);
      log.error(`Monitor loop error: ${msg}`);
      setStatus({ accountId: account.accountId, running: true, connected: false, lastError: msg });
    }
  }
}
