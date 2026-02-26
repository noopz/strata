import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderStructuralView,
  renderHashlinedRegion,
} from "./formatter.js";
import type {
  StructuralTree,
  StructuralNode,
  CrossFileConnection,
} from "./types.js";

function makeNode(partial: Partial<StructuralNode>): StructuralNode {
  return {
    startLine: 1,
    endLine: 10,
    label: "block",
    labelLine: partial.startLine ?? 1,
    depth: 0,
    entropy: 0.5,
    similarity: 0.0,
    collapsed: false,
    children: [],
    ...partial,
  };
}

describe("renderStructuralView", () => {
  it("renders a simple tree", () => {
    const tree: StructuralTree = {
      filePath: "/src/app/main.ts",
      mtime: 1000,
      lineCount: 120,
      children: [
        makeNode({ startLine: 1, endLine: 45, label: "import block" }),
        makeNode({
          startLine: 47,
          endLine: 120,
          label: "class App",
          children: [
            makeNode({ startLine: 49, endLine: 80, label: "constructor()" }),
            makeNode({ startLine: 82, endLine: 120, label: "run()" }),
          ],
        }),
      ],
    };

    const result = renderStructuralView(tree);
    const lines = result.split("\n");

    assert.equal(lines[0], "main.ts [120 lines]");
    assert.equal(lines[1], "  ---");
    assert.equal(lines[2], "  [1-45] import block");
    assert.equal(lines[3], "  [47-120] class App");
    assert.equal(lines[4], "    [49-80] constructor()");
    assert.equal(lines[5], "    [82-120] run()");
  });

  it("renders connections with direction arrows", () => {
    const tree: StructuralTree = {
      filePath: "/src/utils.ts",
      mtime: 1000,
      lineCount: 50,
      children: [],
    };

    const connections: CrossFileConnection[] = [
      {
        sourceFile: "/src/utils.ts",
        targetFile: "/src/app.ts",
        type: "api_dependency",
        sharedTokens: ["loadConfig"],
        strength: 5.0,
        direction: "outgoing",
      },
      {
        sourceFile: "/src/utils.ts",
        targetFile: "/src/db.ts",
        type: "api_dependency",
        sharedTokens: ["connect"],
        strength: 3.0,
        direction: "incoming",
      },
      {
        sourceFile: "/src/utils.ts",
        targetFile: "/src/shared.ts",
        type: "shared_interface",
        sharedTokens: ["Config"],
        strength: 4.0,
        direction: "bidirectional",
      },
    ];

    const result = renderStructuralView(tree, connections);
    const lines = result.split("\n");

    assert.equal(lines[0], "utils.ts [50 lines]");
    // Sorted by strength: 5.0, 4.0, 3.0
    assert.equal(
      lines[1],
      "  connections: \u2192 app.ts, \u2194 shared.ts, \u2190 db.ts",
    );
    assert.equal(lines[2], "  ---");
  });

  it("limits connections to top 5", () => {
    const tree: StructuralTree = {
      filePath: "/src/hub.ts",
      mtime: 1000,
      lineCount: 10,
      children: [],
    };

    const connections: CrossFileConnection[] = [];
    for (let i = 0; i < 8; i++) {
      connections.push({
        sourceFile: "/src/hub.ts",
        targetFile: `/src/mod${i}.ts`,
        type: "api_dependency",
        sharedTokens: ["tok"],
        strength: 10 - i,
        direction: "outgoing",
      });
    }

    const result = renderStructuralView(tree, connections);
    const connLine = result.split("\n")[1];
    // Count arrows - should be exactly 5
    const arrowCount = (connLine.match(/\u2192/g) || []).length;
    assert.equal(arrowCount, 5);
  });

  it("renders collapsed nodes with pattern and sample", () => {
    const tree: StructuralTree = {
      filePath: "/src/models.ts",
      mtime: 1000,
      lineCount: 500,
      children: [
        makeNode({
          startLine: 100,
          endLine: 400,
          label: "getter methods",
          collapsed: true,
          pattern: "200 similar getter methods",
          sampleLine: "getName(): string { return this.name; }",
        }),
      ],
    };

    const result = renderStructuralView(tree);
    const lines = result.split("\n");

    assert.equal(lines[2], "  [100-400] 200 similar getter methods");
    assert.equal(
      lines[3],
      "    sample: getName(): string { return this.name; }",
    );
  });

  it("renders hashline-tagged labels when hashFn and fileLines provided", () => {
    const fileLines = [
      "import stuff",            // line 1
      "",                         // line 2
      "function hello() {",      // line 3
      "  return 42;",            // line 4
      "}",                        // line 5
    ];
    const hashFn = (s: string) => "ABC";

    const tree: StructuralTree = {
      filePath: "/src/tagged.ts",
      mtime: 1000,
      lineCount: 5,
      children: [
        makeNode({ startLine: 1, endLine: 2, label: "import stuff", labelLine: 1 }),
        makeNode({ startLine: 3, endLine: 5, label: "function hello() {", labelLine: 3 }),
      ],
    };

    const result = renderStructuralView(tree, undefined, undefined, hashFn, fileLines);
    const lines = result.split("\n");

    assert.equal(lines[2], "  [1-2] 1#ABC:import stuff");
    assert.equal(lines[3], "  [3-5] 3#ABC:function hello() {");
  });

  it("computes hash from raw file line, not truncated label", () => {
    // File line has leading spaces; label is trimmed
    const fileLines = [
      "    function indented() {",  // line 1 — raw with leading spaces
    ];
    const hashes: string[] = [];
    const hashFn = (s: string) => {
      hashes.push(s);
      return "XYZ";
    };

    const tree: StructuralTree = {
      filePath: "/src/indent.ts",
      mtime: 1000,
      lineCount: 1,
      children: [
        makeNode({ startLine: 1, endLine: 1, label: "function indented() {", labelLine: 1 }),
      ],
    };

    const result = renderStructuralView(tree, undefined, undefined, hashFn, fileLines);
    // hashFn should have been called with the raw file line, not the trimmed label
    assert.equal(hashes[0], "    function indented() {");
    assert.ok(result.includes("1#XYZ:function indented() {"));
  });

  it("renders collapsed node with untagged pattern and tagged sample", () => {
    const fileLines = [
      "function getProp1() {",   // line 1
      "  return this.prop1;",    // line 2
      "}",                        // line 3
      "",                         // line 4
      "function getProp2() {",   // line 5
      "  return this.prop2;",    // line 6
      "}",                        // line 7
    ];
    const hashFn = () => "QRS";

    const tree: StructuralTree = {
      filePath: "/src/collapsed.ts",
      mtime: 1000,
      lineCount: 7,
      children: [
        makeNode({
          startLine: 1,
          endLine: 7,
          label: "2 similar regions (7 lines)",
          labelLine: 1,
          collapsed: true,
          pattern: "2 similar regions",
          sampleLine: "function getProp1() {",
        }),
      ],
    };

    const result = renderStructuralView(tree, undefined, undefined, hashFn, fileLines);
    const lines = result.split("\n");

    // Pattern label is untagged
    assert.equal(lines[2], "  [1-7] 2 similar regions");
    // Sample line is tagged
    assert.equal(lines[3], "    sample: 1#QRS:function getProp1() {");
  });

  it("renders without hashFn/fileLines unchanged (backward-compatible)", () => {
    const tree: StructuralTree = {
      filePath: "/src/plain.ts",
      mtime: 1000,
      lineCount: 10,
      children: [
        makeNode({ startLine: 1, endLine: 10, label: "function foo()", labelLine: 1 }),
      ],
    };

    const result = renderStructuralView(tree);
    const lines = result.split("\n");
    assert.equal(lines[2], "  [1-10] function foo()");
  });

  it("falls back to untagged when labelLine is out of bounds", () => {
    const fileLines = ["only one line"];
    const hashFn = () => "ABC";

    const tree: StructuralTree = {
      filePath: "/src/oob.ts",
      mtime: 1000,
      lineCount: 1,
      children: [
        makeNode({ startLine: 1, endLine: 1, label: "only one line", labelLine: 99 }),
      ],
    };

    const result = renderStructuralView(tree, undefined, undefined, hashFn, fileLines);
    const lines = result.split("\n");
    // Should render without tag since labelLine 99 is out of bounds
    assert.equal(lines[2], "  [1-1] only one line");
  });

  it("respects maxDepth", () => {
    const tree: StructuralTree = {
      filePath: "/src/deep.ts",
      mtime: 1000,
      lineCount: 200,
      children: [
        makeNode({
          startLine: 1,
          endLine: 200,
          label: "class Deep",
          children: [
            makeNode({
              startLine: 10,
              endLine: 100,
              label: "method()",
              children: [
                makeNode({ startLine: 20, endLine: 50, label: "inner block" }),
              ],
            }),
          ],
        }),
      ],
    };

    // maxDepth=2 means depth 0 (header) + depth 1 (top children) + depth 2 (grandchildren shown truncated)
    const result = renderStructuralView(tree, undefined, 2);
    const lines = result.split("\n");

    assert.equal(lines[2], "  [1-200] class Deep");
    assert.equal(lines[3], "    [10-100] ... (1 children)");
  });
});


describe("renderHashlinedRegion", () => {
  it("renders lines with hash tags", () => {
    const lines = ["function foo() {", "  return 42;", "}"];
    const hashFn = (s: string) => s.length.toString(16).padStart(3, "0");

    const result = renderHashlinedRegion(lines, 10, 12, hashFn);
    const output = result.split("\n");

    assert.equal(output.length, 3);
    assert.equal(output[0], `10#010:function foo() {`);
    assert.equal(output[1], `11#00c:  return 42;`);
    assert.equal(output[2], `12#001:}`);
  });

  it("handles single line", () => {
    const lines = ["hello"];
    const hashFn = () => "ABC";

    const result = renderHashlinedRegion(lines, 5, 5, hashFn);
    assert.equal(result, "5#ABC:hello");
  });
});
