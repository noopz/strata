#!/usr/bin/env bash
# PreToolUse hook for Claude Code — intercepts Edit tool calls.
#
# Detects hashline tags in old_string/new_string and strips them,
# verifying hashes against the actual file content.
#
# Passthrough ({}): if CLI not built, no hashlines detected, or CLI errors.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EDIT_HOOK_CLI="${SCRIPT_DIR}/../dist/edit-hook-cli.js"

# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

# If CLI not built, passthrough
if [ ! -f "$EDIT_HOOK_CLI" ]; then
    # Can't log — no FILE_PATH yet to compute CACHE_DIR
    echo '{}'
    exit 0
fi

# Read JSON input from stdin, extract file_path and CLI input in one node call
INPUT=$(cat)

{
    read -r FILE_PATH || true
    # Rest is CLI_INPUT (may be empty)
    CLI_INPUT=$(cat) || true
} < <(printf '%s' "$INPUT" | node -e "
const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
const ti=d.tool_input||d;
console.log(ti.file_path||'');
process.stdout.write(JSON.stringify({
  file_path:ti.file_path||'',
  old_string:ti.old_string||'',
  new_string:ti.new_string||''
}));
" 2>/dev/null || printf '\n')

# Compute CACHE_DIR for logging if we have a file path
if [ -n "$FILE_PATH" ] && [ -f "$FILE_PATH" ]; then
    PROJECT_ROOT="$(get_project_root "$(dirname "$FILE_PATH")")"
    CACHE_DIR="${PROJECT_ROOT}/.strata"
fi

if [ -z "$CLI_INPUT" ]; then
    _strata_log hook pre-edit decision passthrough_no_input file "${FILE_PATH:-}"
    echo '{}'
    exit 0
fi

# Call the edit hook CLI
RESULT=$(printf '%s' "$CLI_INPUT" | node "$EDIT_HOOK_CLI" 2>/dev/null) || {
    _strata_log hook pre-edit decision passthrough_cli_error file "${FILE_PATH:-}"
    echo '{}'
    exit 0
}

if [ -z "$RESULT" ]; then
    _strata_log hook pre-edit decision passthrough_empty_result file "${FILE_PATH:-}"
    echo '{}'
    exit 0
fi

# Determine if hashlines were resolved by checking for hookSpecificOutput
if printf '%s' "$RESULT" | node -e "
const r=JSON.parse(require('fs').readFileSync(0,'utf8'));
process.exit(r.hookSpecificOutput ? 0 : 1);
" 2>/dev/null; then
    _strata_log hook pre-edit decision hashline_resolved file "${FILE_PATH:-}" hashlines true
else
    _strata_log hook pre-edit decision passthrough_no_hashlines file "${FILE_PATH:-}"

    # Check if a cached outline exists for this file — if so, nudge toward structural_edit
    if [ -n "$FILE_PATH" ] && [ -f "$FILE_PATH" ] && [ -n "${CACHE_DIR:-}" ]; then
        ABS_PATH="$(cd "$(dirname "$FILE_PATH")" && pwd)/$(basename "$FILE_PATH")"
        EDIT_FILE_HASH=$(echo -n "$ABS_PATH" | { shasum -a 256 2>/dev/null || sha256sum 2>/dev/null; } | cut -d' ' -f1)
        # Check for any cache file with this hash prefix (any mtime/version), excluding -seen markers
        HAS_OUTLINE=false
        if [ -d "$CACHE_DIR" ]; then
            for f in "${CACHE_DIR}/${EDIT_FILE_HASH}"-*; do
                [ -f "$f" ] || continue
                case "$f" in *-seen) continue;; esac
                HAS_OUTLINE=true
                break
            done
        fi
        if [ "$HAS_OUTLINE" = true ]; then
            _strata_log hook pre-edit decision passthrough_outline_nudge file "${FILE_PATH:-}"
            cat <<ENDJSON
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "additionalContext": "This file has a structural outline. For precise edits: structural_expand <range> to get hashline tags, then structural_edit."
  }
}
ENDJSON
            exit 0
        fi
    fi
fi

printf '%s\n' "$RESULT"
