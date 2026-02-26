# Strata

Structural editing plugin for Claude Code. Intercepts Read and Edit tool calls via hooks to reduce context consumption through entropy-guided structural outlines, content-addressable line references, and cross-file dependency detection.

## Techniques

### Entropy-guided structural outlines

Instead of dumping full file contents into context, Strata serves a compressed structural outline — a map of the file where every node is tagged with a content-addressable coordinate. A 1,274-line file becomes ~30 lines of outline.

```
views.py [1274 lines]
  connections: → models.py, ← schemas.py, ↔ listing_service.py
  ---
  [1-15] 1#SZN:from django.views import View
  [16-89] 16#KKV:class ListingListView(View):
  [90-156] 90#TXR:class ListingDetailView(View):
  [157-290] 8 similar regions
    sample: 157#WBR:class SnapshotView(View):
```

Outlines are built by recursively subdividing the file at structural boundaries, analogous to Binary Space Partitioning. Four boundary signals are tried in priority order:

1. **Blank lines at bracket depth 0** — well-formatted C-family code, PEP 8 Python
2. **Bracket/tag depth returns to 0** — dense code, minified JS, XML/HTML tag boundaries
3. **Significant dedent** — indent-significant languages (Python, YAML, Lua)
4. **Shannon entropy gradient** — fallback for files where none of the above apply. Finds where the information content of the text changes most between adjacent lines.

No parser, no AST, no language grammar. Works on TypeScript, Python, C++, XML, HTML, CSS, SQL, YAML — anything with text.

### Similarity collapse

Consecutive sibling nodes are compared via Jaccard similarity on character trigrams. Runs of 3+ similar siblings collapse into a single representative node. 26,000 lines of C++ with 60 repetitive class definitions become 3 nodes and 167 characters — 99.98% compression.

### Hashline coordinate edits

Instead of reproducing existing code to identify what to replace, the agent references lines by coordinate — `42#VRK:` is 7 characters instead of ~70 characters of reproduced code. The hook resolves coordinates to file content transparently, verifies hashes against the current file, searches ±3 lines for shifted content, and applies edits bottom-up to avoid index drift.

### Cross-file TF-IDF indexing

A session-scoped TF-IDF index tracks tokens extracted from structural nodes. Definition sites (node headers) vs. usage sites (node bodies) determine connection direction. Outline headers show directional dependencies between files without a language server, import parser, or build system.

### Two modes

- **Mode 1 (>= 300 lines):** First read returns a structural outline. Edits use hashline coordinates.
- **Mode 2 (100-299 lines):** First read passes through normally. Repeat reads serve the outline — the agent already has full content in context, so the outline prevents paying for the same file twice.

## Install

Requires Node.js 22+ and Claude Code.

```bash
git clone https://github.com/noopz/strata.git
cd strata
npm install
npm run build
```

### Configure Claude Code

Copy the example settings and update paths to point to your clone:

```bash
cat hooks/claude-code-settings.example.json
```

Add the hooks and MCP server entries to your project's `.claude/settings.local.json`, replacing `/absolute/path/to/strata` with the actual path to your clone.

The hooks register on:
- **PreToolUse: Read** — serves structural outlines for large files
- **PreToolUse: Edit** — strips hashline tags and resolves coordinates
- **PostToolUse: Edit|Write** — invalidates outline cache after modifications

The MCP server provides `structural_edit`, `structural_expand`, and `structural_analyze` tools.

## Build & test

```bash
npm run build              # TypeScript → dist/
npm test                   # Unit tests
node scripts/smoke-test-hooks.cjs  # End-to-end hook pipeline test
```

## License

MIT
