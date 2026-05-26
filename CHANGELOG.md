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

- `AGENTS.md` with the family-wide house rules (privacy, fail-soft,
  cross-repo contracts, CHANGELOG discipline, etc.) and the
  Claude-plugin-specific build / test / gotcha notes. Sibling
  AGENTS.md files in the four other Librarian repos share the same
  baseline.

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
