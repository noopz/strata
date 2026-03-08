import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderStructuralView } from "./formatter.js";
function makeNode(partial) {
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
    it("renders a simple tree with line-number tags", () => {
        const tree = {
            filePath: "/src/app/main.ts",
            mtime: 1000,
            lineCount: 120,
            children: [
                makeNode({ startLine: 1, endLine: 45, label: "import block", labelLine: 1 }),
                makeNode({
                    startLine: 47,
                    endLine: 120,
                    label: "class App",
                    labelLine: 47,
                    children: [
                        makeNode({ startLine: 49, endLine: 80, label: "constructor()", labelLine: 49 }),
                        makeNode({ startLine: 82, endLine: 120, label: "run()", labelLine: 82 }),
                    ],
                }),
            ],
        };
        const result = renderStructuralView(tree);
        const lines = result.split("\n");
        assert.equal(lines[0], "main.ts [120 lines]");
        assert.equal(lines[1], "  ---");
        assert.equal(lines[2], "  [1-45] 1:import block");
        assert.equal(lines[3], "  [47-120] 47:class App");
        assert.equal(lines[4], "    [49-80] 49:constructor()");
        assert.equal(lines[5], "    [82-120] 82:run()");
    });
    it("renders connections with direction arrows", () => {
        const tree = {
            filePath: "/src/utils.ts",
            mtime: 1000,
            lineCount: 50,
            children: [],
        };
        const connections = [
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
        assert.equal(lines[1], "  connections: \u2192 app.ts, \u2194 shared.ts, \u2190 db.ts");
        assert.equal(lines[2], "  ---");
    });
    it("limits connections to top 5", () => {
        const tree = {
            filePath: "/src/hub.ts",
            mtime: 1000,
            lineCount: 10,
            children: [],
        };
        const connections = [];
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
        const arrowCount = (connLine.match(/\u2192/g) || []).length;
        assert.equal(arrowCount, 5);
    });
    it("renders collapsed nodes with pattern and sample", () => {
        const tree = {
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
        assert.equal(lines[3], "    sample: getName(): string { return this.name; }");
    });
    it("renders line-number-tagged labels", () => {
        const tree = {
            filePath: "/src/tagged.ts",
            mtime: 1000,
            lineCount: 5,
            children: [
                makeNode({ startLine: 1, endLine: 2, label: "import stuff", labelLine: 1 }),
                makeNode({ startLine: 3, endLine: 5, label: "function hello() {", labelLine: 3 }),
            ],
        };
        const result = renderStructuralView(tree);
        const lines = result.split("\n");
        assert.equal(lines[2], "  [1-2] 1:import stuff");
        assert.equal(lines[3], "  [3-5] 3:function hello() {");
    });
    it("respects maxDepth", () => {
        const tree = {
            filePath: "/src/deep.ts",
            mtime: 1000,
            lineCount: 200,
            children: [
                makeNode({
                    startLine: 1,
                    endLine: 200,
                    label: "class Deep",
                    labelLine: 1,
                    children: [
                        makeNode({
                            startLine: 10,
                            endLine: 100,
                            label: "method()",
                            labelLine: 10,
                            children: [
                                makeNode({ startLine: 20, endLine: 50, label: "inner block", labelLine: 20 }),
                            ],
                        }),
                    ],
                }),
            ],
        };
        const result = renderStructuralView(tree, undefined, 2);
        const lines = result.split("\n");
        assert.equal(lines[2], "  [1-200] 1:class Deep");
        assert.equal(lines[3], "    [10-100] ... (1 children)");
    });
});
//# sourceMappingURL=formatter.test.js.map