import { spawn } from "node:child_process";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { type OutboundContext, type OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveGmailAccount } from "./accounts.js";
import { isGmailThreadId } from "./normalize.js";
import { fetchQuotedContext, type QuotedContent } from "./quoting.js";
import { validateThreadReply, isEmailAllowed } from "./outbound-check.js";
import type { GmailConfig } from "./config.js";

export interface GmailOutboundContext extends OutboundContext {
  subject?: string;
  threadId?: string;
  replyToId?: string;
}

async function spawnGog(args: string[], retries = 3): Promise<void> {
    for (let i = 0; i < retries; i++) {
        try {
            await new Promise<void>((resolve, reject) => {
                const proc = spawn("gog", args, { stdio: "pipe" });
                let err = "";
                let out = "";
                proc.stderr.on("data", (d) => err += d.toString());
                proc.stdout.on("data", (d) => out += d.toString());
                proc.on("error", (e) => reject(new Error(`gog failed to spawn: ${e.message}`)));
                proc.on("close", (code) => {
                    if (code === 0) resolve();
                    else reject(new Error(`gog failed (code ${code}): ${err || out}`));
                });

                // Add a timeout
                setTimeout(() => {
                    proc.kill();
                    reject(new Error("gog timed out after 30s"));
                }, 30000);
            });
            return;
        } catch (err) {
            if (i === retries - 1) throw err;
            await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        }
    }
}

export async function sendGmailText(ctx: GmailOutboundContext) {
  const { to, text, accountId, cfg, threadId, replyToId, subject: explicitSubject } = ctx;
  const account = resolveGmailAccount(cfg, accountId);
  const gmailCfg = cfg.channels?.gmail as GmailConfig | undefined;
  
  // Validate we have a target - prioritize threadId if it's valid
  const effectiveThreadId = isGmailThreadId(String(threadId)) ? String(threadId) : undefined;
  const toValue = effectiveThreadId || to || "";
  
  if (!toValue) {
    throw new Error("Gmail send requires a valid 'to' address or thread ID");
  }

  const args = ["gmail", "send"];
  
  if (account.email) {
      args.push("--account", account.email);
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
      threadReplyPolicy
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

  if (!isThread) {
      args.push("--to", toValue);
      args.push("--subject", subject);
  } else {
      // Reply to thread
      if (replyToId) {
          args.push("--reply-to-message-id", String(replyToId));
      } else {
          args.push("--thread-id", toValue);
      }
      
      args.push("--subject", subject);
      args.push("--reply-all");

      // Fetch quoted thread context if enabled
      if (includeQuotedReplies && account.email) {
        try {
          quotedContent = await fetchQuotedContext(
            toValue,
            account.email,
            account.email
          );
        } catch (err) {
          // Non-fatal: proceed without quoted context
          console.error(`[gmail] Failed to fetch quoted context: ${err}`);
        }
      }
  }

  // Convert reply text to HTML (quotes are handled separately to avoid markdown mangling)
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
      let fullHtml = replyHtml;
      let plainBody = text;
      if (quotedContent) {
        fullHtml += `<div class="gmail_quote">` +
          `<div dir="ltr" class="gmail_attr">${sanitizeHtml(quotedContent.header, { allowedTags: [], allowedAttributes: {} })}</div>` +
          `<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">` +
          `${quotedContent.bodyHtml}` +
          `</blockquote></div>`;
        plainBody = `${text}\n\n${quotedContent.header}\n\n${quotedContent.bodyPlain}`;
      }

      args.push("--body-html", fullHtml);
      args.push("--body", plainBody);
  } catch (err) {
      console.error("Markdown parsing or sanitization failed, sending plain text", err);
      let plainBody = text;
      if (quotedContent) {
        plainBody = `${text}\n\n${quotedContent.header}\n\n${quotedContent.bodyPlain}`;
      }
      args.push("--body", plainBody);
  }

  await spawnGog(args);

  // Archive if it was a thread (Reply = Archive), unless disabled by config
  const archiveOnReply = accountCfg?.archiveOnReply
    ?? gmailCfg?.defaults?.archiveOnReply
    ?? true;
  if (isThread && archiveOnReply) {
    const archiveArgs = ["gmail", "labels", "modify", toValue];
    if (account.email) archiveArgs.push("--account", account.email);
    archiveArgs.push("--remove", "INBOX");
    
    // Best effort archive
    spawnGog(archiveArgs).catch((err) => {
        console.error(`Failed to archive thread ${toValue}: ${err.message}`);
    });
  }

  return { id: "sent" };
}
