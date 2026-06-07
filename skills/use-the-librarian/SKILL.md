---
name: use-the-librarian
description: How to use The Librarian's memory + handoff tools in Claude Code — when to recall/remember/verify, how to drive the /handoff /takeover /learn /toggle-private commands, memory states, the verify-after-recall loop, and the new in-conversation private mode. Use whenever working with Librarian memory or cross-harness handoffs.
---

# Using The Librarian in Claude Code

This plugin connects The Librarian's **remote** MCP server (`librarian`) and ships four
user-facing slash commands plus a per-turn conv-state injection hook. Memory and handoffs
live on the Librarian server configured by `LIBRARIAN_MCP_URL` + `LIBRARIAN_AGENT_TOKEN`.

## What you have access to

**Memory tools:** `start_context`, `recall`, `remember`, `propose_memory`, `update_memory`,
`verify_memory`, `list_proposals`. (`archive_memory` and `approve_proposal` are admin-only —
they appear only when authenticated with an admin token.)

**Handoff tools:** `store_handoff`, `list_handoffs`, `claim_handoff` — back the cross-harness
narrative-handover surface that replaced the old session subsystem.

**Conversation state:** `conv_state_get`, `conv_state_clear` — the per-conversation registry
keyed by harness conversation id, carrying `session_id` + `off_record`. The plugin's
`UserPromptSubmit` hook reads conv_state and injects a `<conversation-state>` block into the
turn.

## The four slash commands

Typing `/` autocompletes these:

- **`/handoff`** — author a five-section narrative (Start & intent / Journey / Current state /
  What's left / Open questions) and persist it via `store_handoff`. The receiving agent in any
  harness claims it with `/takeover` in the same cwd.
- **`/takeover`** — pick up a handoff from another agent. Lists candidates (current
  project_key + cwd by default, broadens by dropping filters), then atomically claims the
  selected row and injects its document into your conversation.
- **`/learn`** — extract durable lessons from the current conversation and feed
  user-approved ones into `remember` (non-protected lessons file directly; protected
  categories still route to proposals). Replaces the implicit "extract lessons from
  sessions" job the curator used to do.
- **`/toggle-private`** — toggle the in-conversation private-mode marker. Pure in-context
  — no MCP call, no server flag, no hook. While `[librarian:private=on]` is the most
  recent marker, the agent stops calling `remember` / `propose_memory`; recall is still
  allowed. `/handoff` and `/learn` require explicit user confirmation while private.

## Memory states

Memories are `active`, `proposed`, or `archived`. `active` is the recall pool; `proposed`
awaits human approval (auto-routed for protected categories like `identity` and
`relationship`); `archived` is the soft-deleted bucket. Proposals are accepted/rejected via
the dashboard or `update_memory`; deletion is `archive_memory`.

## Verify-after-recall

When `recall` returns hits and you use one, call `verify_memory` afterwards with a verdict
so the store learns:

- `useful` — the hit was load-bearing for the answer (boosts recall rank).
- `not_useful` — the hit was a distractor or stale framing (drops recall rank).
- `outdated` — the memory is factually wrong now (archives it).

The verdict is a single MCP call; don't skip it because the recall already gave you the
answer — the whole memory-quality loop depends on these signals.

## Private mode — known limitation

Private mode is enforced purely by the most-recent `[librarian:private=on|off]` marker in
the conversation. **Conversation compaction can erase the marker.** If the harness
compacts and drops the system message that set it, the agent falls back to OFF and resumes
writing durable memory. Mitigations:

- The toggle message includes a "remain in this state until told otherwise" instruction so
  the model re-emits the marker if it notices the gap.
- Operators who need hard guarantees should run with `--no-compact` or equivalent.

## Boundaries

- Handoffs are claimable narratives, not durable memory. They expire when claimed; promote
  durable facts via `/learn` → `remember`.
- Use `remember` / `propose_memory` for facts that should survive across conversations.
  Protected categories (identity, relationship) always route to proposals.
- Do not write to durable memory while `[librarian:private=on]` is the most recent marker
  unless the user explicitly confirms.
