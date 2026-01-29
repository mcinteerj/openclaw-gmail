import {
  buildChannelConfigSchema,
  getChatChannelMeta,
  type ChannelPlugin,
  missingTargetError,
  setAccountEnabledInConfigSection,
  deleteAccountFromConfigSection,
  type InboundMessage,
  type ClawdbotConfig,
  type ChannelGatewayContext,
  type MsgContext,
} from "moltbot/plugin-sdk";
import { GmailConfigSchema } from "./config.js";
import {
  resolveGmailAccount,
  resolveDefaultGmailAccountId,
  listGmailAccountIds,
  type ResolvedGmailAccount,
} from "./accounts.js";
import { setGmailRuntime, getGmailRuntime } from "./runtime.js";
import { sendGmailText, type GmailOutboundContext } from "./outbound.js";
import { gmailThreading } from "./threading.js";
import { normalizeGmailTarget, isGmailThreadId, isAllowed } from "./normalize.js";
import { parseInboundGmail, type GogPayload } from "./inbound.js";
import { monitorGmail, quarantineMessage } from "./monitor.js";
import { extractAttachments } from "./attachments.js";
import { Semaphore } from "./semaphore.js";
import crypto from "node:crypto";

const meta = {
  id: "gmail",
  label: "Gmail",
  selectionLabel: "Gmail (gog)",
  detailLabel: "Gmail",
  docsPath: "/channels/gmail",
  docsLabel: "gmail",
  blurb: "Uses gog for secure Gmail access.",
  systemImage: "envelope",
  order: 100,
  showConfigured: true,
};

// Map to store active account contexts
const activeAccounts = new Map<string, ChannelGatewayContext<ResolvedGmailAccount>>();

// Limit concurrent dispatches to avoid memory spikes
const dispatchSemaphore = new Semaphore(5);

/**
 * Convert an InboundMessage to a finalized MsgContext for dispatch.
 * Gmail threads are equivalent to Slack channels - each thread gets its own session.
 */
function buildGmailMsgContext(
  msg: InboundMessage,
  account: ResolvedGmailAccount,
  cfg: ClawdbotConfig,
): MsgContext {
  const runtime = getGmailRuntime();
  const to = `gmail:${account.email}`;
  const threadLabel = `Gmail thread ${msg.threadId}`;

  const ctx = runtime.channel.reply.finalizeInboundContext({
    Body: msg.text,
    RawBody: msg.text,
    CommandBody: msg.text,
    From: msg.sender.id,
    To: to,
    SessionKey: `gmail:${account.email}:${msg.threadId}`,
    AccountId: msg.accountId,
    ChatType: "direct",
    ConversationLabel: threadLabel,
    SenderName: msg.sender.name,
    SenderId: msg.sender.id,
    Provider: "gmail" as const,
    Surface: "gmail" as const,
    MessageSid: msg.channelMessageId,
    ReplyToId: msg.channelMessageId,
    ThreadLabel: threadLabel,
    MessageThreadId: msg.threadId,
    ThreadStarterBody: undefined,
    Timestamp: msg.timestamp ? Math.round(msg.timestamp / 1_000) : undefined, // InboundMessage timestamp is ms, finalizeInboundContext expects seconds
    MediaPath: msg.mediaPath,
    MediaType: msg.mediaType,
    MediaUrl: msg.mediaUrl,
    CommandAuthorized: false,
    OriginatingChannel: "gmail" as const,
    OriginatingTo: to,
  });

  return ctx;
}

async function dispatchGmailMessage(
  ctx: ChannelGatewayContext<ResolvedGmailAccount>,
  msg: InboundMessage,
) {
  const { account, accountId, cfg, log } = ctx;
  const runtime = getGmailRuntime();
  const requestId = crypto.randomUUID().split("-")[0];

  await dispatchSemaphore.run(async () => {
    try {
      log?.info(`[gmail][${requestId}] Dispatching message ${msg.channelMessageId} from ${msg.sender.id}`);
      
      // Build the dispatch context
      const ctxPayload = buildGmailMsgContext(msg, account, cfg);

      // Build reply dispatcher options using gateway's reply capability
      const deliver = async (payload: { text: string }) => {
        const originalSubject = msg.raw?.subject ||
                               msg.raw?.headers?.subject || 
                               msg.raw?.payload?.headers?.find((h: any) => h.name.toLowerCase() === "subject")?.value;
        
        const replySubject = originalSubject 
          ? (originalSubject.toLowerCase().startsWith("re:") ? originalSubject : `Re: ${originalSubject}`)
          : "Re: ";

        await sendGmailText({
          to: msg.threadId || msg.sender.id,
          text: payload.text,
          accountId,
          cfg,
          threadId: msg.threadId,
          replyToId: msg.channelMessageId,
          subject: replySubject,
        });
      };

      const humanDelay = runtime.channel.reply.resolveHumanDelayConfig(cfg, accountId);

      // Dispatch to agent
      await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg,
        dispatcherOptions: {
          deliver,
          humanDelay,
          onError: (err: unknown, info: { kind: string }) => {
            log?.error(`[gmail][${requestId}] ${info.kind} reply failed: ${String(err)}`);
          },
        },
      });
      log?.info(`[gmail][${requestId}] Dispatch complete for ${msg.channelMessageId}`);
    } catch (e: unknown) {
      log?.error(`[gmail][${requestId}] Dispatch failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}

import { gmailOnboardingAdapter } from "./onboarding.js";

export const gmailPlugin: ChannelPlugin<ResolvedGmailAccount> = {
  id: "gmail",
  onboarding: gmailOnboardingAdapter,
  meta: {
    ...meta,
    showConfigured: true,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    threads: true,
  },
  configSchema: {
    schema: {
      type: "object",
      properties: {
        enabled: { type: "boolean", default: true },
        accounts: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              enabled: { type: "boolean", default: true },
              email: { type: "string" },
              name: { type: "string" },
              allowFrom: { type: "array", items: { type: "string" } },
              historyId: { type: "string" },
              delegate: { type: "string" },
            },
            required: ["email"],
          },
        },
        defaults: {
          type: "object",
          properties: {
            allowFrom: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  },
  config: {
    listAccountIds: (cfg) => listGmailAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveGmailAccount(cfg, accountId),
    defaultAccountId: (cfg) => resolveDefaultGmailAccountId(cfg),
    isEnabled: (account) => account.enabled,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name || account.email,
      enabled: account.enabled,
      configured: true,
      linked: true,
      allowFrom: account.allowFrom,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveGmailAccount(cfg, accountId ?? undefined).allowFrom ?? [],
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((e) => String(e).trim()).filter(Boolean),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "gmail",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "gmail",
        accountId,
      }),
  },
  outbound: {
    deliveryMode: "gateway",
    textChunkLimit: 8000,
    sendText: sendGmailText,
    resolveTarget: ({ to, allowFrom }) => {
      const trimmed = to?.trim() ?? "";
      const normalized = normalizeGmailTarget(trimmed);

      if (!normalized) {
        return {
          ok: false,
          error: missingTargetError("Gmail", "email address or thread ID"),
        };
      }

      // If it's a thread ID, we allow it implicitly (assuming we only have thread IDs
      // for threads we were allowed to ingest).
      if (isGmailThreadId(normalized)) {
        return { ok: true, to: normalized };
      }

      // Security: check allowFrom for new email addresses
      const allowed = (allowFrom || []).map((e) => String(e).trim());
      if (allowed.includes("*")) {
        return { ok: true, to: normalized };
      }
      
      if (allowed.length > 0) {
        const isAllowed = allowed.some(entry => {
          if (entry === normalized) return true;
          if (entry.startsWith("@") && normalized.endsWith(entry)) return true;
          return false;
        });
        
        if (!isAllowed) {
          return { ok: false, error: new Error(`Recipient ${normalized} not in allowList`) };
        }
      }

      return { ok: true, to: normalized };
    },
  },
  threading: gmailThreading,
  messaging: {
    normalizeTarget: normalizeGmailTarget,
    targetResolver: {
      looksLikeId: (id) => normalizeGmailTarget(id) !== null,
      hint: "email or threadId",
    },
  },
  agentPrompt: {
    messageToolHints: ({ cfg, accountId }: { cfg: ClawdbotConfig; accountId: string }) => {
      const account = resolveGmailAccount(cfg, accountId);
      return [
        "### Gmail Messaging",
        "- To reply to this email, just write your response normally as text in your turn. This will Reply All to everyone on the thread.",
        "- Your Markdown response is automatically converted to a rich HTML email using the `marked` library.",
        "- Headings, tables, and code blocks are fully supported.",
        `- Sending as: ${account.email || "the configured Gmail account"}.`,
        "### Attachments",
        "- **Location**: All attachments are stored in \`.attachments/{{threadId}}/\` relative to your workspace.",
        "- **Auto-Download**: Files under 5MB are already there. The message text contains their paths.",
        "- **Manual Download**: For larger files (listed with an ID), download them to that same folder:",
        `- Command: \`mkdir -p .attachments/{{threadId}} && gog gmail attachment <messageId> <attachmentId> --account ${account.email} --out .attachments/{{threadId}}/<filename>\``,
      ];
    },
  },
  actions: {
    listActions: () => ["send"],
    supportsAction: ({ action }: { action: string }) => action === "send",
    handleAction: async (ctx: any) => {
      if (ctx.action !== "send") return { ok: false, error: new Error(`Unsupported action: ${ctx.action}`) };
      
      const { params, accountId, cfg, toolContext } = ctx;
      const to = (params.target || params.to) as string;
      const text = params.message as string;
      
      const isThread = isGmailThreadId(to);
      let subject = params.subject as string | undefined;
      let replyToId: string | undefined;
      
      if (isThread && toolContext?.currentThreadTs) {
          replyToId = toolContext.currentThreadTs;
      }

      await sendGmailText({
        to,
        text,
        accountId,
        cfg,
        threadId: isThread ? to : undefined,
        replyToId,
        subject,
      });
      
      return { ok: true, content: [{ type: "text", text: "Message sent via Gmail." }] };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      ctx.log?.info(`[gmail] Account ${ctx.account.accountId} started`);

      if (ctx.account.email) {
        activeAccounts.set(ctx.account.email.toLowerCase(), ctx);
      }

      ctx.setStatus({ accountId: ctx.accountId, running: true, connected: true });

      // Create abort signal for stopping the monitor
      const abortController = new AbortController();

      // Start the Gmail polling monitor
      monitorGmail({
        account: ctx.account,
        onMessage: async (msg) => {
          await dispatchGmailMessage(ctx, msg);
        },
        signal: abortController.signal,
        log: ctx.log,
        setStatus: ctx.setStatus,
      }).catch((err) => {
        ctx.log?.error(`[gmail] Monitor error: ${String(err)}`);
      });

      return {
        stop: async () => {
          abortController.abort();
          if (ctx.account.email) {
            activeAccounts.delete(ctx.account.email.toLowerCase());
          }
          ctx.setStatus({ accountId: ctx.accountId, running: false, connected: false });
        },
      };
    },
  },
};
