#!/usr/bin/env bash
# Librarian lifecycle dispatch — the command every hook event runs.
#
# NEVER blocks or pollutes the prompt: it always exits 0 and never writes to
# stdout (UserPromptSubmit stdout would be injected into the model's context).
# The hook event JSON arrives on stdin and is passed straight to the bundled bin.
#
# The bundled hook bin spawns the mcp-call helper; its import.meta-relative default
# is wrong inside an esbuild bundle, so we point it at the sibling bundled helper.

# set -u (not -e): catch a future unguarded variable, but never let a non-zero
# command abort the hook — the always-exit-0 contract is paramount.
set -u

[ -n "${CLAUDE_PLUGIN_ROOT:-}" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

hook_bin="${CLAUDE_PLUGIN_ROOT}/bin/librarian-claude-hook.js"
# A partial/corrupt install (missing bin) should be silent, not a stderr stack
# trace on every hook event. A real misconfig (e.g. a missing token) still
# surfaces on stderr from the bin itself.
[ -f "${hook_bin}" ] || exit 0

export LIBRARIAN_MCP_CALL_BIN="${CLAUDE_PLUGIN_ROOT}/bin/librarian-mcp-call.js"

# stdout → /dev/null (defense in depth); stderr is left for the transcript so a
# real misconfiguration is visible. Never fail the hook.
node "${hook_bin}" >/dev/null || true
exit 0
