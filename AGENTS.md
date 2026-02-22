# openclaw-gmail — Gmail Channel Extension for OpenClaw

## What This Is
An OpenClaw channel plugin that integrates Gmail as a messaging channel. Polls for inbound emails, dispatches to the agent, sends replies as threaded emails with Gmail-native HTML quoting.

## Architecture
- **Entry**: `index.ts` registers `gmailPlugin` via `api.registerChannel()`
- **Core**: `src/channel.ts` (plugin def + gateway), `src/outbound.ts` (reply sending), `src/quoting.ts` (thread quote building), `src/inbound.ts` (email parsing), `src/monitor.ts` (polling), `src/sanitize.ts` (HTML-to-plain-text for LLM)
- **Transport**: Currently shells out to `gog` CLI for all Gmail API operations. Migration to `@googleapis/gmail` in progress (see gmail-2 epic).
- **Runtime**: Raw `.ts` loaded by OpenClaw via Jiti — no build step.

## Tech Stack
- TypeScript (no compilation — loaded raw by OpenClaw runtime)
- `marked` + `sanitize-html` for Markdown-to-HTML email composition
- `zod` for config schema validation
- `gog` CLI for Gmail API operations (being replaced by `@googleapis/gmail`)
- Peer dependency: `openclaw >= 2026.1.0`

## Config Conventions
- **Read** config from: `cfg.channels?.gmail`
- **Write** config with: `sectionKey: "openclaw-gmail"`
- This inconsistency is pre-existing. Follow the read pattern for new code.

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
