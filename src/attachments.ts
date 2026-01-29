import type { GogMessagePart } from "./inbound.js";

export interface GmailAttachment {
  filename: string;
  mimeType: string;
  attachmentId: string;
  size: number;
}

export function extractAttachments(part: GogMessagePart): GmailAttachment[] {
  const attachments: GmailAttachment[] = [];

  if (part.filename && part.body?.attachmentId) {
    attachments.push({
      filename: part.filename,
      mimeType: part.mimeType,
      attachmentId: part.body.attachmentId,
      size: part.body.size,
    });
  }

  if (part.parts) {
    for (const subPart of part.parts) {
      attachments.push(...extractAttachments(subPart));
    }
  }

  return attachments;
}
