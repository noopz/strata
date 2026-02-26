/**
 * Shared type definitions for Strata.
 *
 * Architecture:
 *   Structural Analyzer → builds StructuralTree from file content
 *   Cross-File Index    → extracts tokens from trees, computes IDF, finds connections
 *   Hashline Engine     → tags lines with LINE#HASH for edit addressing
 *   JIT Cache           → filepath+mtime keyed cache of structural trees
 *   MCP Server          → exposes tools (analyze, expand, edit, connections)
 *   PreToolUse Hook     → intercepts Read, redirects to structural view cache files
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

// ============================================================================
// Hashline
// ============================================================================

/** A hashline-tagged line: LINE#HASH:content */
export interface HashlineLine {
  /** 1-based line number */
  lineNumber: number;
  /** Hash tag (e.g. "VRK" for 12-bit) */
  hash: string;
  /** Original line content */
  content: string;
}

/** A hashline edit operation. */
export interface HashlineEdit {
  /** The operation type */
  op: "set" | "replace" | "append" | "prepend" | "insert" | "delete";
  /** The LINE#HASH tag identifying the target line */
  tag: string;
  /** New content (for set/replace/append/prepend/insert) */
  content?: string[];
  /** For replace: the LINE#HASH tag of the end of the range */
  endTag?: string;
}

/** Result of applying hashline edits. */
export interface HashlineEditResult {
  success: boolean;
  /** Updated file content */
  content?: string;
  /** Updated hashlines for the affected region */
  updatedLines?: HashlineLine[];
  /** Error message if failed */
  error?: string;
  /** Number of lines changed */
  linesChanged?: number;
}

// ============================================================================
// Cache
// ============================================================================

/** Cache entry for a processed file. */
export interface CacheEntry {
  /** The structural tree */
  tree: StructuralTree;
  /** Extracted tokens for cross-file indexing */
  tokens: TokenOccurrence[];
  /** The rendered structural view text (for the temp file) */
  renderedView: string;
  /** When this cache entry was created */
  cachedAt: number;
}

/** Cache key: filepath + mtime. */
export interface CacheKey {
  filePath: string;
  mtime: number;
}

// ============================================================================
// MCP Tool Parameters
// ============================================================================

export interface AnalyzeParams {
  file_path: string;
  /** Max depth for the structural tree (default: unlimited) */
  max_depth?: number;
}

export interface ExpandParams {
  file_path: string;
  /** Line range to expand: "start-end" (e.g. "212-280") */
  range?: string;
  /** Structural path to expand (e.g. "class SceneManager > loadScene") */
  path?: string;
}

export interface EditParams {
  file_path: string;
  edits: HashlineEdit[];
}

export interface ConnectionsParams {
  file_path: string;
  /** Max connections to return (default: 10) */
  limit?: number;
}

export interface SearchParams {
  /** Search pattern (regex) */
  pattern: string;
  /** Directory to search in (default: cwd) */
  path?: string;
  /** File glob filter */
  glob?: string;
  /** Max results (default: 20) */
  limit?: number;
}
