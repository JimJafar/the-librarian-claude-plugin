#!/usr/bin/env bash
# Conv-state injection dispatch — memory-domain-isolation §4.9.
#
# Runs alongside `dispatch.sh` on UserPromptSubmit. The hook event JSON
# arrives on stdin and is forwarded to the injection bin. Unlike
# `dispatch.sh`, stdout is FORWARDED to Claude Code: the bin emits a
# `hookSpecificOutput.additionalContext` envelope when there's state to
# inject; otherwise it stays silent. Either way the script exits 0 so a
# Librarian outage never blocks a prompt.

set -u

[ -n "${CLAUDE_PLUGIN_ROOT:-}" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

inject_bin="${CLAUDE_PLUGIN_ROOT}/bin/librarian-conv-state-inject.js"
[ -f "${inject_bin}" ] || exit 0

# Forward stdout (Claude Code reads `additionalContext` from it).
# Forward stderr too — a misconfig surfaces in the transcript exactly
# once, then the bin returns null and stays silent on subsequent calls.
node "${inject_bin}" || true
exit 0
