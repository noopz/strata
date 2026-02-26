import { basename } from "node:path";
import type {
  CrossFileConnection,
  StructuralNode,
  StructuralTree,
} from "./types.js";

function directionArrow(
  direction: CrossFileConnection["direction"],
): string {
  switch (direction) {
    case "outgoing":
      return "\u2192";
    case "incoming":
      return "\u2190";
    case "bidirectional":
      return "\u2194";
  }
}

function renderNode(
  node: StructuralNode,
  depth: number,
  maxDepth: number | undefined,
  lines: string[],
  hashFn?: (content: string) => string,
  fileLines?: string[],
): void {
  const indent = "  ".repeat(depth);
  const range = `[${node.startLine}-${node.endLine}]`;

  if (maxDepth !== undefined && depth >= maxDepth && node.children.length > 0) {
    lines.push(`${indent}${range} ... (${node.children.length} children)`);
    return;
  }

  if (node.collapsed) {
    const label = node.pattern ?? node.label;
    lines.push(`${indent}${range} ${label}`);
    if (node.sampleLine) {
      const taggedSample = tagLabel(node, hashFn, fileLines, node.sampleLine);
      lines.push(`${indent}  sample: ${taggedSample ?? node.sampleLine}`);
    }
    return;
  }

  const tagPrefix = tagLabel(node, hashFn, fileLines);
  if (tagPrefix !== undefined) {
    lines.push(`${indent}${range} ${tagPrefix}`);
  } else {
    lines.push(`${indent}${range} ${node.label}`);
  }

  for (const child of node.children) {
    renderNode(child, depth + 1, maxDepth, lines, hashFn, fileLines);
  }
}

function tagLabel(
  node: StructuralNode,
  hashFn?: (content: string) => string,
  fileLines?: string[],
  labelOverride?: string,
): string | undefined {
  if (!hashFn || !fileLines) return undefined;
  const idx = node.labelLine - 1;
  if (idx < 0 || idx >= fileLines.length) return undefined;
  const hash = hashFn(fileLines[idx]!);
  return `${node.labelLine}#${hash}:${labelOverride ?? node.label}`;
}

export function renderStructuralView(
  tree: StructuralTree,
  connections?: CrossFileConnection[],
  maxDepth?: number,
  hashFn?: (content: string) => string,
  fileLines?: string[],
): string {
  const lines: string[] = [];

  lines.push(`${basename(tree.filePath)} [${tree.lineCount} lines]`);

  if (connections && connections.length > 0) {
    const sorted = [...connections].sort((a, b) => b.strength - a.strength);
    const top = sorted.slice(0, 5);
    const parts = top.map((c) => {
      const arrow = directionArrow(c.direction);
      // targetFile is always the "other" file (sourceFile is the queried file)
      return `${arrow} ${basename(c.targetFile)}`;
    });
    lines.push(`  connections: ${parts.join(", ")}`);
  }

  lines.push("  ---");

  for (const child of tree.children) {
    renderNode(child, 1, maxDepth, lines, hashFn, fileLines);
  }

  return lines.join("\n");
}


export function renderHashlinedRegion(
  lines: string[],
  startLine: number,
  endLine: number,
  hashFn: (content: string) => string,
): string {
  const output: string[] = [];
  for (let i = startLine; i <= endLine; i++) {
    const idx = i - startLine;
    const content = idx < lines.length ? lines[idx] : "";
    const hash = hashFn(content);
    output.push(`${i}#${hash}:${content}`);
  }
  return output.join("\n");
}
