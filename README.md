# the-librarian-claude-plugin

[![CI](https://github.com/JimJafar/the-librarian-claude-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/JimJafar/the-librarian-claude-plugin/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

A [Claude Code](https://claude.com/claude-code) **plugin** for
[The Librarian](https://github.com/JimJafar/the-librarian) — durable memory and
cross-harness session continuity, backed by a Librarian HTTP MCP server you
point at (local or remote).

## Features

- **Memory + session tools** — `recall` / `remember` / `verify_memory`,
  `start_session`, … as native Claude Code MCP tools.
- **`/lib-session-*` + `/lib-toggle-private`** slash commands for the full
  session lifecycle.
- **Automatic session lifecycle** — a session starts/resumes on your first
  prompt, checkpoints on compaction and task completion, pauses on session end.
- **Off-record privacy gate** — say "off the record" (or run
  `/lib-toggle-private`) and recording stops until you go back on.
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
| `LIBRARIAN_PROJECT_KEY` | no | Default project scope for sessions |

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

| Claude Code hook | Effect |
| --- | --- |
| `UserPromptSubmit` | Start / resume a session, run the privacy gate |
| `PostCompact` | Checkpoint around compaction |
| `TaskCompleted` | Checkpoint at task boundaries |
| `SessionEnd` | Pause (never auto-end) |

The lifecycle's behavioural guidance (verify-after-recall, visibility, capture
mode, boundaries) ships as the `use-the-librarian` skill, applied automatically.

## License

Apache-2.0.
