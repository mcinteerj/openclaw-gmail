/**
 * Sanitise raw HTML email bodies into clean plain text.
 *
 * Goals:
 *  - Strip all HTML to readable text (no tags, no CSS, no scripts)
 *  - Remove tracking pixels, base64 images, inline junk
 *  - Preserve meaningful link URLs
 *  - Strip common email footer noise (signatures, disclaimers, "Sent from…")
 *  - Collapse excessive whitespace
 */

// ── HTML entities ──────────────────────────────────────────────────────────
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201C",
  rdquo: "\u201D",
  bull: "\u2022",
  hellip: "\u2026",
  copy: "\u00A9",
  reg: "\u00AE",
  trade: "\u2122",
  "#39": "'",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&([a-zA-Z#0-9]+);/g, (match, name) => NAMED_ENTITIES[name] ?? match);
}

// ── HTML → plain text ──────────────────────────────────────────────────────

/**
 * Convert an HTML string to clean plain text.
 */
export function htmlToText(html: string): string {
  let s = html;

  // 1. Remove <style>, <script>, and <head> blocks entirely
  s = s.replace(/<style[\s>][\s\S]*?<\/style>/gi, "");
  s = s.replace(/<script[\s>][\s\S]*?<\/script>/gi, "");
  s = s.replace(/<head[\s>][\s\S]*?<\/head>/gi, "");

  // 2. Remove HTML comments
  s = s.replace(/<!--[\s\S]*?-->/g, "");

  // 3. Remove tracking pixels and junk images
  //    - 1×1 images (width/height = 1)
  //    - display:none images
  //    - base64 data URI images
  s = s.replace(/<img[^>]*(?:width\s*=\s*["']?1["']?\s|height\s*=\s*["']?1["']?\s)[^>]*\/?>/gi, "");
  s = s.replace(/<img[^>]*display\s*:\s*none[^>]*\/?>/gi, "");
  s = s.replace(/<img[^>]*src\s*=\s*["']data:[^"']*["'][^>]*\/?>/gi, "");

  // 4. Convert <br> variants to newlines
  s = s.replace(/<br\s*\/?>/gi, "\n");

  // 5. Block-level elements → newlines (before & after)
  const blockTags = "p|div|tr|li|h[1-6]|table|section|article|header|footer|blockquote|ul|ol|dd|dt|dl|pre|hr|figcaption";
  s = s.replace(new RegExp(`<\\/?(${blockTags})[^>]*>`, "gi"), "\n");

  // 6. Extract <a> links — keep URL when it differs from the link text
  s = s.replace(/<a\s[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_match, href: string, text: string) => {
      const linkText = text.replace(/<[^>]*>/g, "").trim();
      const cleanHref = href.trim();
      if (!linkText) return cleanHref ? `(${cleanHref})` : "";
      if (!cleanHref || cleanHref === "#" || cleanHref.startsWith("mailto:")) return linkText;
      // If the visible text IS the URL (or close), just show text
      if (linkText === cleanHref || linkText === cleanHref.replace(/^https?:\/\//, "")) {
        return linkText;
      }
      return `${linkText} (${cleanHref})`;
    },
  );

  // 7. Strip all remaining HTML tags
  s = s.replace(/<[^>]+>/g, "");

  // 8. Decode HTML entities
  s = decodeEntities(s);

  return s;
}

// ── Footer / junk removal ──────────────────────────────────────────────────

const FOOTER_PATTERNS: RegExp[] = [
  // "Sent from my …"
  /^sent from my (?:iphone|ipad|galaxy|samsung|android|pixel|outlook|thunderbird|mail for windows).*$/im,
  // "Get Outlook for …"
  /^get outlook for (?:ios|android|windows|mac).*$/im,
  // Unsubscribe lines
  /^.*\bunsubscribe\b.*$/im,
  // Confidentiality / disclaimer blocks (often multi-line, grab the whole paragraph)
  /(?:^|\n).*(?:confidential(?:ity)?|disclaimer|privileged|intended recipient|legally privileged).*(?:\n(?!\n).*){0,8}/im,
  // Signature separator: line starting with "-- " (RFC 3676) or just "--"
  /^--\s*$/m,
  // Copyright footers
  /^.*©\s*\d{4}.*$/im,
  /^.*(?:all rights reserved|privacy policy|terms of (?:service|use)).*$/im,
];

/**
 * Remove common email footer junk.  When a signature separator ("--") is
 * found, everything after it is dropped.  Individual junk lines are also
 * stripped even if no separator is present.
 */
export function stripFooterJunk(text: string): string {
  // If there's a signature separator, chop everything from it onwards
  const sigIdx = text.search(/^--\s*$/m);
  let s = sigIdx >= 0 ? text.slice(0, sigIdx) : text;

  // Remove individual footer lines
  for (const pat of FOOTER_PATTERNS) {
    s = s.replace(pat, "");
  }

  return s;
}

// ── Whitespace cleanup ─────────────────────────────────────────────────────

/**
 * Normalise whitespace:
 *  - Trim each line
 *  - Remove blank-only lines
 *  - Collapse 3+ consecutive newlines → 2
 *  - Trim leading/trailing whitespace on the whole string
 */
export function cleanWhitespace(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Full sanitisation pipeline: HTML → text → strip junk → clean whitespace.
 */
export function sanitizeEmailBody(html: string): string {
  const text = htmlToText(html);
  const noJunk = stripFooterJunk(text);
  return cleanWhitespace(noJunk);
}
