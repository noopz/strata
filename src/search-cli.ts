#!/usr/bin/env node
/**
 * CLI for structural search — grep with structural context annotations.
 * Called by pre-grep.sh and pre-bash.sh hooks.
 *
 * Usage: node search-cli.js <pattern> [path] [glob]
 * Outputs annotated search results to stdout.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { analyzeFile } from "./structural-analyzer.js";
import { computeHash } from "./hashline.js";
import type { StructuralTree, StructuralNode } from "./types.js";

interface RgMatch {
  filePath: string;
  lineNumber: number;
  lineContent: string;
}

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

async function main(): Promise<void> {
  const pattern = process.argv[2];
  if (!pattern) {
    console.error("Usage: search-cli <pattern> [path] [glob]");
    process.exit(1);
  }

  const searchPath = process.argv[3] || process.cwd();
  const globPattern = process.argv[4];

  // Build ripgrep args (use execFileSync to avoid shell interpretation of |, etc.)
  const rgArgs = ["--json", "-e", pattern];
  if (globPattern) {
    rgArgs.push("--glob", globPattern);
  }
  rgArgs.push("--max-count", "40");
  rgArgs.push(searchPath);

  let rgOutput: string;
  try {
    rgOutput = execFileSync("rg", rgArgs, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15000,
    });
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "status" in err &&
      (err as { status: number }).status === 1
    ) {
      // No matches
      process.exit(0);
    }
    throw err;
  }

  // Parse ripgrep JSON output
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
    process.exit(0);
  }

  // Group by file
  const byFile = new Map<string, RgMatch[]>();
  for (const m of matches) {
    let list = byFile.get(m.filePath);
    if (!list) {
      list = [];
      byFile.set(m.filePath, list);
    }
    list.push(m);
  }

  // Analyze each file and annotate results
  const outputLines: string[] = [];
  let resultCount = 0;
  const maxResults = 20;

  for (const [filePath, fileMatches] of byFile) {
    if (resultCount >= maxResults) break;

    const absPath = path.resolve(filePath);
    let tree: StructuralTree | null = null;
    let lineCount = 0;

    try {
      const stat = fs.statSync(absPath);
      const content = fs.readFileSync(absPath, "utf-8");
      const lines = content.split("\n");
      lineCount = lines.length;
      tree = analyzeFile(lines, absPath, stat.mtimeMs);
    } catch {
      // Skip files we can't analyze
    }

    outputLines.push(`${filePath} [${lineCount} lines]`);

    for (const m of fileMatches) {
      if (resultCount >= maxResults) break;

      let structContext = "";
      if (tree) {
        const node = findNodeForLine(tree.children, m.lineNumber);
        if (node) {
          structContext = `  > ${node.label}`;
        }
      }

      const hash = computeHash(m.lineContent);
      outputLines.push(
        `  ${m.lineNumber}#${hash}:${m.lineContent}${structContext}`,
      );
      resultCount++;
    }

    outputLines.push("");
  }

  process.stdout.write(outputLines.join("\n"));
}

main().catch((err) => {
  console.error("search-cli error:", err);
  process.exit(1);
});
