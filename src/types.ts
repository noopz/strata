/**
 * Shared type definitions for Strata.
 *
 * Architecture:
 *   Structural Analyzer → builds StructuralTree from file content
 *   Cross-File Index    → extracts tokens from trees, computes IDF, finds connections
 *   PreToolUse Hook     → intercepts Read, redirects to structural outline cache files
 */

// ============================================================================
// Structural Tree
// ============================================================================

/** A node in the structural tree representing a region of a file. */
export interface StructuralNode {
  /** 1-based start line (inclusive) */
  startLine: number;
  /** 1-based end line (inclusive) */
  endLine: number;
  /** Label extracted from the header line (e.g. "function loadScene(...)") */
  label: string;
  /** Indentation depth of the header line (in spaces) */
  depth: number;
  /** Average intra-line entropy for this region */
  entropy: number;
  /** Inter-line similarity score (0 = all different, 1 = all identical) */
  similarity: number;
  /** Whether this node was collapsed due to high similarity */
  collapsed: boolean;
  /** If collapsed, a representative sample line */
  sampleLine?: string;
  /** If collapsed, the detected repetition pattern (e.g. "200 similar getters") */
  pattern?: string;
  /** 1-based line number the label was extracted from */
  labelLine: number;
  /** Child nodes (subdivisions of this region) */
  children: StructuralNode[];
}

/** Root-level result of structural analysis for a file. */
export interface StructuralTree {
  /** Absolute path of the analyzed file */
  filePath: string;
  /** File modification time at analysis (ms since epoch) */
  mtime: number;
  /** Total line count */
  lineCount: number;
  /** Root children of the structural tree */
  children: StructuralNode[];
}

// ============================================================================
// Cross-File Index
// ============================================================================

/** A token occurrence extracted from a structural block. */
export interface TokenOccurrence {
  /** Original text, case-preserved */
  text: string;
  /** Lowercased for matching */
  normalized: string;
  /** Was this token found in a block header or body? */
  position: "header" | "body";
  /** Absolute file path */
  filePath: string;
  /** The structural node's label where this was found */
  blockLabel: string;
  /** 1-based line number */
  lineNumber: number;
  /** Indentation depth where found */
  depth: number;
  /** Size of the containing block (in lines) */
  blockSize: number;
}

/** Statistics for a token across the session-scoped index. */
export interface TokenStats {
  /** Inverse document frequency: log2(N / df) */
  idf: number;
  /** Number of files containing this token */
  fileCount: number;
  /** Number of times this token appears in a block header position */
  headerCount: number;
  /** Number of times this token appears in a block body position */
  bodyCount: number;
}

/** Connection type between two files based on shared tokens. */
export type ConnectionType =
  | "api_dependency"       // Header in A, body-only in B → B depends on A
  | "shared_interface"     // Header in both A and B
  | "structural_similarity" // Shared compound identifier components in headers
  | "conceptual_coupling"; // Body in both, neither defines

/** A detected cross-file connection. */
export interface CrossFileConnection {
  /** Source file path */
  sourceFile: string;
  /** Target file path */
  targetFile: string;
  /** What kind of connection */
  type: ConnectionType;
  /** The shared tokens that formed this connection */
  sharedTokens: string[];
  /** Aggregate strength score (sum of IDF weights of shared tokens) */
  strength: number;
  /** Direction: "outgoing" means sourceFile defines, targetFile references */
  direction: "outgoing" | "incoming" | "bidirectional";
}

