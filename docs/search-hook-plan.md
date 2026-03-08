# Structurally-Annotated Search (Grep/Bash Hook)

## Problem

When an agent greps for `handleAuth`, it gets raw ripgrep output:

```
src/auth.ts:56:  handleAuth(req: Request): Response {
src/routes.ts:131:    app.post('/login', auth.handleAuth);
```

The agent knows *which files* matched but not *where in the file's structure* each match lives. To understand context it has to read each file — often the full file — burning context on code unrelated to the match.

## Goal

Return search results annotated with structural context from cached outlines:

```
src/auth.ts [420 lines]
  [42-89] 56:class AuthHandler
    [56] handleAuth(req: Request): Response       ← match
    [67] validateToken(token: string): boolean

src/routes.ts [380 lines]
  [120-145] 131:function setupRoutes(app)
    [131] app.post('/login', auth.handleAuth)      ← match
```

The agent immediately sees the containing class/function, the line range for a targeted read, and sibling definitions — without reading the file.

## Architecture

### What already exists

- **Structural analyzer** (`src/structural-analyzer.ts`) — produces a `StructuralTree` for any file, language-agnostic
- **Cross-file index** (`src/cross-file-index.ts`) — tracks tokens across files, finds connections
- **Formatter** (`src/formatter.ts`) — renders `StructuralTree` + connections as line-numbered outlines
- **Cache system** — outlines cached at `.strata/{sha256(path)}-{mtime}-v2.txt`, keyed by mtime
- **Hook wiring** — `hooks.json` already has Grep and Bash matchers (currently pointing at dead-code `.sh` scripts)
- **Hook scripts** — `pre-grep.sh` / `pre-bash.sh` already parse pattern/path/glob from tool input; `pre-bash.sh` has a working grep/rg command tokenizer

### What needs to be built

One new module: `src/search.ts` (or `src/search-cli.ts`). Everything else exists.

## Design

### Core function

```ts
export function structuralSearch(
  pattern: string,
  searchPath: string,
  options?: { glob?: string; maxResults?: number }
): string
```

### Steps

1. **Run the actual search.** Shell out to `rg` (ripgrep) with `--json` output for structured results. Fall back to a basic `rg` parse or Node regex scan if `--json` isn't available. Limit results (default ~50 matches) to avoid blowing up output.

2. **Group matches by file.** Collect `{ file, line, matchText }` tuples, grouped by file path.

3. **Load or generate outlines.** For each matched file:
   - Check the `.strata` cache for an existing outline (`{hash}-{mtime}-v2.txt`)
   - If cache miss, call `generateOutline(filePath)` (already exported from `analyze-cli.ts`)
   - Parse the outline back into a structural tree, OR use the in-memory tree directly if generating fresh

4. **Locate each match in the tree.** Walk the `StructuralTree` to find the deepest `StructuralNode` containing each match's line number. This gives the containing function/class/block.

5. **Render annotated results.** For each file with matches:
   - File header: `path [N lines]`
   - For each match, show: the containing node's range and label, plus the match line
   - Include sibling nodes at the same level (collapsed to one-liners) so the agent sees what's nearby

### Output format

```
src/auth.ts [420 lines]
  [42-89] 42:class AuthHandler
    > [56] handleAuth(req: Request): Response
    [67] validateToken(token: string): boolean
    [78] refreshSession(sid: string): void

src/routes.ts [380 lines]
  [120-145] 120:function setupRoutes(app)
    > [131] app.post('/login', auth.handleAuth)
```

- `>` marks matching lines
- Containing node shown with `[start-end]` range — agent knows exactly what offset/limit to use
- Sibling nodes shown so the agent sees neighboring structure without a separate read

### Hook behavior

The hooks use `deny` + `additionalContext` (not `updatedInput`). This suppresses the native Grep/Bash result and replaces it entirely with the annotated output. This is the right approach — the annotated results are a strict superset of what raw grep returns.

Passthrough (`{}`) when:
- `search.ts` not built / import fails
- Pattern is empty
- No results found (let native tool report "no matches")
- Search errors out

### Key decisions

**Use ripgrep, not Node regex.** Ripgrep handles `.gitignore`, binary detection, and is fast on large trees. The agent already has `rg` available (Claude Code bundles it). Use `--json` for structured output to avoid parsing human-readable format.

**Cap results.** Without a cap, `grep -r "import"` returns thousands of matches and the annotated output would be enormous. Default to ~50 matches (`rg --max-count` or post-filter). The agent can narrow the search pattern if it needs more specificity.

**Don't cache search results.** Outlines are cached (and that's where the real cost is). Search result assembly is cheap once outlines exist. Caching search results adds complexity for minimal gain since patterns are rarely repeated.

**Tree lookup, not re-analysis.** Walk the existing `StructuralTree` to find containing nodes rather than re-analyzing the file. The tree already has `startLine`/`endLine` on every node — a simple recursive descent finds the deepest container.

## File plan

### New files

- `src/search.ts` — `structuralSearch()` function and tree-walking logic
- `src/search.test.ts` — unit tests

### Modified files

- `hooks/pre-grep.js` (or `.sh` on main) — import and call `structuralSearch()` instead of shelling out to a nonexistent `search-cli.js`
- `hooks/pre-bash.js` (or `.sh` on main) — same
- `hooks/hooks.json` — already wired, no changes needed

### No changes needed

- `src/structural-analyzer.ts` — already produces the trees
- `src/analyze-cli.ts` — already exports `generateOutline()`
- `src/formatter.ts` — search results use their own renderer (different format from outlines)
- `src/types.ts` — existing `StructuralNode` / `StructuralTree` types suffice

## Implementation sequence

1. Write `src/search.ts` with `structuralSearch()`
2. Write `src/search.test.ts` — test tree lookup, result grouping, annotation format
3. `npm run build && npm test`
4. Update `pre-grep.js` to import `structuralSearch()` directly
5. Update `pre-bash.js` to import `structuralSearch()` directly
6. Smoke test: grep for a known symbol in a project with 300+ line files, verify annotated output
7. Test passthrough: grep with no results, verify native Grep handles it

## Open questions

- **Result limit:** 50 matches? Configurable via env var? The right number depends on how much context the agent can absorb per tool call.
- **Sibling depth:** Show all siblings of the containing node, or just the node itself? More siblings = more context but more output. Could be adaptive based on tree size.
- **Files without outlines:** For files under the 300-line threshold (no cached outline), should we generate one on-demand for search annotation, or just return raw matches for those files? Generating is cheap but adds latency for many small-file matches.

---

## Adversarial Review (2026-03-07) — Plan Rejected

Three adversarial reviews identified fundamental problems with this approach. The hook scripts and hooks.json entries have been removed.

### The deny/suppress approach breaks agent workflows

The "strict superset" claim is false. The hook ignores Grep `output_mode` (count, files_with_matches), silently drops search flags (`-i`, `-w`, `-F`, `-v`, `-c`, `-l`), and cannot reproduce context lines (`-A`/`-B`/`-C`). The agent gets different search semantics than it requested. The `deny` mechanism may also confuse the agent into retrying or falling back to Bash grep.

### The economics are inverted

The Read hook compresses a large cost center (69% of session context) from ~6,400 chars to ~2,000 chars. The search hook does the opposite — it inflates a small cost center (6% of context) from ~55 chars/match to ~180-250 chars/match (3-5x increase). Under realistic assumptions, the feature increases total context by 5-10%.

### Redundant with the Read hook

The typical workflow is: grep → read file → edit. The Read hook already serves structural outlines on untargeted reads. The search hook front-loads the same structural information at the grep step, but the agent still needs to read the file before editing. Net result: the annotated grep output (~3,500 chars) plus a targeted read (~2,000 chars) costs more than raw grep (~550 chars) plus an outline read (~2,000 chars) plus a targeted read (~2,000 chars).

### Bash hook adds latency with no payoff

The Bash hook fires on every Bash command. Its tokenizer is incomplete (no backslash escape handling). The 50-result cap combined with deny creates silent data loss for refactoring tasks where the agent needs all matches.
