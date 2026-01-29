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

export function extractTextBody(html?: string, plain?: string): string {
  // Prefer HTML for stripping structure
  if (html) {
    return stripQuotes(html);
  }
  // Fallback to plain text with regex stripping
  if (plain) {
    // Basic stripping of "On ... wrote:" trailing block
    return plain.replace(/\nOn .+, .+ wrote:[\s\S]*$/, "").trim();
  }
  return "";
}
