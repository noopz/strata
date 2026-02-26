#!/usr/bin/env bash
# PostToolUse hook for Claude Code — cache invalidation after Edit/Write.
#
# Calls invalidate-cli.js to delete stale filesystem cache entries
# for the modified file. No additionalContext needed.
#
# Matcher: Edit|Write

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INVALIDATE_CLI="${SCRIPT_DIR}/../dist/invalidate-cli.js"

# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

# If CLI not built, passthrough
if [ ! -f "$INVALIDATE_CLI" ]; then
    # Can't log — no FILE_PATH yet to compute CACHE_DIR
    echo '{}'
    exit 0
fi

# Read JSON input from stdin
INPUT=$(cat)

# Extract file_path from the tool input
FILE_PATH=$(printf '%s' "$INPUT" | node -e "
const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
const ti=d.tool_input||d;
process.stdout.write(ti.file_path||'');
" 2>/dev/null || echo "")

if [ -z "$FILE_PATH" ] || [ ! -f "$FILE_PATH" ]; then
    echo '{}'
    exit 0
fi

# Compute CACHE_DIR for logging
PROJECT_ROOT="$(get_project_root "$(dirname "$FILE_PATH")")"
CACHE_DIR="${PROJECT_ROOT}/.strata"

# Invalidate cache for this file (best effort)
if node "$INVALIDATE_CLI" "$FILE_PATH" 2>/dev/null; then
    _strata_log hook post-edit decision invalidated file "$FILE_PATH"
else
    _strata_log hook post-edit decision invalidate_failed file "$FILE_PATH"
fi

echo '{}'
