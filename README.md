# the-librarian-claude-plugin

A [Claude Code](https://claude.com/claude-code) **plugin** for
[The Librarian](https://github.com/JimJafar/the-librarian) — durable memory + cross-harness
session lifecycle, backed by a **remote** Librarian MCP server.

> Status: scaffolding in progress. Full install/usage docs land with the plugin manifest,
> commands, hooks, and bundled artifacts.

## Bundled artifacts (do not hand-edit)

`bin/librarian-claude-hook.js` and `bin/librarian-mcp-call.js` are **generated** esbuild
bundles of [`@librarian/lifecycle`](https://github.com/JimJafar/the-librarian) — they are the
plugin's distributable, committed to the repo. Do not edit them by hand; regenerate with:

```sh
npm run build   # needs a sibling the-librarian checkout, or set LIBRARIAN_MONOREPO
```

`bin/PROVENANCE.json` records the source revision + a hash of each bundle; CI fails if a
committed bin no longer matches its recorded hash (drift guard).

## License

Apache-2.0.
