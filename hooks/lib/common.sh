#!/usr/bin/env bash
# Shared utilities for strata hooks.

# Ensure node is on PATH. Hooks run in non-interactive shells where version
# managers (fnm, nvm, volta) haven't initialized. Check common locations.
if ! command -v node &>/dev/null; then
    for candidate in \
        "${HOME}/.local/share/fnm/aliases/default/bin" \
        "${HOME}/.fnm/aliases/default/bin" \
        "${HOME}/.nvm/versions/node/$(cat "${HOME}/.nvm/alias/default" 2>/dev/null || true)/bin" \
        "${HOME}/.volta/bin" \
        "/usr/local/bin" \
        "/opt/homebrew/bin"; do
        if [ -x "${candidate}/node" ]; then
            export PATH="${candidate}:${PATH}"
            break
        fi
    done
fi

# Get the project root directory.
# Primary: $CLAUDE_PROJECT_DIR (set by Claude Code for hooks and child processes)
# Fallback: walk up from a path looking for project markers
# Last resort: cwd (Claude Code runs hooks from the project directory)
get_project_root() {
    if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
        echo "$CLAUDE_PROJECT_DIR"
        return
    fi
    local dir="$1"
    while [ "$dir" != "/" ]; do
        for marker in .git package.json pyproject.toml Cargo.toml go.mod; do
            if [ -e "$dir/$marker" ]; then
                echo "$dir"
                return
            fi
        done
        dir="$(dirname "$dir")"
    done
    pwd
}

# Append a JSONL log entry to $CACHE_DIR/hook.log.
# Usage: _strata_log key1 val1 key2 val2 ...
# Requires CACHE_DIR to be set. Silently no-ops if unset or on error.
_strata_log() {
    [ -z "${CACHE_DIR:-}" ] && return 0
    mkdir -p "$CACHE_DIR" 2>/dev/null || return 0
    STRATA_LOG_FILE="${CACHE_DIR}/hook.log" node -e "
        const fs = require('fs');
        const entry = { ts: new Date().toISOString() };
        const args = process.argv.slice(1);
        for (let i = 0; i < args.length; i += 2) {
            const k = args[i], v = args[i+1];
            entry[k] = /^\d+$/.test(v) ? Number(v) : v === 'true' ? true : v === 'false' ? false : v;
        }
        fs.appendFileSync(process.env.STRATA_LOG_FILE, JSON.stringify(entry) + '\n');
    " "$@" 2>/dev/null || true
}
