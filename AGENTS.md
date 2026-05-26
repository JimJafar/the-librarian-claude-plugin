# AGENTS.md

You're an AI agent working on this repo. It's part of
[The Librarian](https://github.com/JimJafar/the-librarian) — a portable
memory + session layer for AI agents, open source, designed for
production use by people we'll never meet. Read this before your first
commit. Follow it on every change.

## 1. What this repo is

A [Claude Code](https://claude.com/claude-code) plugin for The
Librarian — gives Claude Code remote memory tools, automatic session
lifecycle hooks, `/lib-session-*` slash commands, and an off-record
privacy gate. Distributed via the Claude Code plugin marketplace.

## 2. House rules

### Be honest about what you ran

Never claim "tests pass" without running them. Never say a build works
because it "should." If a step was skipped, say so. If something is
unverified, label it. Your next session, and every contributor reading
your PR, inherits whatever you said — make sure it's true.

### Privacy beats convenience

This is The Librarian. Privacy is the product, not a feature. The
off-record gate stops all automatic recording — never bypass it, never
"just for debugging." Bearer tokens go in headers, never in URLs or
logs or error messages. The privacy-marker list is shared across all
five Librarian plugins (Claude Code, Codex, Hermes, OpenCode, Pi) —
**five peer implementations of the same behaviour, no single canonical
source any longer.** Any marker-list change must land coordinated
across all five repos in one go (or none). Note: this repo's privacy
detector lives inside the committed `bin/librarian-claude-hook.js`
bundle (no separate source); changes here require regenerating the
bundle from your edit of choice.

### Fail-soft, never block the user's turn

A Librarian / network / parse failure must never throw out of a harness
hook, never block a prompt from reaching the model, never leak a stack
trace into the model's context. Log to the local sidecar, return the
no-op response, move on. The Librarian server can be down for an hour
and the user's day shouldn't notice.

### The cross-repo contracts are sacred

Three things stay consistent across the family. Don't change any of
them in one repo without changing all of them in the same coordinated
push, and never invent new ones unilaterally:

- **`/lib:session` verbs:** `start`, `list`, `resume`, `checkpoint`,
  `pause`, `end`, `search`, plus `/lib-toggle-private`. Canonical
  contract: [`the-librarian/docs/slash-commands.md`](https://github.com/JimJafar/the-librarian/blob/main/docs/slash-commands.md).
- **Three-state models:** sessions are `active | paused | ended`;
  memories are `active | proposed | archived`. The retired verbs
  (`archive`, `restore`, `delete`, `status`, `confirm_memory`,
  `reject_memory`) are gone for good.
- **`source_ref` shape:** `<harness>:<run-id>:cwd:<abs>` when the run
  id is available, else `cwd:<abs>`. This is the cross-harness primary
  key for sessions.

### Respect your consumers

Open source means people depend on what we ship. Treat that with care.

- **No surprise breaking changes.** A breaking change is a major bump
  with a CHANGELOG migration note explaining what changed and how to
  adapt. Deprecate in one release, remove in the next.
- **Every user-visible change updates `CHANGELOG.md`.** Add an entry
  under `## [Unreleased]` in the same PR that ships the change — not
  a follow-up. Internal-only refactors can skip; when unsure, add the
  entry (cheap, erasable).
- **Error messages teach.** "Invalid input" is not an error message.
  "Expected ISO-8601 timestamp, got '2026-13-99'" is. Assume the
  reader is new and tired.
- **README is the contract.** If it says one-liner install, that has
  to work on a fresh machine. If it claims a feature, the feature
  exists.

### Open a PR, never push to main

Always branch and PR. One change per PR. Conventional commit subject
(`<type>(<scope>): <subject>`) and a body that explains the *why*; the
diff explains the *what*. When an AI agent meaningfully contributed,
include a `Co-Authored-By:` trailer — don't be sneaky about who wrote
the code. Never `--force` push to `main` or `master`, ever; other
long-lived branches only with explicit owner authorisation in the same
conversation.

### Tests are part of the change

Bug fix? Write a regression test first that fails, then make it pass.
New behaviour? It has tests. Trivial doesn't exempt it. Test names
describe behaviour, not function names — `"off the record ends the
attached session within one turn"` beats `"test_handler_3"`. Flakey
tests are bugs; don't paper over with retries.

### Never commit secrets

Tokens, API keys, passwords — they live in environment variables or
the user's secret store, never in code, tests, fixtures, or commit
messages. Bearer tokens never appear in stderr, log files, error
responses, or telemetry. `redirect: "error"` on every outbound HTTPS
call that carries credentials, so a 3xx can't leak the token
cross-origin.

### Don't touch what you don't understand

Comments that say "this is here because of X," tests asserting
non-obvious invariants, ostensibly-dead code with a `// HACK:` or
`// race:` nearby — read them twice. Most of the surprising code in
this family exists because of a real race or a real exploit. Verify
with the human before deleting "obvious dead code."

### When unsure, ask

You don't get points for confidence. You get points for being right.
Surface trade-offs instead of guessing: *"option A is faster but
loses event ordering on a crash; option B is durable but slower —
which matters here?"* Asking makes you a better collaborator, not
a worse one.

## 3. Build, test, verify

```sh
npm install
npm test
npm run validate    # manifest + hooks + bundle shape
npm run build       # esbuild → bin/librarian-claude-hook.js + bin/librarian-mcp-call.js
npm run smoke
```

## 4. Gotchas (repo-specific)

- **`bin/*.js` ARE committed; bundles ship to users directly.** Always
  rebuild before committing source changes.
- **Per-verb slash-command files live in `commands/`.** Adding a verb
  means adding a markdown file here AND updating the canonical
  contract in `the-librarian/docs/slash-commands.md` in a coordinated
  pair of PRs (per §2: contracts are sacred).
- **`hooks/hooks.json` uses `${CLAUDE_PLUGIN_ROOT}`** — Claude doesn't
  expose the generic `${PLUGIN_ROOT}` alias that Codex does.
- **Hook stdout is protocol.** Don't `console.log` from a handler.
