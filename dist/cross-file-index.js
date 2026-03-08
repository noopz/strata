const TOKEN_RE = /[a-zA-Z_$][a-zA-Z0-9_$]{2,}/g;
/** Split camelCase/PascalCase/snake_case into components (min length 3). */
function splitCompoundIdentifier(token) {
    const parts = [];
    // Split on underscores first
    const underscoreParts = token.split("_");
    if (underscoreParts.length > 1) {
        for (const part of underscoreParts) {
            if (part.length >= 3) {
                parts.push(part);
            }
        }
        return parts;
    }
    // Split on camelCase / PascalCase transitions
    // "buildDynamicContext" → ["build", "Dynamic", "Context"]
    const camelParts = token.replace(/([a-z])([A-Z])/g, "$1\0$2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1\0$2")
        .split("\0");
    if (camelParts.length > 1) {
        for (const part of camelParts) {
            if (part.length >= 3) {
                parts.push(part);
            }
        }
    }
    return parts;
}
/** Extract tokens from a string using the identifier regex. */
function extractTokensFromText(text) {
    const matches = text.match(TOKEN_RE);
    return matches ?? [];
}
export class CrossFileIndex {
    /** Primary index: normalized token → TokenOccurrence[] */
    tokenIndex = new Map();
    /** Inverted index: filePath → Set of normalized tokens */
    fileTokens = new Map();
    /** Cached stats: normalized token → TokenStats */
    statsCache = new Map();
    /** Connection cache: filePath → CrossFileConnection[] */
    connectionCache = new Map();
    /** Max files to keep in the index (evicts oldest when exceeded) */
    maxFiles;
    constructor(maxFiles = 256) {
        this.maxFiles = maxFiles;
    }
    /** Add/update a file's tokens. Removes old entries first if file already indexed. */
    indexFile(filePath, tree, lines) {
        // Remove existing entries for this file
        if (this.fileTokens.has(filePath)) {
            this.removeFile(filePath);
        }
        // Evict oldest files if at capacity
        while (this.fileTokens.size >= this.maxFiles) {
            const oldest = this.fileTokens.keys().next().value;
            if (oldest !== undefined) {
                this.removeFile(oldest);
            }
        }
        const tokenSet = new Set();
        const occurrences = [];
        // Walk the tree to extract tokens
        const walkNode = (node) => {
            const blockSize = node.endLine - node.startLine + 1;
            // Header tokens: extracted from node.label
            const headerTokenTexts = extractTokensFromText(node.label);
            const seenInHeader = new Set();
            for (const text of headerTokenTexts) {
                const normalized = text.toLowerCase();
                if (seenInHeader.has(normalized))
                    continue;
                seenInHeader.add(normalized);
                const occ = {
                    text,
                    normalized,
                    position: "header",
                    filePath,
                    blockLabel: node.label,
                    lineNumber: node.startLine,
                    depth: node.depth,
                    blockSize,
                };
                occurrences.push(occ);
                tokenSet.add(normalized);
                // Add compound components
                const components = splitCompoundIdentifier(text);
                for (const comp of components) {
                    const compNorm = comp.toLowerCase();
                    if (compNorm === normalized)
                        continue;
                    if (seenInHeader.has(compNorm))
                        continue;
                    seenInHeader.add(compNorm);
                    occurrences.push({
                        text: comp,
                        normalized: compNorm,
                        position: "header",
                        filePath,
                        blockLabel: node.label,
                        lineNumber: node.startLine,
                        depth: node.depth,
                        blockSize,
                    });
                    tokenSet.add(compNorm);
                }
            }
            // Body tokens: extracted from lines within node range, excluding header line
            const bodyStartLine = node.startLine + 1; // skip header line
            const bodyEndLine = node.endLine;
            const seenInBody = new Set();
            if (bodyStartLine <= bodyEndLine) {
                for (let lineIdx = bodyStartLine; lineIdx <= bodyEndLine; lineIdx++) {
                    const lineContent = lines[lineIdx - 1]; // lines is 0-indexed
                    if (lineContent === undefined)
                        continue;
                    const bodyTokenTexts = extractTokensFromText(lineContent);
                    for (const text of bodyTokenTexts) {
                        const normalized = text.toLowerCase();
                        if (seenInBody.has(normalized))
                            continue;
                        seenInBody.add(normalized);
                        occurrences.push({
                            text,
                            normalized,
                            position: "body",
                            filePath,
                            blockLabel: node.label,
                            lineNumber: lineIdx,
                            depth: node.depth,
                            blockSize,
                        });
                        tokenSet.add(normalized);
                        // Add compound components for body tokens
                        const components = splitCompoundIdentifier(text);
                        for (const comp of components) {
                            const compNorm = comp.toLowerCase();
                            if (compNorm === normalized)
                                continue;
                            if (seenInBody.has(compNorm))
                                continue;
                            seenInBody.add(compNorm);
                            occurrences.push({
                                text: comp,
                                normalized: compNorm,
                                position: "body",
                                filePath,
                                blockLabel: node.label,
                                lineNumber: lineIdx,
                                depth: node.depth,
                                blockSize,
                            });
                            tokenSet.add(compNorm);
                        }
                    }
                }
            }
            // Recurse into children
            for (const child of node.children) {
                walkNode(child);
            }
        };
        for (const child of tree.children) {
            walkNode(child);
        }
        // Store in tokenIndex
        for (const occ of occurrences) {
            let list = this.tokenIndex.get(occ.normalized);
            if (!list) {
                list = [];
                this.tokenIndex.set(occ.normalized, list);
            }
            list.push(occ);
        }
        // Store in fileTokens
        this.fileTokens.set(filePath, tokenSet);
        // Invalidate caches
        this.statsCache.clear();
        this.connectionCache.clear();
    }
    /** Remove a file from the index. */
    removeFile(filePath) {
        const tokens = this.fileTokens.get(filePath);
        if (!tokens)
            return;
        for (const token of tokens) {
            const list = this.tokenIndex.get(token);
            if (list) {
                const filtered = list.filter((occ) => occ.filePath !== filePath);
                if (filtered.length === 0) {
                    this.tokenIndex.delete(token);
                }
                else {
                    this.tokenIndex.set(token, filtered);
                }
            }
        }
        this.fileTokens.delete(filePath);
        this.statsCache.clear();
        this.connectionCache.clear();
    }
    /** Get connections for a file, ranked by strength. Promotes file in LRU order. */
    getConnections(filePath, limit) {
        // Promote file in fileTokens for LRU eviction (delete + re-insert)
        const tokens = this.fileTokens.get(filePath);
        if (tokens) {
            this.fileTokens.delete(filePath);
            this.fileTokens.set(filePath, tokens);
        }
        const cached = this.connectionCache.get(filePath);
        if (cached) {
            return limit ? cached.slice(0, limit) : cached;
        }
        if (!tokens)
            return [];
        const totalFiles = this.fileTokens.size;
        if (totalFiles < 2)
            return [];
        // Aggregate connections per (otherFile, connectionType)
        // Key: `otherFile|type|direction`
        const connectionMap = new Map();
        for (const token of tokens) {
            const stats = this.computeStats(token, totalFiles);
            if (!stats)
                continue;
            // Filter: must appear in >=2 files and <=N/2 files
            const maxFileCount = Math.max(totalFiles / 2, 2);
            if (stats.fileCount < 2 || stats.fileCount > maxFileCount)
                continue;
            const allOccs = this.tokenIndex.get(token);
            if (!allOccs)
                continue;
            // Get positions in source file
            const sourceOccs = allOccs.filter((o) => o.filePath === filePath);
            const sourceInHeader = sourceOccs.some((o) => o.position === "header");
            const sourceInBody = sourceOccs.some((o) => o.position === "body");
            // Find other files with this token
            const otherFiles = new Map();
            for (const occ of allOccs) {
                if (occ.filePath === filePath)
                    continue;
                let entry = otherFiles.get(occ.filePath);
                if (!entry) {
                    entry = { inHeader: false, inBody: false };
                    otherFiles.set(occ.filePath, entry);
                }
                if (occ.position === "header")
                    entry.inHeader = true;
                if (occ.position === "body")
                    entry.inBody = true;
            }
            for (const [otherFile, otherPos] of otherFiles) {
                let type;
                let direction;
                if (sourceInHeader && otherPos.inBody && !otherPos.inHeader) {
                    // Source defines, other references → outgoing API dependency
                    type = "api_dependency";
                    direction = "outgoing";
                }
                else if (otherPos.inHeader &&
                    sourceInBody &&
                    !sourceInHeader) {
                    // Other defines, source references → incoming API dependency
                    type = "api_dependency";
                    direction = "incoming";
                }
                else if (sourceInHeader && otherPos.inHeader) {
                    // Both define → shared interface
                    type = "shared_interface";
                    direction = "bidirectional";
                }
                else {
                    // Both in body only → conceptual coupling
                    type = "conceptual_coupling";
                    direction = "bidirectional";
                }
                const key = `${otherFile}|${type}|${direction}`;
                let conn = connectionMap.get(key);
                if (!conn) {
                    conn = {
                        otherFile,
                        type,
                        direction,
                        tokens: new Set(),
                        strength: 0,
                    };
                    connectionMap.set(key, conn);
                }
                conn.tokens.add(token);
                conn.strength += stats.idf;
            }
        }
        // Convert to CrossFileConnection array
        const connections = [];
        for (const conn of connectionMap.values()) {
            connections.push({
                sourceFile: filePath,
                targetFile: conn.otherFile,
                type: conn.type,
                sharedTokens: Array.from(conn.tokens),
                strength: conn.strength,
                direction: conn.direction,
            });
        }
        // Sort by strength descending
        connections.sort((a, b) => b.strength - a.strength);
        // Cache result
        this.connectionCache.set(filePath, connections);
        return limit ? connections.slice(0, limit) : connections;
    }
    /** Get IDF stats for a token. */
    getTokenStats(token) {
        const normalized = token.toLowerCase();
        const totalFiles = this.fileTokens.size;
        if (totalFiles === 0)
            return undefined;
        const cachedStat = this.statsCache.get(normalized);
        if (cachedStat)
            return cachedStat;
        return this.computeStats(normalized, totalFiles);
    }
    /** Get all files in the index. */
    getIndexedFiles() {
        return Array.from(this.fileTokens.keys());
    }
    /** Total unique tokens in the index. */
    get size() {
        return this.tokenIndex.size;
    }
    /** Serialize the index state for disk persistence. */
    exportState() {
        const tokenIndex = {};
        for (const [key, occs] of this.tokenIndex) {
            tokenIndex[key] = occs;
        }
        const fileTokens = {};
        for (const [key, tokens] of this.fileTokens) {
            fileTokens[key] = Array.from(tokens);
        }
        return JSON.stringify({ tokenIndex, fileTokens });
    }
    /** Restore index state from a serialized string. */
    importState(json) {
        const data = JSON.parse(json);
        this.tokenIndex.clear();
        this.fileTokens.clear();
        this.statsCache.clear();
        this.connectionCache.clear();
        for (const [key, occs] of Object.entries(data.tokenIndex)) {
            this.tokenIndex.set(key, occs);
        }
        for (const [key, tokens] of Object.entries(data.fileTokens)) {
            this.fileTokens.set(key, new Set(tokens));
        }
    }
    /** Compute and cache stats for a token. */
    computeStats(normalized, totalFiles) {
        const cached = this.statsCache.get(normalized);
        if (cached)
            return cached;
        const occs = this.tokenIndex.get(normalized);
        if (!occs || occs.length === 0)
            return undefined;
        const filesWithToken = new Set();
        let headerCount = 0;
        let bodyCount = 0;
        for (const occ of occs) {
            filesWithToken.add(occ.filePath);
            if (occ.position === "header")
                headerCount++;
            else
                bodyCount++;
        }
        const fileCount = filesWithToken.size;
        const idf = Math.log2(totalFiles / fileCount);
        const stats = { idf, fileCount, headerCount, bodyCount };
        this.statsCache.set(normalized, stats);
        return stats;
    }
}
//# sourceMappingURL=cross-file-index.js.map