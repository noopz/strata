#!/usr/bin/env bash
# SessionStart hook — primes the agent with outline awareness.
# Fires on startup, resume, /clear, and after compaction.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

# Extract source from stdin (startup, resume, clear, compact)
INPUT=$(cat)
SOURCE=$(printf '%s' "$INPUT" | node -e "
const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
console.log(d.source||'unknown');
" 2>/dev/null || echo "unknown")

PROJECT_ROOT="$(get_project_root "$(pwd)")"
CACHE_DIR="${PROJECT_ROOT}/.strata"
_strata_log hook session-start decision context_injected source "$SOURCE"

# JSON-escape the context string via node, reading from stdin to avoid
# path-interpolation and encoding issues with temp files.
ESCAPED=$(node -e "
const text = \`Strata structural outlines are active for large files (300+ lines).

How it works: Reading a large file without offset/limit returns a structural outline -- a compressed map of the file structure. Reading with any offset/limit always returns actual code, bypassing the outline.

Exploring or navigating: Read without offset/limit to get the outline. This shows structure, line ranges, and cross-file connections without consuming the full file. Example outline:

  views.py [1274 lines]
    connections: -> models.py, <- schemas.py
    ---
    [1-15] 1:from django.views import View
    [16-89] 16:class ListingListView(View):
    [90-156] 90:class ListingDetailView(View):

Preparing to edit: Read with offset=1, limit=2000 to get the full file directly, skipping the outline. This is what you would normally do before editing.

You choose the mode per read based on your intent.\`;
process.stdout.write(JSON.stringify(text).slice(1, -1));
" 2>/dev/null) || {
  echo '{}'
  exit 0
}

printf '{\n  "hookSpecificOutput": {\n    "hookEventName": "SessionStart",\n    "additionalContext": "%s"\n  }\n}\n' "$ESCAPED"
