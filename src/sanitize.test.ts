import { describe, it, expect } from "vitest";
import {
  htmlToText,
  stripFooterJunk,
  cleanWhitespace,
  sanitizeEmailBody,
} from "./sanitize.js";

// ── htmlToText ─────────────────────────────────────────────────────────────

describe("htmlToText", () => {
  it("strips <style> blocks", () => {
    const html = `<style>.foo{color:red}</style><p>Hello</p>`;
    expect(htmlToText(html)).toContain("Hello");
    expect(htmlToText(html)).not.toContain("color");
  });

  it("strips <script> blocks", () => {
    const html = `<script>alert("x")</script><p>Hello</p>`;
    expect(htmlToText(html)).toContain("Hello");
    expect(htmlToText(html)).not.toContain("alert");
  });

  it("strips <head> blocks", () => {
    const html = `<head><meta charset="utf-8"><title>Email</title></head><body>Content</body>`;
    expect(htmlToText(html)).toContain("Content");
    expect(htmlToText(html)).not.toContain("charset");
  });

  it("removes HTML comments", () => {
    const html = `<!-- tracking comment -->Hello`;
    expect(htmlToText(html)).toBe("Hello");
  });

  it("removes 1×1 tracking pixels", () => {
    const html = `<img width="1" height="1" src="https://track.example.com/open.gif" />Visible`;
    expect(htmlToText(html)).toBe("Visible");
  });

  it("removes display:none images", () => {
    const html = `<img style="display:none" src="https://example.com/img.png" />Visible`;
    expect(htmlToText(html)).toBe("Visible");
  });

  it("removes base64 data URI images", () => {
    const html = `<img src="data:image/png;base64,iVBORw0KGgo=" />Visible`;
    expect(htmlToText(html)).toBe("Visible");
  });

  it("converts <br> to newlines", () => {
    const html = `Line 1<br>Line 2<br/>Line 3`;
    expect(htmlToText(html)).toBe("Line 1\nLine 2\nLine 3");
  });

  it("converts block elements to newlines", () => {
    const html = `<div>Block 1</div><div>Block 2</div>`;
    const text = htmlToText(html);
    expect(text).toContain("Block 1");
    expect(text).toContain("Block 2");
    expect(text).toMatch(/Block 1\n+Block 2/);
  });

  it("extracts link text with URL when different", () => {
    const html = `<a href="https://example.com">Click here</a>`;
    expect(htmlToText(html)).toBe("Click here (https://example.com)");
  });

  it("shows only link text when URL matches text", () => {
    const html = `<a href="https://example.com">https://example.com</a>`;
    expect(htmlToText(html)).toBe("https://example.com");
  });

  it("shows only link text for mailto links", () => {
    const html = `<a href="mailto:test@example.com">test@example.com</a>`;
    expect(htmlToText(html)).toBe("test@example.com");
  });

  it("strips remaining HTML tags", () => {
    const html = `<span class="foo"><strong>Bold</strong> text</span>`;
    expect(htmlToText(html)).toBe("Bold text");
  });

  it("decodes named HTML entities", () => {
    expect(htmlToText("&amp; &lt; &gt; &quot; &apos;")).toBe('& < > " \'');
  });

  it("decodes numeric HTML entities", () => {
    expect(htmlToText("&#39;")).toBe("'");
    expect(htmlToText("&#x27;")).toBe("'");
  });

  it("decodes &nbsp; to regular space", () => {
    expect(htmlToText("Hello&nbsp;World")).toBe("Hello World");
  });
});

// ── stripFooterJunk ────────────────────────────────────────────────────────

describe("stripFooterJunk", () => {
  it("removes 'Sent from my iPhone'", () => {
    const text = "Actual message\n\nSent from my iPhone";
    expect(stripFooterJunk(text).trim()).toBe("Actual message");
  });

  it("removes 'Sent from my Galaxy' (case-insensitive)", () => {
    const text = "Body\nSent from my Galaxy S24";
    expect(stripFooterJunk(text).trim()).toBe("Body");
  });

  it("removes 'Get Outlook for iOS'", () => {
    const text = "Body\n\nGet Outlook for iOS";
    expect(stripFooterJunk(text).trim()).toBe("Body");
  });

  it("removes unsubscribe lines", () => {
    const text = "Content\n\nTo unsubscribe click here";
    expect(stripFooterJunk(text).trim()).toBe("Content");
  });

  it("removes confidentiality disclaimers", () => {
    const text =
      "Content\n\nThis email is confidential and intended only for the intended recipient.";
    expect(stripFooterJunk(text).trim()).toBe("Content");
  });

  it("chops everything after signature separator '--'", () => {
    const text = "Real content\n--\nJohn Doe\nCEO, Example Corp";
    expect(stripFooterJunk(text).trim()).toBe("Real content");
  });

  it("removes copyright footers", () => {
    const text = "Content\n\n© 2024 Example Corp. All rights reserved.";
    const result = stripFooterJunk(text).trim();
    expect(result).not.toContain("©");
    expect(result).toContain("Content");
  });

  it("preserves normal content", () => {
    const text = "This is a normal email with no junk.";
    expect(stripFooterJunk(text)).toBe(text);
  });
});

// ── cleanWhitespace ────────────────────────────────────────────────────────

describe("cleanWhitespace", () => {
  it("trims each line", () => {
    expect(cleanWhitespace("  hello  \n  world  ")).toBe("hello\nworld");
  });

  it("collapses 3+ newlines to 2", () => {
    expect(cleanWhitespace("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("trims leading/trailing whitespace", () => {
    expect(cleanWhitespace("\n\n  hello  \n\n")).toBe("hello");
  });

  it("handles empty string", () => {
    expect(cleanWhitespace("")).toBe("");
  });
});

// ── sanitizeEmailBody (full pipeline) ──────────────────────────────────────

describe("sanitizeEmailBody", () => {
  it("converts a full HTML email to clean text", () => {
    const html = `
      <html>
        <head><style>.x{color:red}</style></head>
        <body>
          <div>Hi there,</div>
          <p>This is the <strong>important</strong> message.</p>
          <br>
          <p>Check out <a href="https://example.com">our site</a>.</p>
          <img width="1" height="1" src="https://track.example.com/pixel.gif" />
          <p>Sent from my iPhone</p>
        </body>
      </html>
    `;
    const result = sanitizeEmailBody(html);
    expect(result).toContain("Hi there,");
    expect(result).toContain("important");
    expect(result).toContain("our site (https://example.com)");
    expect(result).not.toContain("<");
    expect(result).not.toContain("style");
    expect(result).not.toContain("track.example.com");
    expect(result).not.toContain("Sent from my iPhone");
  });

  it("handles plain text HTML (no real tags)", () => {
    const html = "Just a plain string with no HTML.";
    expect(sanitizeEmailBody(html)).toBe("Just a plain string with no HTML.");
  });

  it("handles empty string", () => {
    expect(sanitizeEmailBody("")).toBe("");
  });

  it("strips base64 inline images from newsletters", () => {
    const html = `<p>Hello</p><img src="data:image/png;base64,abc123=" /><p>Bye</p>`;
    const result = sanitizeEmailBody(html);
    expect(result).not.toContain("data:");
    expect(result).toContain("Hello");
    expect(result).toContain("Bye");
  });

  it("handles deeply nested HTML", () => {
    const html = `
      <div><div><div><span>Deep content</span></div></div></div>
    `;
    expect(sanitizeEmailBody(html)).toContain("Deep content");
  });
});
