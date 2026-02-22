import MailComposer from "nodemailer/lib/mail-composer";

export interface MimeMessageOpts {
  from: string;
  to: string;
  cc?: string;
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
}

/**
 * Build an RFC 2822 MIME message using nodemailer's MailComposer.
 * Returns a Buffer suitable for base64url encoding and passing to
 * gmail.users.messages.send.
 */
export function buildMimeMessage(opts: MimeMessageOpts): Promise<Buffer> {
  const mail = new MailComposer({
    from: opts.from,
    to: opts.to,
    cc: opts.cc,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
    inReplyTo: opts.inReplyTo,
    references: opts.references,
  });

  return new Promise((resolve, reject) => {
    mail.compile().build((err: Error | null, message: Buffer) => {
      if (err) reject(err);
      else resolve(message);
    });
  });
}
