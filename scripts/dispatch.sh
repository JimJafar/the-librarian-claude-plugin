#!/usr/bin/env bash
# Librarian lifecycle dispatch — the command every hook event runs.
#
# NEVER blocks or pollutes the prompt: it always exits 0 and never writes to
# stdout (UserPromptSubmit stdout would be injected into the model's context).
# The hook event JSON arrives on stdin and is passed straight to the bundled bin.
#
# The bundled hook bin spawns the mcp-call helper; its import.meta-relative default
# is wrong inside an esbuild bundle, so we point it at the sibling bundled helper.

[ -n "${CLAUDE_PLUGIN_ROOT:-}" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

export LIBRARIAN_MCP_CALL_BIN="${CLAUDE_PLUGIN_ROOT}/bin/librarian-mcp-call.js"

# stdout → /dev/null (defense in depth); stderr is left for the transcript so a
# real misconfiguration (e.g. a missing token) is visible. Never fail the hook.
node "${CLAUDE_PLUGIN_ROOT}/bin/librarian-claude-hook.js" >/dev/null || true
exit 0
