# Gmail Channel (Plugin)

Connects Moltbot to Gmail via the `gog` CLI.

## Installation

This is a plugin. To install from source:

```bash
moltbot plugins install ./extensions/gmail
```

## Features

- **Polling-based sync**: Robustly fetches new unread emails from Inbox.
- **Circuit Breaker**: Handles API failures and rate limiting gracefully.
- **Rich Text**: Markdown support for outbound emails.
- **Threading**: Native Gmail thread support with quoted reply context.
- **Archiving**: Automatically archives threads upon reply.
- **Email Body Sanitisation**: Automatically cleans incoming email bodies for LLM consumption.

## Email Body Sanitisation

Incoming emails are automatically sanitised to produce clean, readable text — no configuration needed.

### What It Does

- **HTML-to-text conversion**: Strips tags, removes `<style>` and `<script>` blocks, filters out tracking pixels, and decodes HTML entities.
- **Footer junk removal**: Strips common noise like unsubscribe links, "Sent from my iPhone", and confidentiality notices.
- **Whitespace cleanup**: Collapses excessive blank lines and trims leading/trailing whitespace.
- **Signature stripping**: Removes content below `-- ` signature separators by default.

### Configurable Signature Stripping

Signature stripping is enabled by default. If you need to preserve content after `--` separators (e.g. for emails where dashes appear in the body), you can disable it programmatically:

```ts
extractTextBody(html, plain, { stripSignature: false })
```

No plugin configuration is required — sanitisation runs automatically on every inbound message.

## Reply Behavior

- **Reply All**: When the bot replies to a thread, it uses "Reply All" to ensure all participants are included.
- **Quoted Replies**: By default, replies include the full thread history as quoted text (standard Gmail format: "On [date], [author] wrote:"). This can be disabled per-account or globally.
- **Allowlist Gatekeeping**: The bot only responds to emails from senders on the `allowFrom` list. However, if an allowed user includes others (CC) who are *not* on the allowlist, the bot will still "Reply All", including them in the conversation. This allows authorized users to bring others into the loop.

## Configuration

Add to `moltbot.json`:

```json5
{
  "channels": {
    "gmail": {
      "accounts": {
        "main": {
          "email": "user@gmail.com",
          "allowFrom": ["*"],
          "includeQuotedReplies": true  // default: true
        }
      },
      "defaults": {
        "includeQuotedReplies": true  // global default
      }
    }
  }
}
```

### Configuration Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `includeQuotedReplies` | boolean | `true` | Include thread history as quoted text in replies. Set to `false` for cleaner, shorter replies. |

## Development

Run tests:
```bash
./node_modules/.bin/vitest run extensions/gmail/src/
```
