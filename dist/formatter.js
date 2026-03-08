import { basename } from "node:path";
function directionArrow(direction) {
    switch (direction) {
        case "outgoing":
            return "\u2192";
        case "incoming":
            return "\u2190";
        case "bidirectional":
            return "\u2194";
    }
}
function renderNode(node, depth, maxDepth, lines) {
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
            lines.push(`${indent}  sample: ${node.sampleLine}`);
        }
        return;
    }
    lines.push(`${indent}${range} ${node.labelLine}:${node.label}`);
    for (const child of node.children) {
        renderNode(child, depth + 1, maxDepth, lines);
    }
}
export function renderStructuralView(tree, connections, maxDepth) {
    const lines = [];
    lines.push(`${basename(tree.filePath)} [${tree.lineCount} lines]`);
    if (connections && connections.length > 0) {
        const sorted = [...connections].sort((a, b) => b.strength - a.strength);
        const top = sorted.slice(0, 5);
        const parts = top.map((c) => {
            const arrow = directionArrow(c.direction);
            return `${arrow} ${basename(c.targetFile)}`;
        });
        lines.push(`  connections: ${parts.join(", ")}`);
    }
    lines.push("  ---");
    for (const child of tree.children) {
        renderNode(child, 1, maxDepth, lines);
    }
    return lines.join("\n");
}
//# sourceMappingURL=formatter.js.map