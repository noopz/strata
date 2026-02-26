#!/usr/bin/env bash
# PreToolUse hook for Claude Code — intercepts Bash grep/rg commands.
#
# Only intercepts simple grep/rg commands (no pipes, redirects, subshells).
# Uses deny + additionalContext to return structurally-annotated results.
#
# Passthrough ({}): for non-grep commands, piped/complex commands, or errors.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEARCH_CLI="${SCRIPT_DIR}/../dist/search-cli.js"

# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

# Compute CACHE_DIR for logging
if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
    PROJECT_ROOT="$CLAUDE_PROJECT_DIR"
else
    PROJECT_ROOT="$(get_project_root "$(pwd)")"
fi
CACHE_DIR="${PROJECT_ROOT}/.strata"

# If CLI not built, passthrough
if [ ! -f "$SEARCH_CLI" ]; then
    _strata_log hook pre-bash decision passthrough_no_cli
    echo '{}'
    exit 0
fi

# Read JSON input from stdin
INPUT=$(cat)

# Extract command, check if it's a simple grep/rg, parse pattern and path.
# Node outputs two lines: pattern, then search path. Empty lines if not applicable.
{
    read -r GREP_PATTERN || true
    read -r GREP_PATH || true
} < <(printf '%s' "$INPUT" | node -e "
const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
const ti=d.tool_input||d;
const cmd=(ti.command||'').trim();

// Skip empty, complex, or non-grep commands
if(!cmd||/[|><;]|\\\$\(|&&|\x60/.test(cmd)||!/^\s*(grep|rg)\s/.test(cmd)){
  console.log('');console.log('');process.exit(0);
}

// Simple tokenizer
const parts=[];
let cur='',inQ=false,qChar='';
for(let i=0;i<cmd.length;i++){
  const c=cmd[i];
  if(inQ){if(c===qChar)inQ=false;else cur+=c;}
  else if(c==='\"'||c===\"'\"){inQ=true;qChar=c;}
  else if(c===' '||c==='\t'){if(cur){parts.push(cur);cur='';}}
  else cur+=c;
}
if(cur)parts.push(cur);

// Extract pattern and path
let pattern='',searchPath='',skipNext=false,foundPattern=false;
const fv=new Set(['-e','--regexp','-f','--file','-m','--max-count','-A','-B','-C','--context','--glob','-t','--type','--include','--exclude','--color','--colors']);
for(let i=1;i<parts.length;i++){
  if(skipNext){skipNext=false;continue;}
  const a=parts[i];
  if(fv.has(a)){
    if((a==='-e'||a==='--regexp')&&i+1<parts.length){pattern=parts[i+1];foundPattern=true;}
    skipNext=true;continue;
  }
  if(a.startsWith('-'))continue;
  if(!foundPattern){pattern=a;foundPattern=true;}
  else{searchPath=a;}
}
console.log(pattern);
console.log(searchPath);
" 2>/dev/null || printf '\n\n')

# If we couldn't extract a pattern, passthrough (not a grep/rg command or complex pipeline)
if [ -z "$GREP_PATTERN" ]; then
    _strata_log hook pre-bash decision passthrough_not_grep
    echo '{}'
    exit 0
fi

# Build search-cli args
SEARCH_ARGS=("$SEARCH_CLI" "$GREP_PATTERN")
if [ -n "$GREP_PATH" ]; then
    SEARCH_ARGS+=("$GREP_PATH")
else
    SEARCH_ARGS+=(".")
fi

# Run search-cli
RESULTS=$(node "${SEARCH_ARGS[@]}" 2>/dev/null) || {
    _strata_log hook pre-bash decision passthrough_cli_error pattern "$GREP_PATTERN"
    echo '{}'
    exit 0
}

# If no results, passthrough
if [ -z "$RESULTS" ]; then
    _strata_log hook pre-bash decision passthrough_no_results pattern "$GREP_PATTERN"
    echo '{}'
    exit 0
fi

# Escape for JSON
RESULTS_ESCAPED=$(printf '%s' "$RESULTS" | node -e "
process.stdout.write(JSON.stringify(require('fs').readFileSync(0,'utf8')).slice(1,-1));
" 2>/dev/null || echo "")

if [ -z "$RESULTS_ESCAPED" ]; then
    _strata_log hook pre-bash decision passthrough_escape_error pattern "$GREP_PATTERN"
    echo '{}'
    exit 0
fi

# Escape pattern for safe JSON embedding
PATTERN_ESCAPED=$(printf '%s' "$GREP_PATTERN" | node -e "
process.stdout.write(JSON.stringify(require('fs').readFileSync(0,'utf8')).slice(1,-1));
" 2>/dev/null || echo "pattern")

_strata_log hook pre-bash decision annotated_results pattern "$GREP_PATTERN"

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
