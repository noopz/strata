#!/usr/bin/env node
/**
 * Strata MCP Server
 *
 * Entropy-guided structural analysis, hashline edits, and cross-file
 * reference detection for LLM coding agents.
 *
 * Tools:
 *   structural_analyze  — Analyze a file, return structural view
 *   structural_expand   — Expand a region with hashline tags
 *   structural_edit     — Apply hashline edits to a file
 *   structural_connections — Get cross-file connections
 *   structural_search   — Search files with structural context
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { analyzeFile } from "./structural-analyzer.js";
import { CrossFileIndex } from "./cross-file-index.js";
import { JITCache, writeCacheFile } from "./cache.js";
import { renderStructuralView, renderHashlinedRegion } from "./formatter.js";
import {
  computeHash,
  hashLines,
  applyEdits,
} from "./hashline.js";
import type { StructuralTree, StructuralNode } from "./types.js";

// ============================================================================
// Global state
// ============================================================================

const cache = new JITCache();
const crossFileIndex = new CrossFileIndex();

// ============================================================================
// Helpers
// ============================================================================

/**
 * Remove filesystem cache entries for a file (any mtime).
 * Needed for MCP tool edits since post-edit.sh only fires on native Edit/Write.
 */
function invalidateFilesystemCache(absPath: string): void {
  const projectRoot = process.env.CLAUDE_PROJECT_DIR || path.dirname(absPath);
  const cacheDir = path.join(projectRoot, ".strata");
  const fileHash = createHash("sha256").update(absPath).digest("hex");
  try {
    if (fs.existsSync(cacheDir)) {
      for (const entry of fs.readdirSync(cacheDir)) {
        if (entry.startsWith(fileHash)) {
          fs.unlinkSync(path.join(cacheDir, entry));
        }
      }
    }
  } catch {
    // Best effort
  }
}

function readFileLines(filePath: string): { lines: string[]; mtime: number } {
  const stat = fs.statSync(filePath);
  const mtime = stat.mtimeMs;
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  return { lines, mtime };
}

/**
 * Ensure a file is analyzed and cached.
 * Returns the structural tree and connections.
 */
function ensureAnalyzed(
  filePath: string,
  maxDepth?: number,
): { tree: StructuralTree; lines: string[] } {
  const absPath = path.resolve(filePath);
  const { lines, mtime } = readFileLines(absPath);

  // Check JIT cache
  const cached = cache.get(absPath, mtime);
  if (cached) {
    return { tree: cached.tree, lines };
  }

  // Compute structural analysis
  const tree = analyzeFile(lines, absPath, mtime, maxDepth);

  // Index tokens for cross-file detection
  crossFileIndex.indexFile(absPath, tree, lines);

  // Get connections and render
  const connections = crossFileIndex.getConnections(absPath, 5);
  const renderedView = renderStructuralView(tree, connections);

  // Cache
  cache.set(absPath, {
    tree,
    tokens: [], // tokens are stored in crossFileIndex
    renderedView,
    cachedAt: Date.now(),
  });

  // Write filesystem cache for the hook
  writeCacheFile(absPath, mtime, renderedView);

  return { tree, lines };
}

/**
 * Find a node in the structural tree by label substring match.
 */
function findNodeByPath(
  nodes: StructuralNode[],
  searchPath: string,
): StructuralNode | null {
  const searchLower = searchPath.toLowerCase();

  for (const node of nodes) {
    if (node.label.toLowerCase().includes(searchLower)) {
      return node;
    }
    // Recurse into children
    const found = findNodeByPath(node.children, searchPath);
    if (found) return found;
  }
  return null;
}

/**
 * Find the structural node containing a given line number.
 */
function findNodeForLine(
  nodes: StructuralNode[],
  lineNumber: number,
): StructuralNode | null {
  for (const node of nodes) {
    if (lineNumber >= node.startLine && lineNumber <= node.endLine) {
      // Check children for a more specific match
      const childMatch = findNodeForLine(node.children, lineNumber);
      return childMatch ?? node;
    }
  }
  return null;
}

// ============================================================================
// MCP Server
// ============================================================================

const server = new McpServer({
  name: "strata",
  version: "0.1.0",
});

// --- Tool: structural_analyze ---

server.tool(
  "structural_analyze",
  "Analyze a file and return its structural outline. Shows the file's structure " +
    "(functions, classes, sections) as a collapsible tree. Use structural_expand " +
    "to zoom into specific regions with hashline tags for editing.",
  {
    file_path: z.string().describe("Absolute path to the file to analyze"),
    max_depth: z
      .number()
      .optional()
      .describe("Max depth for the structural tree (default: auto based on file size)"),
  },
  async ({ file_path, max_depth }) => {
    try {
      const absPath = path.resolve(file_path);
      if (!fs.existsSync(absPath)) {
        return { content: [{ type: "text" as const, text: `Error: File not found: ${absPath}` }] };
      }

      const { tree } = ensureAnalyzed(absPath, max_depth);
      const connections = crossFileIndex.getConnections(absPath, 5);
      const view = renderStructuralView(tree, connections, max_depth);

      return { content: [{ type: "text" as const, text: view }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error analyzing file: ${err}` }],
      };
    }
  },
);

// --- Tool: structural_expand ---

server.tool(
  "structural_expand",
  "Read section content from a file with hashline tags for precise editing. " +
    "Use this to read any section of an outlined file — returns full content with LINE#HASH:content tags " +
    "ready for structural_edit. Specify a line range or structural path.",
  {
    file_path: z.string().describe("Absolute path to the file"),
    range: z
      .string()
      .optional()
      .describe('Line range to expand: "start-end" (e.g. "212-280")'),
    path: z
      .string()
      .optional()
      .describe(
        'Structural path to expand (label substring, e.g. "loadScene" or "class SceneManager")',
      ),
  },
  async ({ file_path, range, path: structPath }) => {
    try {
      const absPath = path.resolve(file_path);
      if (!fs.existsSync(absPath)) {
        return { content: [{ type: "text" as const, text: `Error: File not found: ${absPath}` }] };
      }

      // Ensure file is analyzed
      const { tree, lines } = ensureAnalyzed(absPath);

      let startLine: number;
      let endLine: number;

      if (range) {
        // Parse "start-end"
        const match = range.match(/^(\d+)-(\d+)$/);
        if (!match) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Invalid range format "${range}". Expected "start-end" (e.g. "212-280").`,
              },
            ],
          };
        }
        startLine = parseInt(match[1]!, 10);
        endLine = parseInt(match[2]!, 10);
      } else if (structPath) {
        // Find node by label
        const node = findNodeByPath(tree.children, structPath);
        if (!node) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: No structural region found matching "${structPath}". Use structural_analyze to see available regions.`,
              },
            ],
          };
        }
        startLine = node.startLine;
        endLine = node.endLine;
      } else {
        return {
          content: [
            {
              type: "text" as const,
              text: 'Error: Specify either "range" or "path" parameter.',
            },
          ],
        };
      }

      // Bounds check
      startLine = Math.max(1, startLine);
      endLine = Math.min(lines.length, endLine);

      // Extract the lines and render with hashline tags
      const regionLines = lines.slice(startLine - 1, endLine);
      const rendered = renderHashlinedRegion(
        regionLines,
        startLine,
        endLine,
        computeHash,
      );

      // Add structural context header
      const node = findNodeForLine(tree.children, startLine);
      const contextPath = node ? ` (${node.label})` : "";
      const header = `${path.basename(absPath)}:${startLine}-${endLine}${contextPath}\n`;

      return { content: [{ type: "text" as const, text: header + rendered }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error expanding region: ${err}` }],
      };
    }
  },
);

// --- Tool: structural_edit ---

server.tool(
  "structural_edit",
  "Apply edits to a file using hashline tags from structural outlines or structural_expand. " +
    "Each edit references a LINE#HASH tag. Operations: set (replace one line), replace (range), " +
    "append, prepend, insert, delete. Edits are applied bottom-up so line numbers stay stable. " +
    "Preferred over native Edit for files with structural outlines.",
  {
    file_path: z.string().describe("Absolute path to the file"),
    edits: z
      .array(
        z.object({
          op: z.enum(["set", "replace", "append", "prepend", "insert", "delete"]),
          tag: z
            .string()
            .describe('LINE#HASH tag (e.g. "42#VRK")'),
          content: z
            .array(z.string())
            .optional()
            .describe("New content lines"),
          endTag: z
            .string()
            .optional()
            .describe("End tag for replace/delete range"),
        }),
      )
      .describe("Array of edit operations to apply"),
  },
  async ({ file_path, edits }) => {
    try {
      const absPath = path.resolve(file_path);
      if (!fs.existsSync(absPath)) {
        return { content: [{ type: "text" as const, text: `Error: File not found: ${absPath}` }] };
      }

      const fileContent = fs.readFileSync(absPath, "utf-8");
      const result = applyEdits(fileContent, edits);

      if (!result.success) {
        return {
          content: [{ type: "text" as const, text: `Edit failed: ${result.error}` }],
        };
      }

      // Write updated content
      fs.writeFileSync(absPath, result.content!, "utf-8");

      // Invalidate caches and re-index
      cache.invalidate(absPath);
      invalidateFilesystemCache(absPath);
      // Re-analyze to update index and write fresh cache
      ensureAnalyzed(absPath);

      const summary = `Applied ${edits.length} edit(s), ${result.linesChanged} lines changed.`;
      let output = summary;

      if (result.error) {
        output += `\nWarnings: ${result.error}`;
      }

      // Show updated hashlines around edited lines for verification/chaining
      if (result.updatedLines && result.updatedLines.length > 0) {
        const editLineNumbers = edits
          .map((e) => {
            const m = e.tag.match(/^(\d+)#/);
            return m ? parseInt(m[1]!, 10) : 0;
          })
          .filter((n) => n > 0);

        if (editLineNumbers.length > 0) {
          const minLine = Math.max(1, Math.min(...editLineNumbers) - 2);
          const maxLine = Math.min(
            result.updatedLines.length,
            Math.max(...editLineNumbers) + 2,
          );
          const window = result.updatedLines
            .filter((l) => l.lineNumber >= minLine && l.lineNumber <= maxLine)
            .map((l) => `${l.lineNumber}#${l.hash}:${l.content}`)
            .join("\n");
          output += `\n\n${window}`;
        }
      }

      return { content: [{ type: "text" as const, text: output }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error applying edits: ${err}` }],
      };
    }
  },
);

// --- Tool: structural_connections ---

server.tool(
  "structural_connections",
  "Get cross-file connections for a previously analyzed file. Shows which other " +
    "files are related via shared identifiers, with direction (defines/references) " +
    "and connection strength. No import parsing needed — uses token IDF analysis.",
  {
    file_path: z.string().describe("Absolute path to the file"),
    limit: z
      .number()
      .optional()
      .describe("Max connections to return (default: 10)"),
  },
  async ({ file_path, limit }) => {
    try {
      const absPath = path.resolve(file_path);

      // Ensure analyzed
      ensureAnalyzed(absPath);

      const connections = crossFileIndex.getConnections(absPath, limit ?? 10);

      if (connections.length === 0) {
        const indexedFiles = crossFileIndex.getIndexedFiles();
        if (indexedFiles.length < 2) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No connections found. Only ${indexedFiles.length} file(s) indexed this session. Analyze more files to discover cross-file relationships.`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `No connections found for ${path.basename(absPath)} among ${indexedFiles.length} indexed files.`,
            },
          ],
        };
      }

      const lines: string[] = [
        `Cross-file connections for ${path.basename(absPath)}:`,
        "",
      ];

      for (const conn of connections) {
        const arrow =
          conn.direction === "outgoing"
            ? "\u2192"
            : conn.direction === "incoming"
              ? "\u2190"
              : "\u2194";
        const typeLabel =
          conn.type === "api_dependency"
            ? conn.direction === "outgoing"
              ? "defines for"
              : "depends on"
            : conn.type === "shared_interface"
              ? "shared interface with"
              : "conceptually coupled to";
        const tokens = conn.sharedTokens.slice(0, 5).join(", ");
        const more =
          conn.sharedTokens.length > 5
            ? ` +${conn.sharedTokens.length - 5} more`
            : "";
        lines.push(
          `  ${arrow} ${path.basename(conn.targetFile)} (${typeLabel}, strength: ${conn.strength.toFixed(1)})`,
        );
        lines.push(`    via: ${tokens}${more}`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error getting connections: ${err}` }],
      };
    }
  },
);

// --- Tool: structural_search ---

server.tool(
  "structural_search",
  "Search across files with structural context. Results show not just the matching " +
    "line but also its structural location (which function/class/section it belongs to).",
  {
    pattern: z.string().describe("Search pattern (regex)"),
    path: z
      .string()
      .optional()
      .describe("Directory to search in (default: current working directory)"),
    glob: z.string().optional().describe('File glob filter (e.g. "*.ts")'),
    limit: z
      .number()
      .optional()
      .describe("Max results (default: 20)"),
  },
  async ({ pattern, path: searchPath, glob: globPattern, limit }) => {
    try {
      const dir = searchPath ?? process.cwd();
      const maxResults = limit ?? 20;

      // Build ripgrep args (use execFileSync to avoid shell interpretation)
      const rgArgs = ["--json", "-e", pattern];
      if (globPattern) {
        rgArgs.push("--glob", globPattern);
      }
      rgArgs.push("--max-count", String(maxResults * 2)); // overfetch for filtering
      rgArgs.push(dir);

      let rgOutput: string;
      try {
        rgOutput = execFileSync("rg", rgArgs, {
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024,
          timeout: 30000,
        });
      } catch (err: unknown) {
        // rg exits with code 1 when no matches found
        if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 1) {
          return { content: [{ type: "text" as const, text: "No matches found." }] };
        }
        throw err;
      }

      // Parse ripgrep JSON output
      interface RgMatch {
        filePath: string;
        lineNumber: number;
        lineContent: string;
      }

      const matches: RgMatch[] = [];
      for (const line of rgOutput.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === "match") {
            matches.push({
              filePath: parsed.data.path.text,
              lineNumber: parsed.data.line_number,
              lineContent: parsed.data.lines.text.replace(/\n$/, ""),
            });
          }
        } catch {
          // Skip unparseable lines
        }
      }

      if (matches.length === 0) {
        return { content: [{ type: "text" as const, text: "No matches found." }] };
      }

      // Group by file and add structural context
      const byFile = new Map<string, RgMatch[]>();
      for (const m of matches) {
        let list = byFile.get(m.filePath);
        if (!list) {
          list = [];
          byFile.set(m.filePath, list);
        }
        list.push(m);
      }

      const outputLines: string[] = [`Search: "${pattern}"`, ""];
      let resultCount = 0;

      for (const [filePath, fileMatches] of byFile) {
        if (resultCount >= maxResults) break;

        const absPath = path.resolve(filePath);

        // Try to get structural context
        let tree: StructuralTree | null = null;
        let lineCount = 0;
        try {
          const result = ensureAnalyzed(absPath);
          tree = result.tree;
          lineCount = result.lines.length;
        } catch {
          // If analysis fails, show without structural context
          try {
            const stat = fs.statSync(absPath);
            const content = fs.readFileSync(absPath, "utf-8");
            lineCount = content.split("\n").length;
          } catch {
            lineCount = 0;
          }
        }

        outputLines.push(`${filePath} [${lineCount} lines]`);

        for (const m of fileMatches) {
          if (resultCount >= maxResults) break;

          // Find structural context for this line
          let structContext = "";
          if (tree) {
            const node = findNodeForLine(tree.children, m.lineNumber);
            if (node) {
              structContext = ` > ${node.label}`;
            }
          }

          const hash = computeHash(m.lineContent);
          outputLines.push(
            `  ${m.lineNumber}#${hash}:${m.lineContent}${structContext ? `  ${structContext}` : ""}`,
          );
          resultCount++;
        }

        outputLines.push("");
      }

      return { content: [{ type: "text" as const, text: outputLines.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error searching: ${err}` }],
      };
    }
  },
);

// ============================================================================
// Startup
// ============================================================================

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
