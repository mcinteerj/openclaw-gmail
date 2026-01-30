import { sanitizeEmailBody } from "./sanitize.js";

export function stripQuotes(html: string): string {
  // Remove Gmail quote div
  const gmailQuote = html.match(/<div class="gmail_quote"[^>]*>[\s\S]*?<\/div>/i);
  if (gmailQuote) {
    html = html.replace(gmailQuote[0], "");
  }
  
  // Remove blockquotes
  const blockquote = html.match(/<blockquote[^>]*>[\s\S]*?<\/blockquote>/gi);
  if (blockquote) {
    for (const bq of blockquote) {
      html = html.replace(bq, "");
    }
  }
  
  return html;
}

export function extractTextBody(html?: string, plain?: string, options?: { stripSignature?: boolean }): string {
  // Prefer HTML for stripping structure
  if (html) {
    const stripped = stripQuotes(html);
    return sanitizeEmailBody(stripped, { stripSignature: options?.stripSignature ?? true });
  }
  // Fallback to plain text with regex stripping
  if (plain) {
    // Basic stripping of "On ... wrote:" trailing block
    return plain.replace(/\nOn .+, .+ wrote:[\s\S]*$/, "").trim();
  }
  return "";
}
