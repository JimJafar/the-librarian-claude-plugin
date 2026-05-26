# Contributing

## Bundled artifacts

`bin/librarian-claude-hook.js` and `bin/librarian-mcp-call.js` are **generated**
esbuild bundles of [`@librarian/lifecycle`](https://github.com/JimJafar/the-librarian)
— the plugin's distributable, committed to the repo. Do not edit them by hand;
regenerate with:

```sh
npm install
npm run build   # needs a sibling the-librarian checkout, or set LIBRARIAN_MONOREPO
```

`bin/PROVENANCE.json` records the source revision + a hash of each bundle; CI
fails if a committed bin no longer matches its recorded hash (a drift guard).

## Why env vars (not the plugin install prompt)

Claude Code's `userConfig` reliably feeds `.mcp.json` but **not** a hook
subprocess. Env vars are the one source both the MCP server config and the hooks
can read, so `LIBRARIAN_MCP_URL` + `LIBRARIAN_AGENT_TOKEN` live in the shell
profile rather than in the plugin manifest.

## Local checks

```sh
npm install
npm run validate   # manifests, hooks shape, bundle provenance
npm run smoke      # runs the bundled bins + dispatch.sh against a fake /mcp
```
