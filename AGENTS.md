# openclaw-gmail — Gmail Channel Extension for OpenClaw

## What This Is
An OpenClaw channel plugin that integrates Gmail as a messaging channel. Polls for inbound emails, dispatches to the agent, sends replies as threaded emails with Gmail-native HTML quoting.

## Architecture
- **Entry**: `index.ts` registers `gmailPlugin` via `api.registerChannel()`
- **Core**: `src/channel.ts` (plugin def + gateway), `src/outbound.ts` (reply sending), `src/quoting.ts` (thread quote building), `src/inbound.ts` (email parsing), `src/monitor.ts` (polling), `src/sanitize.ts` (HTML-to-plain-text for LLM)
- **Transport**: Dual-backend — `@googleapis/gmail` (API, preferred) or `gog` CLI. Set `backend: "api"` on accounts for direct API access.
- **Runtime**: Raw `.ts` loaded by OpenClaw via Jiti — no build step.

## Tech Stack
- TypeScript (no compilation — loaded raw by OpenClaw runtime)
- `marked` + `sanitize-html` for Markdown-to-HTML email composition
- `zod` for config schema validation
- `gog` CLI (legacy backend) or `@googleapis/gmail` (API backend)
- Peer dependency: `openclaw >= 2026.1.0`

## Config Conventions
- **Read** and **write** config using: `cfg.channels?.["openclaw-gmail"]` / `sectionKey: "openclaw-gmail"`
- The plugin ID is `"openclaw-gmail"`. The alias `"gmail"` exists for backward compat but all code should use the canonical name.
- Account keys are email addresses (e.g. `"honk.keithy@gmail.com"`). The gateway's routing layer normalizes these (e.g. to `"honk-keithy-gmail-com"`), so `resolveGmailAccount` handles reverse-matching.

## Quality & Testing
- **Test files**: `src/sanitize.test.ts`, `src/outbound-check.test.ts`
- No standalone `npm test` — run via OpenClaw test harness
- Verify changes by inspecting TypeScript types and manual testing through the OpenClaw runtime

## Issue Tracking

This project uses **bd (beads)** for issue tracking.
Run `bd prime` for workflow context, or install hooks (`bd hooks install`) for auto-injection.

**Quick reference:**
- `bd ready` - Find unblocked work
- `bd show <id>` - View issue details
- `bd create "Title" --type task --priority 2` - Create issue
- `bd update <id> --status in_progress` - Claim work
- `bd close <id>` - Complete work
- `bd sync` - Sync with git (run at session end)

For full workflow details: `bd prime`

## Session Close Protocol
Before ending a session:
1. `git status` — check what changed
2. `git add <files>` — stage code changes
3. `bd sync` — commit beads changes
4. `git commit -m "..."` — commit code
5. `bd sync` — commit any new beads changes
6. `git push` — push to remote
