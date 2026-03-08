import type { StructuralTree, TokenStats, CrossFileConnection } from "./types.js";
export declare class CrossFileIndex {
    /** Primary index: normalized token → TokenOccurrence[] */
    private tokenIndex;
    /** Inverted index: filePath → Set of normalized tokens */
    private fileTokens;
    /** Cached stats: normalized token → TokenStats */
    private statsCache;
    /** Connection cache: filePath → CrossFileConnection[] */
    private connectionCache;
    /** Max files to keep in the index (evicts oldest when exceeded) */
    private readonly maxFiles;
    constructor(maxFiles?: number);
    /** Add/update a file's tokens. Removes old entries first if file already indexed. */
    indexFile(filePath: string, tree: StructuralTree, lines: string[]): void;
    /** Remove a file from the index. */
    removeFile(filePath: string): void;
    /** Get connections for a file, ranked by strength. Promotes file in LRU order. */
    getConnections(filePath: string, limit?: number): CrossFileConnection[];
    /** Get IDF stats for a token. */
    getTokenStats(token: string): TokenStats | undefined;
    /** Get all files in the index. */
    getIndexedFiles(): string[];
    /** Total unique tokens in the index. */
    get size(): number;
    /** Serialize the index state for disk persistence. */
    exportState(): string;
    /** Restore index state from a serialized string. */
    importState(json: string): void;
    /** Compute and cache stats for a token. */
    private computeStats;
}
