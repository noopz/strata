#!/usr/bin/env bash
# PreToolUse hook for Claude Code — intercepts Read tool calls.
#
# Mode 1 (untargeted): file >= LINE_THRESHOLD, no offset/limit
#   → redirect to cached structural outline via updatedInput
# Mode 2 (repeat reads): file REPEAT_THRESHOLD to LINE_THRESHOLD-1
#   → first untargeted read passes through, subsequent reads serve outline
# Targeted reads and small files pass through unmodified.

set -euo pipefail

LINE_THRESHOLD=300        # Mode 1: always structural outline
REPEAT_THRESHOLD=100      # Mode 2: outline on repeat reads
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANALYZER_CLI="${SCRIPT_DIR}/../dist/analyze-cli.js"

# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

# Read JSON input from stdin
INPUT=$(cat)

# Extract file_path, offset, limit from the tool input (one per line)
{
    read -r FILE_PATH || true
    read -r OFFSET || true
    read -r LIMIT || true
} < <(printf '%s' "$INPUT" | node -e "
const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
const ti=d.tool_input||d;
console.log(ti.file_path||'');
console.log(ti.offset??'');
console.log(ti.limit??'');
" 2>/dev/null || printf '\n\n\n')

# If we couldn't extract a file path, pass through
if [ -z "$FILE_PATH" ] || [ ! -f "$FILE_PATH" ]; then
    echo '{}'
    exit 0
fi

# Resolve to absolute path for consistent cache keys
FILE_PATH="$(cd "$(dirname "$FILE_PATH")" && pwd)/$(basename "$FILE_PATH")"

# Cache in .strata/ inside the project root
PROJECT_ROOT="$(get_project_root "$(dirname "$FILE_PATH")")"
CACHE_DIR="${PROJECT_ROOT}/.strata"

# Count lines
LINE_COUNT=$(wc -l < "$FILE_PATH" | tr -d ' ')

# --- Set up cache key (shared by all modes) ---
mkdir -p "$CACHE_DIR"
FILE_HASH=$(echo -n "$FILE_PATH" | { shasum -a 256 2>/dev/null || sha256sum 2>/dev/null; } | cut -d' ' -f1)
FILE_MTIME=$(stat -f %m "$FILE_PATH" 2>/dev/null || stat -c %Y "$FILE_PATH" 2>/dev/null || echo "0")
CACHE_FORMAT_VERSION=2
CACHE_FILE="${CACHE_DIR}/${FILE_HASH}-${FILE_MTIME}-v${CACHE_FORMAT_VERSION}.txt"
SEEN_MARKER="${CACHE_DIR}/${FILE_HASH}-${FILE_MTIME}-seen"

# --- Targeted read (offset present) → passthrough with optional context ---
# Never redirect targeted reads via updatedInput — that breaks Claude Code's
# read-tracking and prevents subsequent Edit calls on the original file.
if [ -n "$OFFSET" ] && [[ "$OFFSET" =~ ^[0-9]+$ ]]; then
    # Large files with an existing outline: remind about hashline editing
    if [ "$LINE_COUNT" -ge "$LINE_THRESHOLD" ] && [ -f "$CACHE_FILE" ]; then
        _strata_log hook pre-read decision passthrough_targeted_ctx file "$FILE_PATH" lines "$LINE_COUNT" offset "$OFFSET"
        cat <<ENDJSON
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "additionalContext": "This file has a structural outline. For focused reads and edits, use structural_expand <range> — returns hashline-tagged content for structural_edit."
  }
}
ENDJSON
        exit 0
    fi
    _strata_log hook pre-read decision passthrough_targeted file "$FILE_PATH" lines "$LINE_COUNT"
    echo '{}'
    exit 0
fi

# --- Small file (< REPEAT_THRESHOLD) → always passthrough ---
if [ "$LINE_COUNT" -lt "$REPEAT_THRESHOLD" ]; then
    _strata_log hook pre-read decision passthrough_small file "$FILE_PATH" lines "$LINE_COUNT"
    echo '{}'
    exit 0
fi

# --- Mode 2: Mid-size file (REPEAT_THRESHOLD to LINE_THRESHOLD-1) ---
if [ "$LINE_COUNT" -lt "$LINE_THRESHOLD" ]; then
    # First untargeted read → mark as seen, passthrough
    if [ ! -f "$SEEN_MARKER" ]; then
        touch "$SEEN_MARKER"
        _strata_log hook pre-read decision passthrough_first_read file "$FILE_PATH" lines "$LINE_COUNT"
        echo '{}'
        exit 0
    fi
    # Repeat read → fall through to outline generation with repeat context
    CONTEXT_PREFIX="Previously read in full. Outline of"
    CONTEXT_SUFFIX='for reference. Labels are hashline-tagged — to edit: structural_expand <range> then structural_edit.'
fi

# --- Mode 1: Large file (>= LINE_THRESHOLD) ---
# Check if agent already received an outline for this file — if so, passthrough
OUTLINED_MARKER="${CACHE_DIR}/${FILE_HASH}-${FILE_MTIME}-outlined"

if [ -z "${CONTEXT_PREFIX:-}" ] && [ -f "$OUTLINED_MARKER" ]; then
    # Agent already saw the outline — serve full content with context reminder
    _strata_log hook pre-read decision passthrough_already_outlined file "$FILE_PATH" lines "$LINE_COUNT"
    cat <<ENDJSON
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "additionalContext": "Full content below. A structural outline was previously served for this file. For focused reads and edits, use structural_expand <range> then structural_edit."
  }
}
ENDJSON
    exit 0
fi

# Mode 1 default context (first untargeted read of large file)
if [ -z "${CONTEXT_PREFIX:-}" ]; then
    touch "$OUTLINED_MARKER"
    CONTEXT_PREFIX="Structural outline of"
    CONTEXT_SUFFIX='Use structural_expand to read any section — returns content with hashline tags for structural_edit. Only use Read with offset/limit if you need untagged content. Labels are hashline-tagged (e.g. 42#ABC:content).'
fi

# --- Generate and serve outline ---
CACHE_HIT=true
if [ ! -f "$CACHE_FILE" ]; then
    CACHE_HIT=false
    if [ -f "$ANALYZER_CLI" ]; then
        node "$ANALYZER_CLI" "$FILE_PATH" > "$CACHE_FILE" 2>/dev/null || {
            rm -f "$CACHE_FILE"
            _strata_log hook pre-read decision passthrough_outline_failed file "$FILE_PATH" lines "$LINE_COUNT" cache_hit false
            echo '{}'
            exit 0
        }
    else
        _strata_log hook pre-read decision passthrough_no_analyzer file "$FILE_PATH" lines "$LINE_COUNT"
        echo '{}'
        exit 0
    fi
fi

# Verify cache file was created and has content
if [ ! -s "$CACHE_FILE" ]; then
    rm -f "$CACHE_FILE"
    _strata_log hook pre-read decision passthrough_empty_outline file "$FILE_PATH" lines "$LINE_COUNT" cache_hit false
    echo '{}'
    exit 0
fi

# Determine outline decision name
if [ "$LINE_COUNT" -lt "$LINE_THRESHOLD" ]; then
    DECISION="outline_repeat"
else
    DECISION="outline_always"
fi

_strata_log hook pre-read decision "$DECISION" file "$FILE_PATH" lines "$LINE_COUNT" cache_hit "$CACHE_HIT"

FILE_BASENAME=$(basename "$FILE_PATH")
BASENAME_ESCAPED=$(printf '%s' "$FILE_BASENAME" | node -e "
process.stdout.write(JSON.stringify(require('fs').readFileSync(0,'utf8')).slice(1,-1));
" 2>/dev/null || printf '%s' "$FILE_BASENAME")

cat <<ENDJSON
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "updatedInput": {
      "file_path": "${CACHE_FILE}"
    },
    "additionalContext": "${CONTEXT_PREFIX} ${BASENAME_ESCAPED} (${LINE_COUNT} lines). ${CONTEXT_SUFFIX}"
  }
}
ENDJSON
