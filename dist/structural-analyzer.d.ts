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
import type { StructuralTree } from "./types.js";
/** Shannon entropy of a string's character distribution (bits). */
export declare function shannonEntropy(line: string): number;
/** Jaccard similarity between two trigram sets (0-1). */
export declare function jaccardSimilarity(a: string, b: string): number;
/** Indentation depth in spaces (tabs normalized to TAB_WIDTH). */
export declare function indentDepth(line: string): number;
/** Net bracket depth change for a line: +1 for ({[, -1 for )}]. */
export declare function bracketDelta(line: string): number;
/**
 * Net tag depth change for a line: +1 for opening tags, -1 for closing tags.
 * Self-closing tags (<br />) contribute 0.
 * Only fires on lines that are purely a tag (not mixed content like "<p>text</p>").
 */
export declare function tagDelta(line: string): number;
interface LineProfile {
    entropy: number;
    indent: number;
    bracketDelta: number;
    tagDelta: number;
    isBlank: boolean;
}
/**
 * Compute smoothed entropy values for a region [start, end) using a
 * moving-average window. Returns an array of length (end - start).
 *
 * @param window  Full window width (defaults to ENTROPY_WINDOW=5 for
 *                backward compat with findEntropyTransition).
 */
export declare function computeSmoothedEntropy(profiles: LineProfile[], start: number, end: number, window?: number): number[];
/**
 * Absolute entropy gradient at a local index within a smoothed array.
 * Returns 0 at the boundaries (index 0 or last).
 */
export declare function entropyGradientAt(smoothed: number[], localIdx: number): number;
/**
 * Analyze a file's content and build a StructuralTree.
 *
 * @param lines    Array of lines (each line without trailing newline)
 * @param filePath Absolute path of the file (for metadata)
 * @param mtime    File modification time (ms since epoch)
 * @param maxDepth Optional override for max recursion depth
 */
export declare function analyzeFile(lines: string[], filePath: string, mtime: number, maxDepth?: number): StructuralTree;
export {};
