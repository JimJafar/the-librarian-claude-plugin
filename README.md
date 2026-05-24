# the-librarian-claude-plugin

A [Claude Code](https://claude.com/claude-code) **plugin** for
[The Librarian](https://github.com/JimJafar/the-librarian) — durable memory + cross-harness
session lifecycle, backed by a **remote** Librarian MCP server.

It gives Claude Code:

- the Librarian **memory + session tools** (`recall`, `remember`, `verify_memory`,
  `start_session`, …) over your remote endpoint;
- the **`/lib-session-*`** and **`/lib-toggle-private`** slash commands;
- **automatic session lifecycle** — a session starts/resumes on your first prompt, checkpoints
  on compaction and task completion, and pauses on session end;
- an **off-record gate** — "off the record" / `/lib-toggle-private` ends the attached session and
  suppresses recording until you go back on the record.

## Install

```
/plugin marketplace add JimJafar/the-librarian-claude-plugin
/plugin install the-librarian@the-librarian
```

Then set the two environment variables (below) and restart Claude Code.

## Configure (environment variables)

Both the agent's MCP tools and the lifecycle hooks read the **same two** variables, so set them
once in your shell profile (`~/.zshrc`, `~/.bashrc`, …):

| Variable | Required | Notes |
| --- | --- | --- |
| `LIBRARIAN_MCP_URL` | yes | The Librarian HTTP MCP URL, e.g. `https://librarian.example.com/mcp` |
| `LIBRARIAN_AGENT_TOKEN` | yes | Bearer token for the endpoint (kept only in the request header) |
| `LIBRARIAN_AGENT_ID` | no | Canonical agent id; omit if the token is agent-bound server-side |
| `LIBRARIAN_PROJECT_KEY` | no | Default project scope for sessions |

```sh
export LIBRARIAN_MCP_URL="https://librarian.example.com/mcp"
export LIBRARIAN_AGENT_TOKEN="<your-token>"
```

> Why env vars (not the plugin install prompt)? Claude Code's `userConfig` reliably feeds
> `.mcp.json` but **not** a hook subprocess. Env vars are the one source both the MCP server
> config and the hooks can read.

### Remote deployment

Serve the Librarian's HTTP MCP and point `LIBRARIAN_MCP_URL` at it:

```sh
# on the Librarian host
LIBRARIAN_HOST=0.0.0.0 LIBRARIAN_AGENT_TOKENS="claude-code:<strong-token>" pnpm run serve
```

The Librarian's no-auth mode is **localhost-only**, so a remote endpoint **must** carry a token
over **HTTPS**. (`LIBRARIAN_AGENT_TOKENS` binds the token to an agent id server-side, so
attribution is correct without setting `LIBRARIAN_AGENT_ID`.)

## How it works

| Claude Code hook | The Librarian | Notes |
| --- | --- | --- |
| `UserPromptSubmit` | start / resume session (+ privacy gate) | one session per cwd; off-record markers suppress |
| `PostCompact` | `checkpoint_session` | checkpoint before/around compaction |
| `TaskCompleted` | `checkpoint_session` | checkpoint at a task boundary |
| `SessionEnd` | `pause_session` | pause (never auto-end) |
| slash commands | the matching `mcp__librarian__*` tools | agent-driven memory + sessions |

Two invariants the hooks guarantee:

- **Never block or pollute the prompt** — the hook always exits 0 and writes nothing to stdout.
- **Fail soft / fail closed** — if the Librarian is unreachable a turn is never blocked; if local
  privacy state can't be read, no automatic call is made.

The lifecycle's behavioral guidance (verify-after-recall, visibility, capture mode, boundaries)
ships as the `use-the-librarian` skill, so Claude applies it automatically (plugins don't read
`CLAUDE.md`).

## Bundled artifacts (do not hand-edit)

`bin/librarian-claude-hook.js` and `bin/librarian-mcp-call.js` are **generated** esbuild bundles
of [`@librarian/lifecycle`](https://github.com/JimJafar/the-librarian) — the plugin's
distributable, committed to the repo. Do not edit them by hand; regenerate with:

```sh
npm install
npm run build   # needs a sibling the-librarian checkout, or set LIBRARIAN_MONOREPO
```

`bin/PROVENANCE.json` records the source revision + a hash of each bundle; CI fails if a committed
bin no longer matches its recorded hash (a drift guard).

## Develop

```sh
npm install
npm run validate   # manifests, hooks shape, bundle provenance
npm run smoke      # runs the bundled bins + dispatch.sh against a fake /mcp
```

## License

Apache-2.0.
