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
// Entropy stats — computed once per file, threaded through for dynamic scaling
// ---------------------------------------------------------------------------

interface EntropyStats {
  mean: number;
  std: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_REGION = 5;
const TAB_WIDTH = 4;
const LABEL_MAX_LEN = 80;
const SIMILARITY_COLLAPSE_THRESHOLD = 0.7;
const MIN_COLLAPSE_RUN = 3;
const ENTROPY_WINDOW = 5;
const ENTROPY_GRADIENT_SCALE = 0.6;

/** z-score threshold: regions this far above/below mean get depth adjustment. */
const ENTROPY_DEPTH_Z = 0.5;

/** Per-unit-z adjustment to collapse threshold. */
const ENTROPY_COLLAPSE_SCALE = 0.1;

/** Minimum file-wide entropy std to enable adaptive scaling. */
const ENTROPY_MIN_STD = 0.1;

/**
 * Target minimum region size at depth 0. The boundary budget ensures segments
 * are large enough to create meaningful hierarchy. At depth 0 we want coarse
 * sections (few boundaries, big regions), at deeper levels we allow finer splits.
 */
const TARGET_REGION_SIZE_D0 = 100;

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
// Smoothed entropy helpers
// ---------------------------------------------------------------------------

/**
 * Compute smoothed entropy values for a region [start, end) using a
 * moving-average window. Returns an array of length (end - start).
 *
 * @param window  Full window width (defaults to ENTROPY_WINDOW=5 for
 *                backward compat with findEntropyTransition).
 */
export function computeSmoothedEntropy(
  profiles: LineProfile[],
  start: number,
  end: number,
  window?: number,
): number[] {
  const halfWin = Math.floor((window ?? ENTROPY_WINDOW) / 2);
  const len = end - start;
  const smoothed: number[] = [];
  for (let i = 0; i < len; i++) {
    const lo = Math.max(0, i - halfWin);
    const hi = Math.min(len - 1, i + halfWin);
    let sum = 0;
    for (let j = lo; j <= hi; j++) {
      sum += profiles[start + j]!.entropy;
    }
    smoothed.push(sum / (hi - lo + 1));
  }
  return smoothed;
}

/**
 * Absolute entropy gradient at a local index within a smoothed array.
 * Returns 0 at the boundaries (index 0 or last).
 */
export function entropyGradientAt(smoothed: number[], localIdx: number): number {
  if (localIdx <= 0 || localIdx >= smoothed.length) return 0;
  return Math.abs(smoothed[localIdx]! - smoothed[localIdx - 1]!);
}

// ---------------------------------------------------------------------------
// Boundary detection
// ---------------------------------------------------------------------------

interface Boundary {
  index: number; // line index (global, within the file)
  score: number; // higher = stronger boundary signal
  isTag?: boolean; // true if generated by tag-depth signal
  isSeparator?: boolean; // true if visual separator (// ====, # ----, etc.)
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

  // Pre-compute smoothed entropy for the region so every boundary's score
  // is entropy-proportional: a blank line at a strong entropy transition
  // (imports → class) scores full weight, while one between identical
  // import lines scores half. Entropy is integral to L1-L3, not a bonus.
  const regionLen = end - start;
  const scoringWindow = 15;
  let smoothed: number[] | null = null;
  if (regionLen >= scoringWindow * 2 + 1) {
    smoothed = computeSmoothedEntropy(profiles, start, end, scoringWindow);
  }

  // Adaptive gradient scaling: compute per-region so eFactor spreads across
  // the full 0.0-1.0 range regardless of absolute gradient magnitudes.
  // Use the 90th percentile of gradients as the scale — the strongest 10%
  // of transitions get eFactor near 1.0, weak transitions near 0.0.
  let gradientScale = ENTROPY_GRADIENT_SCALE;
  if (smoothed) {
    const allGradients: number[] = [];
    for (let i = 0; i < smoothed.length; i++) {
      allGradients.push(entropyGradientAt(smoothed, i));
    }
    allGradients.sort((a, b) => a - b);
    const p90 = allGradients[Math.floor(allGradients.length * 0.9)] ?? ENTROPY_GRADIENT_SCALE;
    if (p90 > 0.01) gradientScale = p90;
  }

  // Detect visual separator lines: long runs of repeated non-alphanumeric chars.
  // Lines like "// ====", "# ----", "/* *** */" are universal section markers.
  const SEPARATOR_RE = /([=\-*#~_])\1{7,}/;

  // Markdown headings: `# H1` through `###### H6`. Score decreases with depth.
  const MD_HEADING_RE = /^(#{1,6})\s+\S/;

  for (let i = start; i < end; i++) {
    const localIdx = i - start;
    const prof = profiles[i]!;

    // Entropy factor: 0.0 (no transition) to 1.0 (strongest transition in region).
    // The gradient scale adapts per-region so even files with small absolute
    // gradients still get meaningful score differentiation.
    const gradient = smoothed ? entropyGradientAt(smoothed, localIdx) : 0;
    const eFactor = Math.min(1.0, gradient / gradientScale);

    // L0: Visual separator line → strongest boundary (score 5.0).
    // Always wins budget selection, creating section-level structure.
    if (!prof.isBlank && SEPARATOR_RE.test(lines[i]!)) {
      bounds.push({ index: i, score: 5, isSeparator: true });
      continue;
    }

    // Markdown heading → entropy-weighted boundary.
    // Heading level sets the ceiling (# = 4.5, ## = 4.0, ### = 3.5, etc.)
    // but entropy modulates: a heading at a major content shift scores near
    // the ceiling, while one between similar paragraphs scores near the floor.
    // Floor is 40% of ceiling — headings always beat most blank lines.
    const mdMatch = MD_HEADING_RE.exec(lines[i]!);
    if (mdMatch) {
      const level = mdMatch[1]!.length; // 1-6
      const ceiling = Math.max(2.5, 5.0 - level * 0.5);
      const headingScore = ceiling * (0.4 + 0.6 * eFactor);
      bounds.push({ index: i, score: headingScore });
      continue;
    }

    // Blank line → strong boundary (score 0.0-3.0, entropy-weighted)
    if (prof.isBlank) {
      bounds.push({ index: i, score: 3 * eFactor });
      continue;
    }

    // Bracket depth returns to minimum from deeper (score 1.0-2.0)
    if (
      localIdx > 0 &&
      depths[localIdx]! <= 0 &&
      depths[localIdx - 1]! > 0
    ) {
      if (i + 1 < end) {
        // Use gradient at i+1 (the line after the close) for the boundary
        const nextGrad = smoothed ? entropyGradientAt(smoothed, localIdx + 1) : 0;
        const nextEF = 0.5 + 0.5 * Math.min(1.0, nextGrad / ENTROPY_GRADIENT_SCALE);
        bounds.push({ index: i + 1, score: 2 * nextEF });
        continue;
      }
      // When at the very end (i + 1 === end), don't push but fall through
      // to the dedent rules so the line can still be detected as a boundary.
    }

    // Tag depth drops (closing tag) (score 1.0-2.0)
    if (
      localIdx > 0 &&
      prof.tagDelta < 0 &&
      tDepths[localIdx]! < tDepths[localIdx - 1]!
    ) {
      if (i + 1 < end) {
        bounds.push({ index: i + 1, score: 2 * eFactor, isTag: true });
      }
      continue;
    }

    // Indentation decrease to depth 0 (score 0.5-1.0)
    if (
      i > start &&
      prof.indent < profiles[i - 1]!.indent &&
      prof.indent === 0 &&
      !prof.isBlank
    ) {
      bounds.push({ index: i, score: 1 * eFactor });
    }

    // Significant dedent (drop of 2+ indent levels) (score 0.5-1.0)
    if (
      i > start &&
      !prof.isBlank &&
      prof.indent < profiles[i - 1]!.indent &&
      prof.indent > 0 &&
      (profiles[i - 1]!.indent - prof.indent) >= TAB_WIDTH * 2
    ) {
      bounds.push({ index: i, score: 1 * eFactor });
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

  const smoothed = computeSmoothedEntropy(profiles, start, end);

  // Find largest absolute difference in smoothed entropy
  let maxDiff = 0;
  let maxIdx = -1;
  for (let i = 1; i < smoothed.length; i++) {
    const grad = entropyGradientAt(smoothed, i);
    if (grad > maxDiff) {
      maxDiff = grad;
      maxIdx = i;
    }
  }

  // Require a meaningful transition (arbitrary threshold: 0.3 bits)
  if (maxDiff < 0.3) return -1;

  return start + maxIdx;
}

/**
 * Find multiple entropy-derived boundaries within a region. Used when L1-L3
 * structural signals find nothing (e.g. inside class bodies where blank lines
 * are at bracket depth > 0).
 *
 * Selects the top N strongest entropy gradient peaks where N is proportional
 * to the region size (regionLen / 40). This is the core "dynamic scaling"
 * mechanism: larger regions get more splits, and only the strongest entropy
 * transitions survive. The window size also scales with the region.
 *
 * Peaks are snapped to nearby blank lines when possible, aligning entropy-
 * detected transitions with natural visual boundaries in the code.
 *
 * Returns sorted array of split indices (global), or empty if no meaningful
 * transitions are found.
 */
function findEntropyBoundaries(
  profiles: LineProfile[],
  lines: string[],
  start: number,
  end: number,
): number[] {
  const regionLen = end - start;
  if (regionLen < MIN_REGION * 3) return [];

  // Window proportional to region size: small regions get narrow windows,
  // large regions get wider windows. Clamped to [5, 25].
  const window = Math.max(5, Math.min(25, Math.floor(regionLen / 15)));
  if (regionLen < window * 2 + 1) return [];

  const smoothed = computeSmoothedEntropy(profiles, start, end, window);

  // Collect all gradient values with their positions
  const peaks: Array<{ localIdx: number; gradient: number }> = [];
  for (let i = 1; i < smoothed.length; i++) {
    const grad = entropyGradientAt(smoothed, i);
    if (grad > 0) {
      peaks.push({ localIdx: i, gradient: grad });
    }
  }

  if (peaks.length === 0) return [];

  // Entropy variability: coefficient of variation (std/mean) of non-blank
  // line entropies in this region. Uniform regions (SQL data: CV ≈ 0.01)
  // get very few splits. Variable regions (class bodies: CV ≈ 0.4) get more.
  const regionEntropies: number[] = [];
  for (let i = start; i < end; i++) {
    if (!profiles[i]!.isBlank) {
      regionEntropies.push(profiles[i]!.entropy);
    }
  }
  let cv = 0;
  if (regionEntropies.length > 0) {
    const rMean =
      regionEntropies.reduce((a, b) => a + b, 0) / regionEntropies.length;
    if (rMean > 0) {
      const rVar =
        regionEntropies.reduce((a, b) => a + (b - rMean) ** 2, 0) /
        regionEntropies.length;
      cv = Math.sqrt(rVar) / rMean;
    }
  }

  // Guard: if entropy is too uniform (CV < 0.15), entropy boundaries
  // would just split uniform data at arbitrary points. Skip entirely.
  if (cv < 0.15) return [];

  // Dynamic N: scaled by region size AND entropy variability.
  // Base: ~1 split per 40 lines. Multiplied by cv/0.3 so:
  //   CV ≈ 0.2  (moderately uniform) → scale ≈ 0.67 → fewer splits
  //   CV ≈ 0.3  (mixed code)         → scale ≈ 1.0  → normal splits
  //   CV > 0.4  (varied class)       → scale ≈ 1.3+ → more splits
  const variabilityScale = Math.min(2.0, cv / 0.3);
  const rawSplits = Math.floor(regionLen / 40 * variabilityScale);
  const maxSplits = Math.max(1, Math.min(12, rawSplits));

  // Minimum gap between entropy boundaries: wider for larger regions
  const minGap = Math.max(MIN_REGION, Math.floor(regionLen / (maxSplits + 1) / 2));

  // Select top N by gradient strength with non-maximum suppression
  peaks.sort((a, b) => b.gradient - a.gradient);
  const kept: Array<{ localIdx: number; gradient: number }> = [];
  for (const peak of peaks) {
    if (kept.length >= maxSplits) break;
    const tooClose = kept.some(
      (k) => Math.abs(k.localIdx - peak.localIdx) < minGap,
    );
    if (!tooClose) {
      kept.push(peak);
    }
  }

  if (kept.length === 0) return [];

  // Sort by position
  kept.sort((a, b) => a.localIdx - b.localIdx);

  // Snap to nearby blank lines (within 3 lines) for cleaner boundaries
  const splits: number[] = [];
  for (const peak of kept) {
    const globalIdx = start + peak.localIdx;
    let bestIdx = globalIdx;
    for (let delta = 0; delta <= 3; delta++) {
      // Prefer blank lines after the peak (between regions)
      const after = globalIdx + delta;
      if (after > start && after < end && profiles[after]?.isBlank) {
        bestIdx = after;
        break;
      }
      // Also check before
      if (delta > 0) {
        const before = globalIdx - delta;
        if (before > start && before < end && profiles[before]?.isBlank) {
          bestIdx = before;
          break;
        }
      }
    }
    if (bestIdx > start + MIN_REGION && bestIdx < end - MIN_REGION) {
      splits.push(bestIdx);
    }
  }

  // Deduplicate after snapping
  const unique = [...new Set(splits)].sort((a, b) => a - b);
  return unique;
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
 *
 * Collapse threshold adapts based on entropy: low-entropy regions (repetitive
 * data/imports) collapse more aggressively, high-entropy regions (unique logic)
 * resist collapsing. This lets entropy control the detail budget.
 */
function collapseConsecutiveSiblings(
  nodes: StructuralNode[],
  lines: string[],
  eStats: EntropyStats,
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

      // Entropy-adaptive collapse threshold:
      // Low-entropy pair → lower threshold (0.5) → collapse more (repetitive data)
      // High-entropy pair → higher threshold (0.85) → preserve detail (unique logic)
      const pairEntropy = (prevNode.entropy + currNode.entropy) / 2;
      const z =
        eStats.std > ENTROPY_MIN_STD
          ? (pairEntropy - eStats.mean) / eStats.std
          : 0;
      const dynamicThreshold = Math.max(
        0.5,
        Math.min(0.9, SIMILARITY_COLLAPSE_THRESHOLD + z * ENTROPY_COLLAPSE_SCALE),
      );

      if (sim >= dynamicThreshold && sizeRatio >= 0.3) {
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

const CLOSING_DELIM_RE = /^[}\])\s;,]*$/;

/**
 * Merge tiny nodes whose label is just a closing delimiter (}, );, ], etc.)
 * into the preceding sibling. These are structural artifacts from bracket-
 * depth boundary detection and add no navigational value in outlines.
 */
function mergeClosingDelimiters(nodes: StructuralNode[]): StructuralNode[] {
  if (nodes.length <= 1) return nodes;
  const result: StructuralNode[] = [];
  for (const node of nodes) {
    const size = node.endLine - node.startLine + 1;
    if (
      size <= 2 &&
      !node.collapsed &&
      CLOSING_DELIM_RE.test(node.label) &&
      result.length > 0
    ) {
      // Extend previous node to absorb this closing delimiter
      const prev = result[result.length - 1]!;
      prev.endLine = node.endLine;
    } else {
      result.push(node);
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
  eStats: EntropyStats,
): StructuralNode[] {
  const regionLen = end - start;

  // Entropy-adaptive depth: regions with entropy significantly above the file
  // mean get +1 depth (more detail for complex code), regions below get -1
  // (less detail for repetitive data/imports).
  // Exception: don't penalize regions that contain markdown headings — those
  // are explicit author-placed structure that should be respected regardless
  // of entropy uniformity.
  const regionEntropy = regionAvgEntropy(profiles, start, end);
  const z =
    eStats.std > ENTROPY_MIN_STD
      ? (regionEntropy - eStats.mean) / eStats.std
      : 0;
  let depthBonus = z > ENTROPY_DEPTH_Z ? 1 : z < -ENTROPY_DEPTH_Z ? -1 : 0;
  if (depthBonus < 0) {
    const MD_HEADING_CHECK = /^#{1,6}\s+\S/;
    for (let i = start; i < end; i++) {
      if (MD_HEADING_CHECK.test(lines[i]!)) {
        depthBonus = 0;
        break;
      }
    }
  }
  const effectiveMaxDepth = maxDepth + depthBonus;

  // Base case: too small or too deep → leaf node
  if (regionLen <= MIN_REGION || depth >= effectiveMaxDepth) {
    return [makeLeaf(lines, profiles, start, end)];
  }

  // Find explicit structural boundaries
  const boundaries = findExplicitBoundaries(profiles, lines, start, end);

  let splitPoints: number[];
  // Filter boundaries at region edges — they don't create useful splits
  const usable = boundaries.filter((b) => b.index > start && b.index < end);

  if (usable.length > 0) {
    // Budget: limit boundaries so segments are large enough to create
    // meaningful hierarchy. Only applies to large regions — small files
    // keep all boundaries so collapse can compress repetitive regions.
    const targetSize =
      depth === 0
        ? TARGET_REGION_SIZE_D0
        : Math.max(MIN_REGION * 4, Math.floor(TARGET_REGION_SIZE_D0 / (depth + 1)));
    const maxBoundaries = Math.max(2, Math.floor(regionLen / targetSize));
    let selected = usable;
    if (usable.length > maxBoundaries && regionLen >= 200) {
      if (depth === 0 && regionLen >= targetSize * 3) {
        // At depth 0, use coarse entropy to pick section-level boundaries.
        const coarseWindow = Math.max(30, Math.floor(regionLen / 20));
        const coarseSmoothed = computeSmoothedEntropy(
          profiles, start, end, coarseWindow,
        );
        const coarseGrads: number[] = [];
        for (let j = 0; j < coarseSmoothed.length; j++) {
          coarseGrads.push(entropyGradientAt(coarseSmoothed, j));
        }
        coarseGrads.sort((a, b) => a - b);
        const cScale =
          coarseGrads[Math.floor(coarseGrads.length * 0.9)] ?? 0.1;
        const coarseScale = Math.max(0.01, cScale);

        const rescored = usable.map((b) => {
          if (b.isSeparator) return { ...b };
          const localIdx = b.index - start;
          const cGrad = entropyGradientAt(coarseSmoothed, localIdx);
          const cFactor = Math.min(1.0, cGrad / coarseScale);
          return { ...b, score: b.score * (0.3 + 0.7 * cFactor) };
        });
        rescored.sort((a, b) => b.score - a.score);
        selected = rescored
          .slice(0, maxBoundaries)
          .sort((a, b) => a.index - b.index);
      } else {
        // At deeper levels, use the fine-grained scores directly.
        selected = usable
          .slice()
          .sort((a, b) => b.score - a.score)
          .slice(0, maxBoundaries)
          .sort((a, b) => a.index - b.index);
      }
    }
    splitPoints = selected.map((b) => b.index);
  } else {
    // No structural boundaries (e.g. inside a class body where all blank
    // lines are at bracket depth > 0). Use entropy to find multiple
    // significant transitions with a dynamically-scaled threshold.
    const entropyBounds = findEntropyBoundaries(profiles, lines, start, end);
    if (entropyBounds.length > 0) {
      splitPoints = entropyBounds;
    } else {
      // Last resort: single biggest entropy transition (original L4)
      const transition = findEntropyTransition(profiles, start, end);
      if (transition < 0 || transition === start || transition === end) {
        return [makeLeaf(lines, profiles, start, end)];
      }
      splitPoints = [transition];
    }
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

  // Recurse into each segment, creating parent nodes for hierarchy
  const children: StructuralNode[] = [];
  for (const [segS, segE] of segments) {
    const sub = analyzeRegion(
      lines, profiles, segS, segE, depth + 1, maxDepth, eStats,
    );
    if (sub.length > 1) {
      // Wrap multiple children in a parent node to create hierarchy
      const parent = makeLeaf(lines, profiles, segS, segE);
      parent.children = sub;
      children.push(parent);
    } else {
      children.push(...sub);
    }
  }

  // Apply similarity collapse, then clean up closing-delimiter noise
  const collapsed = collapseConsecutiveSiblings(children, lines, eStats);
  return mergeClosingDelimiters(collapsed);
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
  if (lineCount < 300) return 2; // enough for heading-structured markdown
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

  // Compute file-wide entropy stats once for adaptive scaling.
  // Only non-blank lines contribute — blank lines have entropy 0 and would
  // skew the mean downward, making every real code region look "high entropy".
  const nonBlankEntropies: number[] = [];
  for (let i = 0; i < lineCount; i++) {
    if (!profiles[i]!.isBlank) {
      nonBlankEntropies.push(profiles[i]!.entropy);
    }
  }
  let eMean = 0;
  let eStd = 0;
  if (nonBlankEntropies.length > 0) {
    eMean =
      nonBlankEntropies.reduce((a, b) => a + b, 0) / nonBlankEntropies.length;
    const variance =
      nonBlankEntropies.reduce((a, b) => a + (b - eMean) ** 2, 0) /
      nonBlankEntropies.length;
    eStd = Math.sqrt(variance);
  }
  const eStats: EntropyStats = { mean: eMean, std: eStd };

  const children = analyzeRegion(lines, profiles, 0, lineCount, 0, depth, eStats);

  return { filePath, mtime, lineCount, children };
}
