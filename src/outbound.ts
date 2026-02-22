import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { type OutboundContext, type OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveGmailAccount } from "./accounts.js";
import { isGmailThreadId } from "./normalize.js";
import { fetchQuotedContext, type QuotedContent } from "./quoting.js";
import { validateThreadReply, isEmailAllowed } from "./outbound-check.js";
import type { GmailConfig } from "./config.js";
import type { GmailClient } from "./gmail-client.js";

export interface GmailOutboundContext extends OutboundContext {
  subject?: string;
  threadId?: string;
  replyToId?: string;
  client: GmailClient;
}

export async function sendGmailText(ctx: GmailOutboundContext) {
  const { to, text, accountId, cfg, threadId, replyToId, subject: explicitSubject, client } = ctx;
  const account = resolveGmailAccount(cfg, accountId);
  const gmailCfg = cfg.channels?.gmail as GmailConfig | undefined;

  // Validate we have a target - prioritize threadId if it's valid
  const effectiveThreadId = isGmailThreadId(String(threadId)) ? String(threadId) : undefined;
  const toValue = effectiveThreadId || to || "";

  if (!toValue) {
    throw new Error("Gmail send requires a valid 'to' address or thread ID");
  }

  // Determine if quoted replies are enabled (default: true)
  const accountCfg = gmailCfg?.accounts?.[accountId || "default"];
  const includeQuotedReplies = accountCfg?.includeQuotedReplies
    ?? gmailCfg?.defaults?.includeQuotedReplies
    ?? true;

  // Determine outbound restrictions
  const allowOutboundTo = accountCfg?.allowOutboundTo
    ?? gmailCfg?.defaults?.allowOutboundTo
    ?? account.allowFrom
    ?? [];
  const threadReplyPolicy = accountCfg?.threadReplyPolicy
    ?? gmailCfg?.defaults?.threadReplyPolicy
    ?? "open"; // Default: open for backwards compatibility

  const subject = explicitSubject || "(no subject)";
  const isThread = isGmailThreadId(toValue);
  let quotedContent: QuotedContent | null = null;

  // Validate outbound recipients
  if (isThread && threadReplyPolicy !== "open" && account.email) {
    const validation = await validateThreadReply(
      toValue,
      account.email,
      allowOutboundTo,
      threadReplyPolicy,
      client,
    );

    if (!validation.ok) {
      const blockedList = validation.blocked?.join(", ") || "unknown";
      throw new Error(
        `Thread reply blocked by policy (${threadReplyPolicy}): ${validation.reason}. ` +
        `Blocked recipients: ${blockedList}. ` +
        `Add them to allowOutboundTo or change threadReplyPolicy to "open".`
      );
    }
  } else if (!isThread && allowOutboundTo.length > 0) {
    // Direct email: check allowOutboundTo
    if (!isEmailAllowed(toValue, allowOutboundTo)) {
      throw new Error(
        `Direct email to ${toValue} blocked: not in allowOutboundTo list.`
      );
    }
  }

  // Fetch quoted thread context if enabled
  if (isThread && includeQuotedReplies && account.email) {
    try {
      quotedContent = await fetchQuotedContext(
        toValue,
        account.email,
        client,
      );
    } catch (err) {
      // Non-fatal: proceed without quoted context
      console.error(`[gmail] Failed to fetch quoted context: ${err}`);
    }
  }

  // Convert reply text to HTML (quotes are handled separately to avoid markdown mangling)
  let fullHtml: string | undefined;
  let plainBody = text;

  try {
    const rawHtml = await marked.parse(text);
    const replyHtml = sanitizeHtml(rawHtml, {
      allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img']),
      allowedAttributes: {
        ...sanitizeHtml.defaults.allowedAttributes,
        '*': ['style', 'class']
      }
    });

    // Build Gmail-style blockquote HTML for the quoted content
    fullHtml = replyHtml;
    if (quotedContent) {
      fullHtml += `<div class="gmail_quote">` +
        `<div dir="ltr" class="gmail_attr">${sanitizeHtml(quotedContent.header, { allowedTags: [], allowedAttributes: {} })}</div>` +
        `<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">` +
        `${quotedContent.bodyHtml}` +
        `</blockquote></div>`;
      plainBody = `${text}\n\n${quotedContent.header}\n\n${quotedContent.bodyPlain}`;
    }
  } catch (err) {
    console.error("Markdown parsing or sanitization failed, sending plain text", err);
    if (quotedContent) {
      plainBody = `${text}\n\n${quotedContent.header}\n\n${quotedContent.bodyPlain}`;
    }
  }

  await client.send({
    account: account.email,
    to: isThread ? undefined : toValue,
    subject,
    textBody: plainBody,
    htmlBody: fullHtml,
    threadId: isThread ? toValue : undefined,
    replyToMessageId: replyToId ? String(replyToId) : undefined,
    replyAll: isThread,
  });

  // Archive if it was a thread (Reply = Archive), unless disabled by config
  const archiveOnReply = accountCfg?.archiveOnReply
    ?? gmailCfg?.defaults?.archiveOnReply
    ?? true;
  if (isThread && archiveOnReply) {
    // Best effort archive
    client.modifyLabels(toValue, { remove: ["INBOX"] }).catch((err) => {
      console.error(`Failed to archive thread ${toValue}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  return { id: "sent" };
}
