export function wrapHtml(body: string): string {
  // Convert newlines to <br> for basic text-to-html
  const content = body.replace(/\n/g, "<br>");
  return `<html><body>${content}</body></html>`;
}
