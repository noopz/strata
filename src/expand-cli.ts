#!/usr/bin/env node
/**
 * CLI for hashlined content — renders a line range with hashline tags.
 * Called by pre-read.sh hook when offset/limit are present.
 *
 * Usage: node expand-cli.js <file_path> <offset> <limit>
 * Outputs hashlined content with structural context header to stdout.
 */

import fs from "node:fs";
import path from "node:path";
import { computeHash } from "./hashline.js";
import { renderHashlinedRegion } from "./formatter.js";
import { analyzeFile } from "./structural-analyzer.js";
import type { StructuralNode } from "./types.js";

function findNodeForLine(
  nodes: StructuralNode[],
  lineNumber: number,
): StructuralNode | null {
  for (const node of nodes) {
    if (lineNumber >= node.startLine && lineNumber <= node.endLine) {
      const childMatch = findNodeForLine(node.children, lineNumber);
      return childMatch ?? node;
    }
  }
  return null;
}

const filePath = process.argv[2];
const offset = process.argv[3] ? parseInt(process.argv[3], 10) : undefined;
const limit = process.argv[4] ? parseInt(process.argv[4], 10) : undefined;

if (!filePath || offset === undefined || limit === undefined) {
  console.error("Usage: expand-cli <file_path> <offset> <limit>");
  process.exit(1);
}

const absPath = path.resolve(filePath);
if (!fs.existsSync(absPath)) {
  console.error(`File not found: ${absPath}`);
  process.exit(1);
}

const stat = fs.statSync(absPath);
const content = fs.readFileSync(absPath, "utf-8");
const allLines = content.split("\n");

// offset is 1-based start line, limit is number of lines
const startLine = Math.max(1, offset);
const endLine = Math.min(allLines.length, startLine + limit - 1);
const regionLines = allLines.slice(startLine - 1, endLine);

// Render hashlined region
const rendered = renderHashlinedRegion(regionLines, startLine, endLine, computeHash);

// Get structural context for the header
let contextLabel = "";
try {
  const tree = analyzeFile(allLines, absPath, stat.mtimeMs);
  const node = findNodeForLine(tree.children, startLine);
  if (node) {
    contextLabel = ` (${node.label})`;
  }
} catch {
  // Skip structural context if analysis fails
}

const header = `${path.basename(absPath)}:${startLine}-${endLine}${contextLabel}`;
process.stdout.write(`${header}\n${rendered}`);
