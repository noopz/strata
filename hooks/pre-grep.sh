#!/usr/bin/env bash
# PreToolUse hook for Claude Code — intercepts Grep tool calls.
#
# Runs search-cli.js to generate structurally-annotated results.
# Uses deny + additionalContext to suppress native Grep and return
# annotated results as sole output.
#
# Passthrough ({}): if search-cli not built, pattern empty, or errors.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEARCH_CLI="${SCRIPT_DIR}/../dist/search-cli.js"

# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

# If CLI not built, passthrough
if [ ! -f "$SEARCH_CLI" ]; then
    echo '{}'
    exit 0
fi

# Read JSON input from stdin
INPUT=$(cat)

# Extract pattern, path, glob (one per line)
{
    read -r PATTERN || true
    read -r SEARCH_PATH || true
    read -r GLOB_PAT || true
} < <(printf '%s' "$INPUT" | node -e "
const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
const ti=d.tool_input||d;
console.log(ti.pattern||'');
console.log(ti.path||'');
console.log(ti.glob||'');
" 2>/dev/null || printf '\n\n\n')

# Compute CACHE_DIR for logging
if [ -n "$SEARCH_PATH" ] && [ -d "$SEARCH_PATH" ]; then
    PROJECT_ROOT="$(get_project_root "$SEARCH_PATH")"
elif [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
    PROJECT_ROOT="$CLAUDE_PROJECT_DIR"
else
    PROJECT_ROOT="$(get_project_root "$(pwd)")"
fi
CACHE_DIR="${PROJECT_ROOT}/.strata"

# If pattern is empty, passthrough
if [ -z "$PATTERN" ]; then
    _strata_log hook pre-grep decision passthrough_no_pattern
    echo '{}'
    exit 0
fi

# Build search-cli args
SEARCH_ARGS=("$SEARCH_CLI" "$PATTERN")
if [ -n "$SEARCH_PATH" ]; then
    SEARCH_ARGS+=("$SEARCH_PATH")
else
    SEARCH_ARGS+=(".")
fi
if [ -n "$GLOB_PAT" ]; then
    SEARCH_ARGS+=("$GLOB_PAT")
fi

# Run search-cli
RESULTS=$(node "${SEARCH_ARGS[@]}" 2>/dev/null) || {
    _strata_log hook pre-grep decision passthrough_cli_error pattern "$PATTERN"
    echo '{}'
    exit 0
}

# If no results, passthrough to let native Grep report "no matches"
if [ -z "$RESULTS" ]; then
    _strata_log hook pre-grep decision passthrough_no_results pattern "$PATTERN"
    echo '{}'
    exit 0
fi

# Escape for JSON
RESULTS_ESCAPED=$(printf '%s' "$RESULTS" | node -e "
process.stdout.write(JSON.stringify(require('fs').readFileSync(0,'utf8')).slice(1,-1));
" 2>/dev/null || echo "")

if [ -z "$RESULTS_ESCAPED" ]; then
    _strata_log hook pre-grep decision passthrough_escape_error pattern "$PATTERN"
    echo '{}'
    exit 0
fi

# Escape pattern for safe JSON embedding
PATTERN_ESCAPED=$(printf '%s' "$PATTERN" | node -e "
process.stdout.write(JSON.stringify(require('fs').readFileSync(0,'utf8')).slice(1,-1));
" 2>/dev/null || echo "pattern")

_strata_log hook pre-grep decision annotated_results pattern "$PATTERN"

cat <<ENDJSON
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Results provided with structural context annotations below.",
    "additionalContext": "Search results for ${PATTERN_ESCAPED}:\\n\\n${RESULTS_ESCAPED}"
  }
}
ENDJSON
