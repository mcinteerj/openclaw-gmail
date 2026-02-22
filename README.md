# openclaw-gmail

Gmail channel plugin for [OpenClaw](https://github.com/openclaw/openclaw). Supports two backends:

- **API** (recommended) — connects directly via the Gmail API using OAuth2. No external CLI needed.
- **gog** — shells out to the [gog CLI](https://github.com/jay/gog). The original backend, still fully supported.

Both backends coexist — you can run different accounts on different backends.

## Installation

```bash
openclaw plugins install @mcinteerj/openclaw-gmail
```

Or from a local clone:

```bash
openclaw plugins install --link /path/to/openclaw-gmail
```

Requires `openclaw >= 2026.1.0`.

## Setup

### Option 1: API backend (recommended)

The API backend connects directly to Gmail — no gog CLI required.

**If you have gog installed**, the onboarding flow will detect your existing OAuth client credentials from `~/.config/gogcli/credentials.json` and reuse them. You only need a one-time browser authorization to get a new refresh token.

**If you don't have gog**, you'll need to create a GCP OAuth client:

1. Go to [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials)
2. Create a project (or use an existing one)
3. Enable the Gmail API
4. Create an OAuth 2.0 Client ID (type: **Desktop app**)
5. Copy the Client ID and Client Secret

Then run `openclaw configure`, select Gmail, and follow the prompts. The flow will:
- Ask for your email address
- Prompt for client credentials (or reuse gog's)
- Open a browser for OAuth consent
- Store the refresh token in your OpenClaw config
- Set `backend: "api"` on the account

**Manual config** (if you prefer to skip the wizard):

```json5
{
  "channels": {
    "openclaw-gmail": {
      "accounts": {
        "you@gmail.com": {
          "email": "you@gmail.com",
          "backend": "api",
          "oauth": {
            "clientId": "your-client-id.apps.googleusercontent.com",
            "clientSecret": "your-client-secret",
            "refreshToken": "your-refresh-token"
          },
          "allowFrom": ["*"],
          "pollIntervalMs": 60000
        }
      }
    }
  }
}
```

### Option 2: gog backend

Install the [gog CLI](https://github.com/jay/gog) (v1.2.0+), authorize it (`gog auth add you@gmail.com`), then run `openclaw configure`. The account will use gog by default (no `backend` field needed).

### Upgrading from gog to API

Existing gog users upgrading the plugin will continue working with no changes — gog remains the default. To migrate an account to the API backend:

1. Run `openclaw configure` → select Gmail
2. The wizard detects your gog credentials and offers migration
3. Authorize in the browser (one-time, ~10 seconds)
4. Done — your account now uses the API directly

Your gog installation is not affected and other accounts can continue using it.

## Features

- **Polling-based sync**: Fetches new unread emails from Inbox
- **Rich text**: Markdown responses are converted to HTML emails via `marked`
- **Threading**: Native Gmail thread support with quoted reply context
- **Reply All**: Replies include all thread participants
- **Archiving**: Automatically archives threads upon reply
- **Email body sanitization**: Cleans incoming HTML for LLM consumption
- **Circuit breaker** (gog backend): Handles API failures and rate limiting
- **MIME construction** (API backend): Builds RFC 2822 messages with proper threading headers

## Configuration

```json5
{
  "channels": {
    "openclaw-gmail": {
      "accounts": {
        "you@gmail.com": {
          "email": "you@gmail.com",
          "allowFrom": ["*"],
          "pollIntervalMs": 60000,
          "includeQuotedReplies": true,        // default: true
          "allowOutboundTo": ["@company.com"],  // optional
          "threadReplyPolicy": "allowlist"      // default: "open"
        }
      },
      "defaults": {
        "includeQuotedReplies": true
      }
    }
  }
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `backend` | `"api"` \| `"gog"` | `"gog"` | Which backend to use for this account |
| `oauth` | object | — | OAuth credentials (required for API backend) |
| `allowFrom` | string[] | `[]` | Sender allowlist. `["*"]` allows all. |
| `pollIntervalMs` | number | `60000` | Polling interval in milliseconds |
| `includeQuotedReplies` | boolean | `true` | Include thread history as quoted text in replies |
| `allowOutboundTo` | string[] | (falls back to `allowFrom`) | Restrict who the bot can send to. Supports domain wildcards (`@company.com`). |
| `threadReplyPolicy` | `"open"` \| `"allowlist"` \| `"sender-only"` | `"open"` | Controls reply restrictions |

### Thread Reply Policies

- **`open`** (default): No outbound restrictions. Backwards compatible.
- **`allowlist`**: All thread participants must be in `allowOutboundTo`.
- **`sender-only`**: Only checks if the original thread sender is allowed.

## Development

```bash
npx vitest run
```

## Publishing

Create a GitHub release or run the "Publish to npm" workflow via Actions.
