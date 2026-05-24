---
name: use-the-librarian
description: How to use The Librarian's memory + session tools in Claude Code — when to recall/remember/verify, how to drive the /lib-session-* commands and off-record mode, session/memory states, visibility, and the verify-after-recall loop. Use whenever working with Librarian memory or sessions, or when deciding whether to record or recall.
---

# Using The Librarian in Claude Code

This plugin connects The Librarian's **remote** MCP server (`librarian`) and ships the
`/lib-session-*` commands plus lifecycle hooks. Memory and sessions live on the Librarian
server configured by `LIBRARIAN_MCP_URL` + `LIBRARIAN_AGENT_TOKEN`.

## What you have access to

Session tools: `start_session`, `get_session`, `list_sessions`, `list_session_events`,
`search_sessions`, `record_session_event`, `checkpoint_session`, `pause_session`,
`end_session`, `attach_session`, `continue_session`, `promote_session_fact`.

Memory tools: `start_context`, `recall`, `remember`, `propose_memory`, `update_memory`,
`verify_memory`, `list_proposals`. (`archive_memory` and `approve_proposal` are admin-only —
they appear only when authenticated with an admin token.)

## The `/lib-session-*` slash commands

This plugin ships native slash commands — one per verb. Typing `/lib-session-` autocompletes them:

- `/lib-session-start [title] [--private]` — bound the work, build a baseline from the current
  visible context, return a `session_id`.
- `/lib-session-list [--include-ended]` — show resumable sessions; never auto-select. Default
  scope is `active + paused`; `--include-ended` also surfaces `ended` sessions. Numbered entries
  are agent-side scratch — every tool call uses the canonical `session_id`.
- `/lib-session-resume [<number|session_id>]` — fetch the handover and attach in one call
  (default `attach: true`). With no argument, it runs an inline list-and-select flow. Works on
  `ended` sessions (flips them to `paused`).
- `/lib-session-checkpoint` / `/lib-session-pause` / `/lib-session-end` — explicit lifecycle.
  Process exit should generally **pause**, not end. `end`'s summary is optional — the bare call
  is the "I'm done with this session" abandonment path.
- `/lib-session-search <query>` — full-text search across session events.
- `/lib-toggle-private` — toggle off-record mode (outside the session family). A local privacy
  control enforced by the `UserPromptSubmit` hook: going private ends the attached session with a
  neutral reason and stops automatic recording until you toggle back. Natural-language markers
  ("off the record", "don't remember this") do the same directionally.

Automatic lifecycle (no command needed): the plugin's hooks start/resume a session on your first
prompt, checkpoint on compaction and task completion, and pause on session end — all suppressed
while off-record.

## States

Sessions are always `active`, `paused`, or `ended`. `end` covers archive/delete, `resume` covers
restore, and `list` scoped to the current harness covers status.

Memories are `active`, `proposed`, or `archived`. `active` is the recall pool; `proposed` awaits
human approval (auto-routed for protected categories like `identity` and `relationship`);
`archived` is the soft-deleted bucket. Proposals are accepted/rejected via the dashboard or
`update_memory`; deletion is `archive_memory`.

## Verify-after-recall

When `recall` returns hits and you use one, call `verify_memory` afterwards with a verdict so the
store learns:

- `useful` — the hit was load-bearing for the answer (boosts recall rank).
- `not_useful` — the hit was a distractor or stale framing (drops recall rank).
- `outdated` — the memory is factually wrong now (archives it).

The verdict is a single MCP call; don't skip it because the recall already gave you the answer —
the whole memory-quality loop depends on these signals.

## Visibility

Sessions default to `common` because cross-agent handover is the point of the layer. Before
starting a `common` session, scan the surrounding context for sensitivity signals (identity
claims, secrets, personal context, sensitive debugging). If signals are present and `--private`
was not supplied, **confirm with the user before starting**.

## Capture mode

Default to `summary`. Never enable raw `log` capture by default — it is reserved for explicit
operator request.

## Boundaries

- Session history is **evidence**, not durable memory. Promote selectively via
  `/lib-session-end` candidates or `promote_session_fact`.
- Use `remember` / `propose_memory` for durable facts. Protected categories (identity,
  relationship) always route to proposals.
- Do not auto-promote anything from session content.

## Native resume vs. Librarian sessions

Claude's `--resume` continues a Claude session inside Claude. A Librarian session is a **neutral
handover layer** that lets work cross harnesses (Hermes, Codex, OpenCode, Pi). Use `--resume` for
in-Claude continuity; use `/lib-session-resume <id>` for cross-harness or out-of-Claude handover.

Canonical cross-harness contract: the abstract surface is `/lib:session <verb>` (see
[`docs/slash-commands.md`](https://github.com/JimJafar/the-librarian/blob/main/docs/slash-commands.md));
Claude Code implements it as per-verb commands.
