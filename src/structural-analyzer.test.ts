import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeFile,
  shannonEntropy,
  jaccardSimilarity,
  indentDepth,
  bracketDelta,
} from "./structural-analyzer.js";

// ---------------------------------------------------------------------------
// Helper: split multi-line template string into lines array
// ---------------------------------------------------------------------------
function toLines(s: string): string[] {
  // Remove leading newline from template literals
  const trimmed = s.startsWith("\n") ? s.slice(1) : s;
  return trimmed.split("\n");
}

// ---------------------------------------------------------------------------
// Unit tests for signal helpers
// ---------------------------------------------------------------------------

describe("shannonEntropy", () => {
  it("returns 0 for empty string", () => {
    assert.equal(shannonEntropy(""), 0);
  });

  it("returns 0 for single-character string", () => {
    assert.equal(shannonEntropy("aaaa"), 0);
  });

  it("returns 1 for two equally frequent characters", () => {
    const h = shannonEntropy("ab");
    assert.ok(Math.abs(h - 1.0) < 0.001, `expected ~1.0, got ${h}`);
  });

  it("higher entropy for more diverse characters", () => {
    const hLow = shannonEntropy("aaabbb");
    const hHigh = shannonEntropy("abcdef");
    assert.ok(hHigh > hLow, `expected ${hHigh} > ${hLow}`);
  });
});

describe("jaccardSimilarity", () => {
  it("returns 1 for identical strings", () => {
    assert.equal(jaccardSimilarity("hello world", "hello world"), 1);
  });

  it("returns 1 for two empty strings", () => {
    assert.equal(jaccardSimilarity("", ""), 1);
  });

  it("returns 0 for completely different strings", () => {
    const sim = jaccardSimilarity("aaa", "zzz");
    assert.equal(sim, 0);
  });

  it("returns value between 0 and 1 for partially similar strings", () => {
    const sim = jaccardSimilarity(
      "function hello() {",
      "function world() {",
    );
    assert.ok(sim > 0 && sim < 1, `expected 0 < ${sim} < 1`);
  });
});

describe("indentDepth", () => {
  it("returns 0 for unindented line", () => {
    assert.equal(indentDepth("hello"), 0);
  });

  it("counts spaces", () => {
    assert.equal(indentDepth("    hello"), 4);
  });

  it("normalizes tabs to 4 spaces", () => {
    assert.equal(indentDepth("\thello"), 4);
  });

  it("handles mixed tabs and spaces", () => {
    assert.equal(indentDepth("\t  hello"), 6);
  });

  it("returns 0 for empty string", () => {
    assert.equal(indentDepth(""), 0);
  });
});

describe("bracketDelta", () => {
  it("returns +1 for opening bracket", () => {
    assert.equal(bracketDelta("{"), 1);
  });

  it("returns -1 for closing bracket", () => {
    assert.equal(bracketDelta("}"), -1);
  });

  it("returns 0 for balanced line", () => {
    assert.equal(bracketDelta("if (x) { y }"), 0);
  });

  it("handles multiple brackets", () => {
    assert.equal(bracketDelta("{{"), 2);
    assert.equal(bracketDelta("}}"), -2);
  });

  it("returns 0 for no brackets", () => {
    assert.equal(bracketDelta("hello world"), 0);
  });
});

// ---------------------------------------------------------------------------
// Integration tests for analyzeFile
// ---------------------------------------------------------------------------

describe("analyzeFile", () => {
  it("handles empty file", () => {
    const tree = analyzeFile([], "/test/empty.ts", 1000);
    assert.equal(tree.filePath, "/test/empty.ts");
    assert.equal(tree.mtime, 1000);
    assert.equal(tree.lineCount, 0);
    assert.equal(tree.children.length, 0);
  });

  it("handles single line file", () => {
    const tree = analyzeFile(["export const x = 42;"], "/test/single.ts", 1000);
    assert.equal(tree.lineCount, 1);
    assert.equal(tree.children.length, 1);
    assert.equal(tree.children[0]!.startLine, 1);
    assert.equal(tree.children[0]!.endLine, 1);
    assert.equal(tree.children[0]!.label, "export const x = 42;");
    assert.equal(tree.children[0]!.labelLine, 1);
  });

  it("detects boundaries in a simple function", () => {
    const content = toLines(`
function hello() {
  console.log("hello");
  return true;
}

function world() {
  console.log("world");
  return false;
}

function another() {
  const x = 1;
  const y = 2;
  return x + y;
}`);

    const tree = analyzeFile(content, "/test/funcs.ts", 1000, 3);
    assert.equal(tree.lineCount, content.length);
    // Should have multiple children (split at blank lines / bracket depth returns)
    assert.ok(
      tree.children.length >= 2,
      `expected >= 2 children, got ${tree.children.length}`,
    );
    // All children should cover the full range
    const firstChild = tree.children[0]!;
    const lastChild = tree.children[tree.children.length - 1]!;
    assert.equal(firstChild.startLine, 1);
    assert.equal(lastChild.endLine, content.length);
  });

  it("collapses repetitive regions", () => {
    // Generate many similar getter-like lines separated by blank lines
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) {
      lines.push(`function getProp${i}() {`);
      lines.push(`  return this.prop${i};`);
      lines.push(`}`);
      lines.push("");
    }

    const tree = analyzeFile(lines, "/test/getters.ts", 1000, 4);
    assert.ok(tree.lineCount > 0);

    // With similarity collapse, we should have fewer nodes than there are functions
    function countNodes(nodes: typeof tree.children): number {
      let count = 0;
      for (const n of nodes) {
        count++;
        count += countNodes(n.children);
      }
      return count;
    }
    const totalNodes = countNodes(tree.children);
    // 30 functions but should be collapsed; at minimum, fewer than 30 top-level nodes
    assert.ok(
      totalNodes < 30,
      `expected < 30 nodes with collapse, got ${totalNodes}`,
    );

    // Check that at least one node is collapsed
    function hasCollapsed(nodes: typeof tree.children): boolean {
      for (const n of nodes) {
        if (n.collapsed) return true;
        if (hasCollapsed(n.children)) return true;
      }
      return false;
    }
    assert.ok(
      hasCollapsed(tree.children),
      "expected at least one collapsed node",
    );
  });

  it("produces tree covering the full line range", () => {
    const content = toLines(`
import { Foo } from "./foo";
import { Bar } from "./bar";
import { Baz } from "./baz";

export class MyService {
  private foo: Foo;
  private bar: Bar;

  constructor(foo: Foo, bar: Bar) {
    this.foo = foo;
    this.bar = bar;
  }

  async processRequest(req: Request): Promise<Response> {
    const data = await this.foo.getData(req.id);
    if (!data) {
      throw new Error("not found");
    }
    const result = this.bar.transform(data);
    return new Response(JSON.stringify(result));
  }

  async handleBatch(items: string[]): Promise<void> {
    for (const item of items) {
      await this.processRequest({ id: item } as Request);
    }
  }
}`);

    const tree = analyzeFile(content, "/test/service.ts", 1000, 4);
    assert.equal(tree.lineCount, content.length);

    // Check that children collectively cover [1, lineCount]
    if (tree.children.length > 0) {
      assert.equal(tree.children[0]!.startLine, 1);
      assert.equal(
        tree.children[tree.children.length - 1]!.endLine,
        content.length,
      );
    }
  });

  it("respects maxDepth parameter", () => {
    const content = toLines(`
function outer() {
  function inner() {
    function deepest() {
      return 42;
    }
    return deepest();
  }
  return inner();
}

function another() {
  return 1;
}

function yetAnother() {
  return 2;
}

function andMore() {
  return 3;
}

function keepGoing() {
  return 4;
}

function lastOne() {
  const a = 1;
  const b = 2;
  return a + b;
}`);

    // maxDepth 1: should be a flat outline
    const tree1 = analyzeFile(content, "/test/nested.ts", 1000, 1);
    function maxTreeDepth(
      nodes: typeof tree1.children,
      currentDepth: number,
    ): number {
      if (nodes.length === 0) return currentDepth;
      let max = currentDepth;
      for (const n of nodes) {
        const childDepth = maxTreeDepth(n.children, currentDepth + 1);
        if (childDepth > max) max = childDepth;
      }
      return max;
    }
    const depth1 = maxTreeDepth(tree1.children, 0);
    // At depth 1, children should be leaves (no grandchildren)
    assert.ok(depth1 <= 1, `expected tree depth <= 1, got ${depth1}`);
  });

  it("handles file with only blank lines", () => {
    const lines = ["", "", "", ""];
    const tree = analyzeFile(lines, "/test/blanks.txt", 1000);
    assert.equal(tree.lineCount, 4);
    assert.ok(tree.children.length >= 1);
  });

  it("handles file with only comments", () => {
    const lines = [
      "// This is a comment",
      "// Another comment",
      "// Yet another comment",
    ];
    const tree = analyzeFile(lines, "/test/comments.ts", 1000);
    assert.equal(tree.lineCount, 3);
    assert.ok(tree.children.length >= 1);
    // Label should fall back to first line (all are comments)
    assert.ok(tree.children[0]!.label.includes("//"));
  });

  it("extracts meaningful labels", () => {
    const content = toLines(`
// Module header comment
// More comments
export function calculateTotal(items: Item[]): number {
  let total = 0;
  for (const item of items) {
    total += item.price;
  }
  return total;
}`);

    const tree = analyzeFile(content, "/test/labels.ts", 1000, 3);
    // The label should be the function signature, not the comment
    function findLabel(
      nodes: typeof tree.children,
      substr: string,
    ): boolean {
      for (const n of nodes) {
        if (n.label.includes(substr)) return true;
        if (findLabel(n.children, substr)) return true;
      }
      return false;
    }
    assert.ok(
      findLabel(tree.children, "calculateTotal") ||
        findLabel(tree.children, "export"),
      "expected label containing function name or export keyword",
    );
  });

  it("uses smart thresholds when maxDepth is not provided", () => {
    // Small file: < 300 lines → depth 1
    const smallLines: string[] = [];
    for (let i = 0; i < 50; i++) {
      smallLines.push(`const var${i} = ${i};`);
      smallLines.push("");
    }
    const smallTree = analyzeFile(smallLines, "/test/small.ts", 1000);

    // With depth 1, every child should be a leaf
    for (const child of smallTree.children) {
      assert.equal(
        child.children.length,
        0,
        "expected leaf children for small file",
      );
    }
  });

  it("truncates labels to 80 characters", () => {
    const longLine =
      "export function thisIsAVeryLongFunctionNameThatShouldBeTruncatedBecauseItExceedsTheMaximumLabelLength(param1: string, param2: number): boolean {";
    const lines = [longLine, "  return true;", "}"];
    const tree = analyzeFile(lines, "/test/long.ts", 1000);
    assert.ok(tree.children.length >= 1);
    assert.ok(
      tree.children[0]!.label.length <= 80,
      `label too long: ${tree.children[0]!.label.length}`,
    );
  });

  it("produces correct 1-based line numbers", () => {
    const content = toLines(`
line one
line two
line three`);

    const tree = analyzeFile(content, "/test/lines.ts", 1000);
    assert.equal(tree.lineCount, content.length);
    if (tree.children.length > 0) {
      // First child should start at line 1
      assert.equal(tree.children[0]!.startLine, 1);
      // Last child should end at lineCount
      const last = tree.children[tree.children.length - 1]!;
      assert.equal(last.endLine, content.length);
    }
  });

  it("sets labelLine to first real content line, skipping blanks and comments", () => {
    const content = toLines(`
// comment line 1
// comment line 2

export function realContent() {
  return true;
}`);
    // After toLines: [0]="// comment line 1", [1]="// comment line 2", [2]="",
    //                [3]="export function realContent() {", [4]="  return true;", [5]="}"
    // So the export line is at 0-based index 3 → 1-based line 4

    const tree = analyzeFile(content, "/test/labelline.ts", 1000, 3);
    function findNodeWithLabel(
      nodes: typeof tree.children,
      substr: string,
    ): (typeof tree.children)[0] | undefined {
      for (const n of nodes) {
        if (n.label.includes(substr)) return n;
        const found = findNodeWithLabel(n.children, substr);
        if (found) return found;
      }
      return undefined;
    }
    const node = findNodeWithLabel(tree.children, "realContent");
    if (node) {
      // labelLine should point to the "export function realContent()" line, not the comments
      assert.equal(node.labelLine, 4, `expected labelLine=4 (the export line), got ${node.labelLine}`);
    }
    // All nodes should have labelLine set
    function checkLabelLine(nodes: typeof tree.children): void {
      for (const n of nodes) {
        assert.ok(typeof n.labelLine === "number" && n.labelLine >= 1,
          `node ${n.label} missing valid labelLine, got ${n.labelLine}`);
        checkLabelLine(n.children);
      }
    }
    checkLabelLine(tree.children);
  });

  it("handles large mixed-content file", () => {
    const lines: string[] = [];
    // Imports section
    for (let i = 0; i < 10; i++) {
      lines.push(`import { Module${i} } from "./module${i}";`);
    }
    lines.push("");
    // Class with methods
    lines.push("export class DataProcessor {");
    for (let i = 0; i < 20; i++) {
      lines.push(`  process${i}(data: any): void {`);
      lines.push(`    console.log("processing ${i}");`);
      lines.push(`    this.validate(data);`);
      lines.push(`    this.transform(data);`);
      lines.push(`  }`);
      lines.push("");
    }
    lines.push("}");
    lines.push("");
    // Standalone functions
    for (let i = 0; i < 5; i++) {
      lines.push(`function helper${i}(): void {`);
      lines.push(`  return;`);
      lines.push(`}`);
      lines.push("");
    }

    const tree = analyzeFile(lines, "/test/mixed.ts", 1000, 4);
    assert.equal(tree.lineCount, lines.length);
    assert.ok(tree.children.length >= 2, "expected multiple top-level regions");
  });
});
