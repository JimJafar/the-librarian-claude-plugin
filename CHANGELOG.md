# Changelog

All notable changes to **the-librarian-claude-plugin** are documented in
this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This changelog starts at v0.1.0 — the first version likely to see public
adoption. The pre-v0.1.0 development history lives in the git log; only
changes from this point forward are catalogued here.

## [Unreleased]

### Added

- **Awareness primer injected every turn (spec 041).** The
  `UserPromptSubmit` hook now also renders the operator-authored awareness
  primer as a canonical `<librarian>` block, sourced from the additive
  top-level `primer` field the Librarian's `conv_state_get` returns. The
  block is byte-identical to `@librarian/core`'s `renderAwarenessPrimer`
  (`<librarian>\n{primer}\n</librarian>`, body not indented) so the model
  sees the same primer on every harness. It's global: it's emitted even
  when there is no conv-state row (its job is the day-one floor), and
  suppressed when the primer is empty (disabled). Both blocks come from the
  single existing `conv_state_get` fetch — no second call, no new hook —
  and the fail-soft contract is unchanged (a Librarian / network / parse
  failure emits no block and never blocks the turn). The injection handler
  was updated to parse `conv_state_get`'s post-spec-041 JSON shape
  (`{ ...row, primer }` with a row, `{ primer }` with none) in place of the
  retired "No conversation state …" text response.

### Changed

- **Conv-state block trimmed to `conv_id` + `off_record`.** The per-turn
  `<conversation-state>` block the `UserPromptSubmit` hook injects now
  renders only the conversation key and the privacy flag — the retired
  `domain` and `session_id` lines are dropped. This lands in lockstep
  with `@librarian/core`'s `renderConvStateBlock` helper and every other
  plugin that injects this block, keeping the cross-harness contract
  byte-identical. The `ConvStateRow` type drops `domain` and
  `session_id` to match. (The conv_id key is still derived from the
  harness event's `session_id`; only the rendered row changed.)

### Removed

- **`/learn` drops the `conv_id` → `domain` resolution and the
  classifier-worker reference.** D16 removed the domain model and the
  classifier subsystem was removed, so `/learn` no longer passes
  `conv_id` to let the server resolve a domain, routes proposals through
  the server (not a classifier worker), and no longer points at the
  retired `/lib-session-list` command in its report.
- **Retired `domain` framing in the skill, AGENTS.md, and README.** The
  `use-the-librarian` skill, `AGENTS.md`, and `README.md` no longer say
  the model "knows which domain its memory writes route to"; conv-state
  is described as keyed by the harness conversation id, carrying the
  off-record marker and surviving compaction (no domain). The skill also
  drops the retired `conv_state_upsert` verb.

## [0.2.0] — 2026-05-28

### Added

- **Release runbook + per-repo release doc.** A new
  [`docs/release.md`](docs/release.md) captures the per-repo release
  steps (the three version files bumped in lockstep, CHANGELOG move,
  tag + GitHub release). AGENTS.md is thinned and points at it; the
  cross-family runbook lives in the monorepo at
  [`the-librarian/docs/release-runbook.md`](https://github.com/JimJafar/the-librarian/blob/main/docs/release-runbook.md).

### Changed

- **Sessions rethink — breaking change (sessions-rethink PR 2).** The
  whole session subsystem is replaced by a smaller handoffs surface plus
  in-conversation private mode. Specifically:
  - **Removed slash commands:** `/lib-session-start`, `/lib-session-list`,
    `/lib-session-resume`, `/lib-session-checkpoint`, `/lib-session-pause`,
    `/lib-session-end`, `/lib-session-search`, `/lib-toggle-private`.
  - **New slash commands:** `/handoff` (author a five-section narrative and
    persist it for cross-harness pickup), `/takeover` (atomically claim a
    handoff and inject its document), `/learn` (extract durable lessons →
    `propose_memory`), `/toggle-private` (in-conversation marker — no
    server flag, no hook, no persistence).
  - **Removed hooks:** `PostCompact`, `TaskCompleted`, `SessionEnd` and the
    session-dispatch leg of `UserPromptSubmit` are gone. Only the
    conv-state injection leg of `UserPromptSubmit` remains.
  - **Removed bundles:** `bin/librarian-claude-hook.js` and
    `bin/librarian-mcp-call.js` are deleted; only
    `bin/librarian-conv-state-inject.js` survives.
  - **Removed source:** `src/cli.ts`, `src/remote-cli.ts`, `src/session.ts`,
    `src/state.ts`, `src/privacy.ts`, `src/transport.ts`, `src/mcp-client.ts`,
    `src/index.ts`, `src/bin/claude-code-hook.ts`, `src/bin/mcp-call.ts`,
    `src/harness/claude-code.ts`, `scripts/dispatch.sh`. The natural-language
    privacy detector (`/private`, `/public`, "off the record") is retired
    per spec §6.5 — `/toggle-private` is the only way in or out.
  - **Server compatibility:** requires a Librarian server running the
    sessions-rethink PR 1 monorepo build (the `store_handoff` /
    `list_handoffs` / `claim_handoff` MCP tools must exist).
  - **Migration:** existing operators should drain in-flight sessions (run
    `/lib-session-end` before upgrading), update the plugin, and restart
    Claude Code. Pre-cutover sessions remain queryable from the dashboard
    until PR 7 removes the sessions table; new work uses `/handoff`.

### Added

- **Conv-state injection on every UserPromptSubmit.** Implements
  spec §4.9 of the upstream memory-domain-isolation rollout. A new
  hook entry runs `bin/librarian-conv-state-inject.js` alongside the
  existing lifecycle dispatch on every UserPromptSubmit event: it
  reads the calling `conversation_state` row via `conv_state_get` and,
  when one exists, emits the canonical `<conversation-state>` block
  as `hookSpecificOutput.additionalContext` so the LLM sees the
  current `domain` / `session_id` / `off_record` on every turn —
  defeating context-compaction-driven state loss. When no row exists
  or the server is unreachable, the bin stays silent (fail-soft per
  AGENTS.md §2) and the prompt reaches the model unmodified.
- **Lifecycle source restored in-tree.** The plugin no longer depends
  on a sibling `the-librarian` checkout to rebuild its committed
  bundles. `src/` now contains the TypeScript source for the Claude
  Code harness adapter, the synchronous→async MCP-call bridge, and
  all the shared modules they use (privacy detector, state store,
  session driver, transport, remote CLI). Extracted from main-repo
  SHA `50ba519` (the commit immediately before PR #153 deleted
  `integrations/shared/librarian-lifecycle/src/`). The codex harness
  was intentionally omitted — this plugin only ships Claude Code.
- `AGENTS.md` with the family-wide house rules (privacy, fail-soft,
  cross-repo contracts, CHANGELOG discipline, etc.) and the
  Claude-plugin-specific build / test / gotcha notes. Sibling
  AGENTS.md files in the four other Librarian repos share the same
  baseline.

### Changed

- **`scripts/build-bundle.mjs` bundles from in-tree `src/`.** The
  `LIBRARIAN_MONOREPO` env-var override is gone; the build no longer
  reaches outside this repo. `bin/PROVENANCE.json` schema updated:
  `monorepoSha` + `lifecycleVersion` are removed; `repoSha` is added;
  `source` is `"in-tree"`.
- **`bin/librarian-conv-state-inject.mjs` is now built from
  `src/bin/conv-state-inject.ts`** and emitted as
  `bin/librarian-conv-state-inject.js` (extension change — the
  handwritten ESM file was the previous source of truth, now under
  src/ as typed TS, bundled by esbuild like the other two bins).
  `scripts/validate.mjs` now hash-validates all three committed bins
  against `PROVENANCE.json`.
- **AGENTS.md §2** updated: the canonical TS privacy-detector source
  in `the-librarian/integrations/shared/librarian-lifecycle/` was
  deleted when the family went fully standalone. The privacy detector
  is now one of five peer implementations across the family (this
  repo's bundled JS, Codex, Hermes, OpenCode, Pi). Coordinate any
  marker-list change across all five repos. (The TS source for this
  plugin's copy now lives at `src/privacy.ts` after the in-tree
  restoration — see the "Added" entry above.)

## [0.1.0] — 2026-05-26

Public baseline. A [Claude Code](https://claude.com/claude-code) plugin for
[The Librarian](https://github.com/JimJafar/the-librarian) — durable memory
+ cross-harness session lifecycle, backed by a remote Librarian MCP server.

### Shipped in this baseline

- **Remote Librarian MCP tools** via `.mcp.json` (HTTP transport, bearer
  auth from `LIBRARIAN_AGENT_TOKEN`). All session and memory tools
  (`recall`, `remember`, `verify_memory`, `start_session`,
  `checkpoint_session`, `continue_session`, …) become available in Claude
  Code.
- **`/lib-session-*` slash commands** — one per canonical verb (start,
  list, resume, checkpoint, pause, end, search) plus
  `/lib-toggle-private`. Native Claude Code per-verb command files.
- **Automatic session lifecycle hooks**:
  - `UserPromptSubmit` for the off-record privacy gate
  - `PostCompact` for checkpointing on compaction
  - `TaskCompleted` for end-of-task checkpoints
  - `SessionEnd` for pause-on-exit
- **Off-record gate** — natural-language privacy markers ("off the
  record", "keep this between us", …) end the attached session and
  suppress recording until cleared.
- **Bundled execution** — `bin/librarian-claude-hook.js` and
  `bin/librarian-mcp-call.js` are committed esbuild outputs; users have no
  `npm install` step.

[Unreleased]: https://github.com/JimJafar/the-librarian-claude-plugin/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/JimJafar/the-librarian-claude-plugin/releases/tag/v0.1.0
