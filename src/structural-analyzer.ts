/**
 * Entropy-guided structural analyzer.
 *
 * Builds a StructuralTree from file content using information-theoretic
 * analysis combined with cheap heuristic signals. NO language-specific parsing.
 *
 * Signals:
 *   1. Intra-line Shannon entropy
 *   2. Inter-line Jaccard similarity on character trigrams
 *   3. Indentation depth (leading whitespace, tabs = 4 spaces)
 *   4. Bracket depth tracking ({[( vs }])
 *
 * Tree is built via recursive subdivision: split at structural boundaries
 * (blank lines at depth 0, bracket-depth returns) or at the largest entropy
 * transition. Consecutive similar siblings are collapsed.
 */

import type { StructuralNode, StructuralTree } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_REGION = 5;
const TAB_WIDTH = 4;
const LABEL_MAX_LEN = 80;
const SIMILARITY_COLLAPSE_THRESHOLD = 0.7;
const MIN_COLLAPSE_RUN = 3;
const ENTROPY_WINDOW = 5;

// ---------------------------------------------------------------------------
// Signal helpers
// ---------------------------------------------------------------------------

/** Shannon entropy of a string's character distribution (bits). */
export function shannonEntropy(line: string): number {
  if (line.length === 0) return 0;
  const freq = new Map<string, number>();
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  const len = line.length;
  let h = 0;
  for (const count of freq.values()) {
    const p = count / len;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Collect character trigrams from a string into a Set. */
function trigrams(line: string): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i <= line.length - 3; i++) {
    s.add(line.substring(i, i + 3));
  }
  return s;
}

/** Jaccard similarity between two trigram sets (0-1). */
export function jaccardSimilarity(a: string, b: string): number {
  const sa = trigrams(a);
  const sb = trigrams(b);
  if (sa.size === 0 && sb.size === 0) return 1; // both empty → identical
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersection = 0;
  for (const t of sa) {
    if (sb.has(t)) intersection++;
  }
  const union = sa.size + sb.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/** Indentation depth in spaces (tabs normalized to TAB_WIDTH). */
export function indentDepth(line: string): number {
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === " ") depth++;
    else if (line[i] === "\t") depth += TAB_WIDTH;
    else break;
  }
  return depth;
}

/** Net bracket depth change for a line: +1 for ({[, -1 for )}]. */
export function bracketDelta(line: string): number {
  let delta = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "{" || ch === "[" || ch === "(") delta++;
    else if (ch === "}" || ch === "]" || ch === ")") delta--;
  }
  return delta;
}

const TAG_OPEN_RE = /^\s*<([a-zA-Z][\w.:_-]*)\b[^/]*>\s*$/;
const TAG_CLOSE_RE = /^\s*<\/([a-zA-Z][\w.:_-]*)\s*>\s*$/;
const TAG_SELF_CLOSE_RE = /^\s*<[a-zA-Z][\w.:_-]*\b[^>]*\/>\s*$/;

/**
 * Net tag depth change for a line: +1 for opening tags, -1 for closing tags.
 * Self-closing tags (<br />) contribute 0.
 * Only fires on lines that are purely a tag (not mixed content like "<p>text</p>").
 */
export function tagDelta(line: string): number {
  if (TAG_SELF_CLOSE_RE.test(line)) return 0;
  if (TAG_CLOSE_RE.test(line)) return -1;
  if (TAG_OPEN_RE.test(line)) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Per-line profiles
// ---------------------------------------------------------------------------

interface LineProfile {
  entropy: number;
  indent: number;
  bracketDelta: number;
  tagDelta: number;
  isBlank: boolean;
}

function computeProfiles(lines: string[]): LineProfile[] {
  return lines.map((line) => ({
    entropy: shannonEntropy(line),
    indent: indentDepth(line),
    bracketDelta: bracketDelta(line),
    tagDelta: tagDelta(line),
    isBlank: line.trim().length === 0,
  }));
}

/** Running bracket depth at each line index (cumulative). */
function runningBracketDepth(
  profiles: LineProfile[],
  start: number,
  end: number,
): number[] {
  const depths: number[] = [];
  let depth = 0;
  for (let i = start; i < end; i++) {
    depth += profiles[i]!.bracketDelta;
    depths.push(depth);
  }
  return depths;
}

/** Running tag depth at each line index (cumulative). */
function runningTagDepth(
  profiles: LineProfile[],
  start: number,
  end: number,
): number[] {
  const depths: number[] = [];
  let depth = 0;
  for (let i = start; i < end; i++) {
    depth += profiles[i]!.tagDelta;
    depths.push(depth);
  }
  return depths;
}

// ---------------------------------------------------------------------------
// Boundary detection
// ---------------------------------------------------------------------------

interface Boundary {
  index: number; // line index (global, within the file)
  score: number; // higher = stronger boundary signal
  isTag?: boolean; // true if generated by tag-depth signal
}

/**
 * Find explicit structural boundaries within [start, end).
 * Returns sorted array of split points (global line indices).
 */
function findExplicitBoundaries(
  profiles: LineProfile[],
  lines: string[],
  start: number,
  end: number,
): Boundary[] {
  const bounds: Boundary[] = [];
  const depths = runningBracketDepth(profiles, start, end);
  const tDepths = runningTagDepth(profiles, start, end);

  for (let i = start; i < end; i++) {
    const localIdx = i - start;
    const prof = profiles[i]!;

    // Blank line at bracket depth 0 → strong boundary
    if (prof.isBlank && depths[localIdx]! <= 0) {
      bounds.push({ index: i, score: 3 });
      continue;
    }

    // Bracket depth returns to 0 from positive
    if (
      localIdx > 0 &&
      depths[localIdx]! <= 0 &&
      depths[localIdx - 1]! > 0
    ) {
      // The boundary is *after* the closing bracket line, so split at i+1
      if (i + 1 < end) {
        bounds.push({ index: i + 1, score: 2 });
      }
      continue;
    }

    // Tag depth drops (closing tag). Fire at any level — the post-filter
    // below removes boundaries that create segments < MIN_REGION lines.
    if (
      localIdx > 0 &&
      prof.tagDelta < 0 &&
      tDepths[localIdx]! < tDepths[localIdx - 1]!
    ) {
      if (i + 1 < end) {
        bounds.push({ index: i + 1, score: 2, isTag: true });
      }
      continue;
    }

    // Indentation decrease after increase (dedent) and at depth 0
    if (
      i > start &&
      prof.indent < profiles[i - 1]!.indent &&
      prof.indent === 0 &&
      !prof.isBlank
    ) {
      bounds.push({ index: i, score: 1 });
    }

    // Significant dedent (drop of 2+ indent levels) even when not at depth 0.
    // Covers YAML, deeply nested markup, and keyword-delimited languages.
    if (
      i > start &&
      !prof.isBlank &&
      prof.indent < profiles[i - 1]!.indent &&
      prof.indent > 0 &&
      (profiles[i - 1]!.indent - prof.indent) >= TAB_WIDTH * 2
    ) {
      bounds.push({ index: i, score: 1 });
    }
  }

  // Deduplicate: keep the highest score for nearby boundaries (within 2 lines)
  bounds.sort((a, b) => a.index - b.index);
  const deduped: Boundary[] = [];
  for (const b of bounds) {
    if (
      deduped.length > 0 &&
      b.index - deduped[deduped.length - 1]!.index <= 2
    ) {
      if (b.score > deduped[deduped.length - 1]!.score) {
        deduped[deduped.length - 1] = b;
      }
    } else {
      deduped.push(b);
    }
  }

  // Post-filter: remove TAG boundaries that create segments smaller than MIN_REGION.
  // This prevents tag-close boundaries from over-splitting (e.g. </metadata>
  // creating 3-line segments inside an <item> block). Non-tag boundaries
  // (blank lines, bracket depth, indentation) are always kept.
  const hasTagBounds = deduped.some((b) => b.isTag);
  if (hasTagBounds) {
    const filtered: Boundary[] = [];
    let prevIdx = start;
    for (const b of deduped) {
      if (!b.isTag) {
        // Always keep non-tag boundaries
        filtered.push(b);
        prevIdx = b.index;
      } else if (b.index - prevIdx >= MIN_REGION) {
        filtered.push(b);
        prevIdx = b.index;
      }
      // else: skip this tag boundary — it would create a too-small segment
    }
    // Also check trailing segment for tag boundaries
    if (
      filtered.length > 0 &&
      filtered[filtered.length - 1]!.isTag &&
      end - filtered[filtered.length - 1]!.index < MIN_REGION
    ) {
      filtered.pop();
    }
    return filtered;
  }

  return deduped;
}

/**
 * Find the largest entropy transition in the region [start, end).
 * Uses a moving-average window to smooth noise.
 * Returns the split index (global), or -1 if no significant transition.
 */
function findEntropyTransition(
  profiles: LineProfile[],
  start: number,
  end: number,
): number {
  const regionLen = end - start;
  if (regionLen < ENTROPY_WINDOW * 2 + 1) return -1;

  // Compute moving average of entropy
  const entropies: number[] = [];
  for (let i = start; i < end; i++) {
    entropies.push(profiles[i]!.entropy);
  }

  const halfWin = Math.floor(ENTROPY_WINDOW / 2);
  const smoothed: number[] = [];
  for (let i = 0; i < entropies.length; i++) {
    const lo = Math.max(0, i - halfWin);
    const hi = Math.min(entropies.length - 1, i + halfWin);
    let sum = 0;
    for (let j = lo; j <= hi; j++) {
      sum += entropies[j]!;
    }
    smoothed.push(sum / (hi - lo + 1));
  }

  // Find largest absolute difference in smoothed entropy
  let maxDiff = 0;
  let maxIdx = -1;
  for (let i = 1; i < smoothed.length; i++) {
    const diff = Math.abs(smoothed[i]! - smoothed[i - 1]!);
    if (diff > maxDiff) {
      maxDiff = diff;
      maxIdx = i;
    }
  }

  // Require a meaningful transition (arbitrary threshold: 0.3 bits)
  if (maxDiff < 0.3) return -1;

  return start + maxIdx;
}

// ---------------------------------------------------------------------------
// Label extraction
// ---------------------------------------------------------------------------

/** First non-blank, non-comment line in [start, end), trimmed to LABEL_MAX_LEN. */
function extractLabel(lines: string[], start: number, end: number): { text: string; lineIndex: number } {
  for (let i = start; i < end; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.length === 0) continue;
    // Skip pure comment lines (common prefixes across languages)
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("#") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("<!--")
    ) {
      continue;
    }
    return {
      text: trimmed.length > LABEL_MAX_LEN
        ? trimmed.substring(0, LABEL_MAX_LEN)
        : trimmed,
      lineIndex: i,
    };
  }
  // Fallback: first non-blank line, even if it's a comment
  for (let i = start; i < end; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.length > 0) {
      return {
        text: trimmed.length > LABEL_MAX_LEN
          ? trimmed.substring(0, LABEL_MAX_LEN)
          : trimmed,
        lineIndex: i,
      };
    }
  }
  return { text: "(empty)", lineIndex: start };
}

// ---------------------------------------------------------------------------
// Region statistics
// ---------------------------------------------------------------------------

function regionAvgEntropy(
  profiles: LineProfile[],
  start: number,
  end: number,
): number {
  if (end <= start) return 0;
  let sum = 0;
  for (let i = start; i < end; i++) {
    sum += profiles[i]!.entropy;
  }
  return sum / (end - start);
}

function regionAvgSimilarity(
  lines: string[],
  start: number,
  end: number,
): number {
  if (end - start <= 1) return 1;
  let sum = 0;
  let count = 0;
  for (let i = start; i < end - 1; i++) {
    sum += jaccardSimilarity(lines[i]!, lines[i + 1]!);
    count++;
  }
  return count === 0 ? 1 : sum / count;
}

// ---------------------------------------------------------------------------
// Similarity collapse
// ---------------------------------------------------------------------------

/**
 * Given a list of sibling nodes, collapse runs of 3+ consecutive nodes
 * that have high inter-line similarity into a single collapsed node.
 */
function collapseConsecutiveSiblings(
  nodes: StructuralNode[],
  lines: string[],
): StructuralNode[] {
  if (nodes.length < MIN_COLLAPSE_RUN) return nodes;

  const result: StructuralNode[] = [];
  let runStart = 0;

  while (runStart < nodes.length) {
    // Try to extend a run of similar nodes
    let runEnd = runStart + 1;
    while (runEnd < nodes.length) {
      const prevNode = nodes[runEnd - 1]!;
      const currNode = nodes[runEnd]!;
      // Check similarity between representative content of consecutive siblings
      const prevLines = lines
        .slice(prevNode.startLine - 1, prevNode.endLine)
        .join("\n");
      const currLines = lines
        .slice(currNode.startLine - 1, currNode.endLine)
        .join("\n");
      const sim = jaccardSimilarity(prevLines, currLines);
      // Also check structural similarity: similar line counts
      const prevSize = prevNode.endLine - prevNode.startLine + 1;
      const currSize = currNode.endLine - currNode.startLine + 1;
      const sizeRatio =
        Math.min(prevSize, currSize) / Math.max(prevSize, currSize);
      if (sim >= SIMILARITY_COLLAPSE_THRESHOLD && sizeRatio >= 0.3) {
        runEnd++;
      } else {
        break;
      }
    }

    const runLen = runEnd - runStart;
    if (runLen >= MIN_COLLAPSE_RUN) {
      // Collapse this run
      const first = nodes[runStart]!;
      const last = nodes[runEnd - 1]!;
      const totalLines = last.endLine - first.startLine + 1;
      const collapsed: StructuralNode = {
        startLine: first.startLine,
        endLine: last.endLine,
        label: `${runLen} similar regions (${totalLines} lines)`,
        labelLine: first.labelLine,
        depth: first.depth,
        entropy: first.entropy,
        similarity: 1,
        collapsed: true,
        sampleLine: first.label,
        pattern: `${runLen} similar regions`,
        children: [],
      };
      result.push(collapsed);
      runStart = runEnd;
    } else {
      result.push(nodes[runStart]!);
      runStart++;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Recursive subdivision
// ---------------------------------------------------------------------------

function analyzeRegion(
  lines: string[],
  profiles: LineProfile[],
  start: number,
  end: number,
  depth: number,
  maxDepth: number,
): StructuralNode[] {
  const regionLen = end - start;

  // Base case: too small or too deep → leaf node
  if (regionLen <= MIN_REGION || depth >= maxDepth) {
    return [makeLeaf(lines, profiles, start, end)];
  }

  // Find explicit structural boundaries
  const boundaries = findExplicitBoundaries(profiles, lines, start, end);

  let splitPoints: number[];

  if (boundaries.length > 0) {
    // Use explicit boundaries
    splitPoints = boundaries.map((b) => b.index);
  } else {
    // Fall back to entropy transition
    const transition = findEntropyTransition(profiles, start, end);
    if (transition < 0 || transition === start || transition === end) {
      // No good split point → return leaf
      return [makeLeaf(lines, profiles, start, end)];
    }
    splitPoints = [transition];
  }

  // Build segments from split points
  const segments: Array<[number, number]> = [];
  let segStart = start;
  for (const sp of splitPoints) {
    if (sp > segStart) {
      segments.push([segStart, sp]);
    }
    segStart = sp;
  }
  if (segStart < end) {
    segments.push([segStart, end]);
  }

  // If we only got 1 segment (split failed effectively), return leaf
  if (segments.length <= 1) {
    return [makeLeaf(lines, profiles, start, end)];
  }

  // Recurse into each segment
  const children: StructuralNode[] = [];
  for (const [segS, segE] of segments) {
    const sub = analyzeRegion(lines, profiles, segS, segE, depth + 1, maxDepth);
    children.push(...sub);
  }

  // Apply similarity collapse to the children
  return collapseConsecutiveSiblings(children, lines);
}

function makeLeaf(
  lines: string[],
  profiles: LineProfile[],
  start: number,
  end: number,
): StructuralNode {
  const extracted = extractLabel(lines, start, end);
  const entropy = regionAvgEntropy(profiles, start, end);
  const similarity = regionAvgSimilarity(lines, start, end);

  // Find indentation depth of the header line
  let headerDepth = 0;
  for (let i = start; i < end; i++) {
    if (!profiles[i]!.isBlank) {
      headerDepth = profiles[i]!.indent;
      break;
    }
  }

  return {
    startLine: start + 1, // convert to 1-based
    endLine: end, // end is exclusive internally, so this is correct for 1-based inclusive
    label: extracted.text,
    labelLine: extracted.lineIndex + 1, // convert to 1-based
    depth: headerDepth,
    entropy,
    similarity,
    collapsed: false,
    children: [],
  };
}

// ---------------------------------------------------------------------------
// Smart depth thresholds
// ---------------------------------------------------------------------------

function defaultMaxDepth(lineCount: number): number {
  if (lineCount < 300) return 1; // simple outline
  if (lineCount <= 2000) return 4;
  if (lineCount <= 50000) return 3;
  return 2; // 50K+ → aggressive
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze a file's content and build a StructuralTree.
 *
 * @param lines    Array of lines (each line without trailing newline)
 * @param filePath Absolute path of the file (for metadata)
 * @param mtime    File modification time (ms since epoch)
 * @param maxDepth Optional override for max recursion depth
 */
export function analyzeFile(
  lines: string[],
  filePath: string,
  mtime: number,
  maxDepth?: number,
): StructuralTree {
  const lineCount = lines.length;

  // Edge case: empty file
  if (lineCount === 0) {
    return { filePath, mtime, lineCount: 0, children: [] };
  }

  // Edge case: single line
  if (lineCount === 1) {
    const extracted = extractLabel(lines, 0, 1);
    const entropy = shannonEntropy(lines[0]!);
    return {
      filePath,
      mtime,
      lineCount: 1,
      children: [
        {
          startLine: 1,
          endLine: 1,
          label: extracted.text,
          labelLine: extracted.lineIndex + 1,
          depth: indentDepth(lines[0]!),
          entropy,
          similarity: 1,
          collapsed: false,
          children: [],
        },
      ],
    };
  }

  const depth = maxDepth ?? defaultMaxDepth(lineCount);
  const profiles = computeProfiles(lines);

  const children = analyzeRegion(lines, profiles, 0, lineCount, 0, depth);

  return { filePath, mtime, lineCount, children };
}
