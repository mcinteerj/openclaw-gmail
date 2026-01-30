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
- **Outbound Restrictions** (optional): Use `allowOutboundTo` and `threadReplyPolicy` to control who the bot can send emails to. By default, no outbound restrictions are applied (backwards compatible).

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
          "includeQuotedReplies": true,  // default: true
          // Optional: restrict who the bot can send emails TO
          "allowOutboundTo": ["@mycompany.com", "partner@example.com"],
          "threadReplyPolicy": "allowlist"  // default: "open"
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
| `allowOutboundTo` | string[] | (falls back to `allowFrom`) | Restrict who the bot can send emails to. Supports exact emails and domain wildcards (e.g., `@company.com`). |
| `threadReplyPolicy` | string | `"open"` | Controls thread reply behavior: `"open"` (no restrictions), `"allowlist"` (all recipients must be in `allowOutboundTo`), or `"sender-only"` (only original thread sender checked). |

### Thread Reply Policies

- **`open`** (default): No outbound restrictions. The bot can reply to any thread it was BCCd into. Backwards compatible.
- **`allowlist`**: All thread participants (To, CC, From) must be in `allowOutboundTo`. Blocks replies if *any* recipient is not allowed.
- **`sender-only`**: Only checks if the original thread sender is in `allowOutboundTo`. Useful when you want to reply to threads started by allowed users, even if they CC'd external parties.

## Development

Run tests:
```bash
npm test
# or
./node_modules/.bin/vitest run src/
```

## Publishing

This repo includes a GitHub Actions workflow for npm publishing.

### Automatic (on release)
Create a GitHub release → automatically publishes to npm.

### Manual (workflow dispatch)
Go to Actions → "Publish to npm" → Run workflow.

**Note:** Manual dispatch will:
1. Bump the version (patch by default, or specify major/minor)
2. Commit and push the version bump with a tag
3. Publish to npm

### Setup
Add `NPM_TOKEN` secret to the repository:
1. Generate token at npmjs.com → Access Tokens → Classic Token (Automation)
2. Add to repo: Settings → Secrets → Actions → New repository secret
