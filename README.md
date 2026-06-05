# the-librarian-claude-plugin

[![CI](https://github.com/JimJafar/the-librarian-claude-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/JimJafar/the-librarian-claude-plugin/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

A [Claude Code](https://claude.com/claude-code) **plugin** for
[The Librarian](https://github.com/JimJafar/the-librarian) — durable memory and
cross-harness narrative handoffs, backed by a Librarian HTTP MCP server you
point at (local or remote).

## Features

- **Memory tools** — `recall`, `remember`, `propose_memory`, `verify_memory`, `update_memory`,
  `list_proposals` as native Claude Code MCP tools.
- **Handoff tools** — `store_handoff`, `list_handoffs`, `claim_handoff` for atomic
  cross-harness handover.
- **Four slash commands** — `/handoff`, `/takeover`, `/learn`, `/toggle-private`.
- **Per-turn conv-state injection** — a `UserPromptSubmit` hook keeps the model aware of
  the conversation state (carrying the off-record marker, and surviving compaction).
- **Fail-soft** — if the Librarian is unreachable, a turn is never blocked.

## Install

```
/plugin marketplace add JimJafar/the-librarian-claude-plugin
/plugin install the-librarian@the-librarian
```

Set the two environment variables (below) in your shell profile and restart
Claude Code.

## Configure

| Variable | Required | Purpose |
| --- | --- | --- |
| `LIBRARIAN_MCP_URL` | yes | Librarian HTTP MCP URL, e.g. `https://librarian.example.com/mcp` |
| `LIBRARIAN_AGENT_TOKEN` | yes | Bearer token (kept only in the request header) |
| `LIBRARIAN_AGENT_ID` | no | Canonical agent id (omit if the token is agent-bound server-side) |
| `LIBRARIAN_PROJECT_KEY` | no | Default project scope |

```sh
export LIBRARIAN_MCP_URL="https://librarian.example.com/mcp"
export LIBRARIAN_AGENT_TOKEN="<your-token>"
```

### Remote Librarian

The Librarian's no-auth mode is **localhost-only**, so a remote endpoint **must**
carry a token over **HTTPS**. On the Librarian host:

```sh
LIBRARIAN_HOST=0.0.0.0 LIBRARIAN_AGENT_TOKENS="claude-code:<strong-token>" pnpm run serve
```

Then set `LIBRARIAN_MCP_URL` and `LIBRARIAN_AGENT_TOKEN` to match.

## How it works

The plugin ships exactly one Claude Code hook — `UserPromptSubmit` — which runs the
conv-state injection bin. The bin asks the Librarian for the conv_state row keyed by the
current Claude Code session id and, when present, emits a `<conversation-state>` block via
`hookSpecificOutput.additionalContext`. The block carries the `conv_id` and the most-recent
off-record marker so the model stays aware of the conversation state even after a compaction.

The four slash commands (`/handoff`, `/takeover`, `/learn`, `/toggle-private`) are pure
agent operations — they call MCP tools directly; nothing is recorded server-side until you
invoke one.

Behavioural guidance (verify-after-recall, private-mode contract, handoff template) ships
as the `use-the-librarian` skill, applied automatically.

## License

Apache-2.0.
