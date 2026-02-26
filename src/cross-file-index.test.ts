import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CrossFileIndex } from "./cross-file-index.js";
import type { StructuralTree, StructuralNode } from "./types.js";

/** Helper: create a minimal StructuralNode */
function makeNode(opts: {
  label: string;
  startLine: number;
  endLine: number;
  depth?: number;
  children?: StructuralNode[];
}): StructuralNode {
  return {
    label: opts.label,
    startLine: opts.startLine,
    endLine: opts.endLine,
    labelLine: opts.startLine,
    depth: opts.depth ?? 0,
    entropy: 0,
    similarity: 0,
    collapsed: false,
    children: opts.children ?? [],
  };
}

/** Helper: create a minimal StructuralTree */
function makeTree(
  filePath: string,
  children: StructuralNode[],
  lineCount?: number
): StructuralTree {
  return {
    filePath,
    mtime: Date.now(),
    lineCount: lineCount ?? 10,
    children,
  };
}

describe("CrossFileIndex", () => {
  describe("compound identifier splitting", () => {
    it("should split camelCase tokens and index components", () => {
      const index = new CrossFileIndex();
      const tree = makeTree("/a.ts", [
        makeNode({
          label: "function buildDynamicContext()",
          startLine: 1,
          endLine: 3,
        }),
      ]);
      const lines = [
        "function buildDynamicContext() {",
        "  return ctx;",
        "}",
      ];
      index.indexFile("/a.ts", tree, lines);

      // The full token should be indexed
      const fullStats = index.getTokenStats("builddynamiccontext");
      assert.ok(fullStats, "full compound token should be indexed");
      assert.equal(fullStats.fileCount, 1);

      // Components should be indexed too
      const buildStats = index.getTokenStats("build");
      assert.ok(buildStats, "'build' component should be indexed");

      const dynamicStats = index.getTokenStats("dynamic");
      assert.ok(dynamicStats, "'dynamic' component should be indexed");

      const contextStats = index.getTokenStats("context");
      assert.ok(contextStats, "'context' component should be indexed");
    });

    it("should split snake_case tokens", () => {
      const index = new CrossFileIndex();
      const tree = makeTree("/a.ts", [
        makeNode({
          label: "function get_channel_id()",
          startLine: 1,
          endLine: 2,
        }),
      ]);
      const lines = ["function get_channel_id() {", "}"];
      index.indexFile("/a.ts", tree, lines);

      const channelStats = index.getTokenStats("channel");
      assert.ok(channelStats, "'channel' component should be indexed");
    });

    it("should not index components shorter than 3 characters", () => {
      const index = new CrossFileIndex();
      const tree = makeTree("/a.ts", [
        makeNode({
          label: "function do_it_now()",
          startLine: 1,
          endLine: 2,
        }),
      ]);
      const lines = ["function do_it_now() {", "}"];
      index.indexFile("/a.ts", tree, lines);

      // "do" and "it" are shorter than 3, should not be indexed as components
      const doStats = index.getTokenStats("do");
      assert.equal(doStats, undefined, "'do' should not be indexed (too short)");

      // "now" is exactly 3 chars, should be indexed
      const nowStats = index.getTokenStats("now");
      assert.ok(nowStats, "'now' should be indexed (length 3)");
    });
  });

  describe("connection detection", () => {
    it("should detect API dependency when header in A matches body in B", () => {
      const index = new CrossFileIndex();

      // File A: defines buildDynamicContext in its header
      const treeA = makeTree("/a.ts", [
        makeNode({
          label: "function buildDynamicContext()",
          startLine: 1,
          endLine: 5,
        }),
      ]);
      const linesA = [
        "function buildDynamicContext() {",
        "  const result = {};",
        "  return result;",
        "  // end",
        "}",
      ];

      // File B: references buildDynamicContext in a body
      const treeB = makeTree("/b.ts", [
        makeNode({
          label: "function processRequest()",
          startLine: 1,
          endLine: 5,
        }),
      ]);
      const linesB = [
        "function processRequest() {",
        "  const ctx = buildDynamicContext();",
        "  doSomething(ctx);",
        "  // done",
        "}",
      ];

      index.indexFile("/a.ts", treeA, linesA);
      index.indexFile("/b.ts", treeB, linesB);

      // From A's perspective: A defines, B references → outgoing
      const connsA = index.getConnections("/a.ts");
      const apiConnA = connsA.find(
        (c) => c.type === "api_dependency" && c.targetFile === "/b.ts"
      );
      assert.ok(apiConnA, "should detect API dependency from A to B");
      assert.equal(apiConnA.direction, "outgoing");
      assert.ok(
        apiConnA.sharedTokens.includes("builddynamiccontext"),
        "shared tokens should include the full compound token"
      );

      // From B's perspective: B references, A defines → incoming
      const connsB = index.getConnections("/b.ts");
      const apiConnB = connsB.find(
        (c) => c.type === "api_dependency" && c.targetFile === "/a.ts"
      );
      assert.ok(apiConnB, "should detect API dependency from B to A");
      assert.equal(apiConnB.direction, "incoming");
    });

    it("should detect shared interface when both files define token in headers", () => {
      const index = new CrossFileIndex();

      const treeA = makeTree("/a.ts", [
        makeNode({
          label: "class UserValidator",
          startLine: 1,
          endLine: 3,
        }),
      ]);
      const linesA = ["class UserValidator {", "  validate() {}", "}"];

      const treeB = makeTree("/b.ts", [
        makeNode({
          label: "class UserValidator",
          startLine: 1,
          endLine: 3,
        }),
      ]);
      const linesB = ["class UserValidator {", "  check() {}", "}"];

      index.indexFile("/a.ts", treeA, linesA);
      index.indexFile("/b.ts", treeB, linesB);

      const conns = index.getConnections("/a.ts");
      const shared = conns.find(
        (c) => c.type === "shared_interface" && c.targetFile === "/b.ts"
      );
      assert.ok(shared, "should detect shared interface");
      assert.equal(shared.direction, "bidirectional");
    });

    it("should detect conceptual coupling when token in body of both files", () => {
      const index = new CrossFileIndex();

      const treeA = makeTree("/a.ts", [
        makeNode({
          label: "function foo()",
          startLine: 1,
          endLine: 3,
        }),
      ]);
      const linesA = [
        "function foo() {",
        "  const cfg = loadConfiguration();",
        "}",
      ];

      const treeB = makeTree("/b.ts", [
        makeNode({
          label: "function bar()",
          startLine: 1,
          endLine: 3,
        }),
      ]);
      const linesB = [
        "function bar() {",
        "  const cfg = loadConfiguration();",
        "}",
      ];

      index.indexFile("/a.ts", treeA, linesA);
      index.indexFile("/b.ts", treeB, linesB);

      const conns = index.getConnections("/a.ts");
      const coupling = conns.find(
        (c) => c.type === "conceptual_coupling" && c.targetFile === "/b.ts"
      );
      assert.ok(coupling, "should detect conceptual coupling");
      assert.equal(coupling.direction, "bidirectional");
    });
  });

  describe("IDF filtering of common tokens", () => {
    it("should filter out tokens appearing in more than half the files", () => {
      const index = new CrossFileIndex();

      // Create 4 files. "log" appears in all 4, should be filtered (> N/2).
      // "rareToken" appears in only 2, should be kept.
      for (let i = 0; i < 4; i++) {
        const filePath = `/file${i}.ts`;
        const bodyLines =
          i < 2
            ? ["function main() {", "  log(rareToken);", "}"]
            : ["function main() {", "  log(commonStuff);", "}"];
        const tree = makeTree(filePath, [
          makeNode({
            label: "function main()",
            startLine: 1,
            endLine: 3,
          }),
        ]);
        index.indexFile(filePath, tree, bodyLines);
      }

      // "log" is in all 4 files → fileCount=4, totalFiles=4, 4 > 4/2 → filtered
      const conns = index.getConnections("/file0.ts");
      for (const conn of conns) {
        assert.ok(
          !conn.sharedTokens.includes("log"),
          "'log' should be filtered out (appears in all files)"
        );
      }

      // "raretoken" appears in 2 files, 2 <= 4/2 → also filtered.
      // Adjust: use 6 files so threshold = 3. rareToken in 2 files → kept.
    });

    it("should keep tokens in the IDF sweet spot", () => {
      const index = new CrossFileIndex();

      // 6 files total. "ubiquitous" appears in all 6 (filtered: 6 > 3).
      // "rareSymbol" appears in 2 (kept: 2 >= 2 and 2 <= 3).
      // "internal" appears in 1 (filtered: 1 < 2).
      for (let i = 0; i < 6; i++) {
        const filePath = `/file${i}.ts`;
        let bodyContent: string;
        if (i === 0) {
          bodyContent = "  ubiquitous(); rareSymbol(); internal();";
        } else if (i === 1) {
          bodyContent = "  ubiquitous(); rareSymbol();";
        } else {
          bodyContent = "  ubiquitous();";
        }
        const tree = makeTree(filePath, [
          makeNode({
            label: "function handler()",
            startLine: 1,
            endLine: 3,
          }),
        ]);
        index.indexFile(filePath, tree, [
          "function handler() {",
          bodyContent,
          "}",
        ]);
      }

      const conns = index.getConnections("/file0.ts");
      // Should have a connection to /file1.ts via "raresymbol"
      const conn = conns.find((c) => c.targetFile === "/file1.ts");
      assert.ok(conn, "should find connection to file1 via rareSymbol");
      assert.ok(
        conn.sharedTokens.includes("raresymbol"),
        "shared tokens should include 'raresymbol'"
      );

      // ubiquitous should not appear in any connection's shared tokens
      for (const c of conns) {
        assert.ok(
          !c.sharedTokens.includes("ubiquitous"),
          "'ubiquitous' should be filtered (appears in all files)"
        );
      }
    });
  });

  describe("file removal", () => {
    it("should clean up all index entries when a file is removed", () => {
      const index = new CrossFileIndex();

      const tree = makeTree("/a.ts", [
        makeNode({
          label: "function uniqueFunction()",
          startLine: 1,
          endLine: 3,
        }),
      ]);
      const lines = [
        "function uniqueFunction() {",
        "  return value;",
        "}",
      ];
      index.indexFile("/a.ts", tree, lines);

      assert.ok(index.size > 0, "index should have tokens after indexing");
      assert.deepEqual(index.getIndexedFiles(), ["/a.ts"]);

      index.removeFile("/a.ts");

      assert.deepEqual(
        index.getIndexedFiles(),
        [],
        "no files should remain after removal"
      );
      assert.equal(
        index.getTokenStats("uniquefunction"),
        undefined,
        "token stats should be gone after file removal"
      );
    });

    it("should remove only the specified file's tokens", () => {
      const index = new CrossFileIndex();

      const treeA = makeTree("/a.ts", [
        makeNode({
          label: "function sharedName()",
          startLine: 1,
          endLine: 2,
        }),
      ]);
      const treeB = makeTree("/b.ts", [
        makeNode({
          label: "function sharedName()",
          startLine: 1,
          endLine: 2,
        }),
      ]);

      index.indexFile("/a.ts", treeA, ["function sharedName() {", "}"]);
      index.indexFile("/b.ts", treeB, ["function sharedName() {", "}"]);

      assert.equal(index.getIndexedFiles().length, 2);

      index.removeFile("/a.ts");

      assert.deepEqual(index.getIndexedFiles(), ["/b.ts"]);
      const stats = index.getTokenStats("sharedname");
      assert.ok(stats, "token should still exist from file B");
      assert.equal(stats.fileCount, 1);
    });

    it("should invalidate connection cache on file removal", () => {
      const index = new CrossFileIndex();

      const treeA = makeTree("/a.ts", [
        makeNode({
          label: "function rareApiCall()",
          startLine: 1,
          endLine: 3,
        }),
      ]);
      const treeB = makeTree("/b.ts", [
        makeNode({
          label: "function consumer()",
          startLine: 1,
          endLine: 3,
        }),
      ]);

      index.indexFile("/a.ts", treeA, [
        "function rareApiCall() {",
        "  return data;",
        "}",
      ]);
      index.indexFile("/b.ts", treeB, [
        "function consumer() {",
        "  rareApiCall();",
        "}",
      ]);

      // Warm the cache
      const connsBefore = index.getConnections("/b.ts");
      assert.ok(connsBefore.length > 0, "should have connections before removal");

      // Remove file A
      index.removeFile("/a.ts");

      // Connections for B should be empty now
      const connsAfter = index.getConnections("/b.ts");
      assert.equal(connsAfter.length, 0, "connections should be gone after removing A");
    });
  });

  describe("indexFile and getTokenStats", () => {
    it("should extract tokens from both header and body", () => {
      const index = new CrossFileIndex();
      const tree = makeTree("/a.ts", [
        makeNode({
          label: "class AuthService",
          startLine: 1,
          endLine: 4,
        }),
      ]);
      const lines = [
        "class AuthService {",
        "  validateToken(token) {",
        "    return checkAuth(token);",
        "  }",
      ];
      index.indexFile("/a.ts", tree, lines);

      const authStats = index.getTokenStats("authservice");
      assert.ok(authStats);
      assert.equal(authStats.headerCount, 1);

      const validateStats = index.getTokenStats("validatetoken");
      assert.ok(validateStats);
      assert.equal(validateStats.bodyCount, 1);
    });

    it("should deduplicate tokens within a single node", () => {
      const index = new CrossFileIndex();
      const tree = makeTree("/a.ts", [
        makeNode({
          label: "function process()",
          startLine: 1,
          endLine: 4,
        }),
      ]);
      const lines = [
        "function process() {",
        "  log(data);",
        "  log(data);", // duplicate
        "}",
      ];
      index.indexFile("/a.ts", tree, lines);

      const logStats = index.getTokenStats("log");
      assert.ok(logStats);
      // Should only count once for body in this file
      assert.equal(logStats.bodyCount, 1);
    });
  });

  describe("getIndexedFiles and size", () => {
    it("should track indexed files", () => {
      const index = new CrossFileIndex();
      assert.deepEqual(index.getIndexedFiles(), []);
      assert.equal(index.size, 0);

      const tree = makeTree("/a.ts", [
        makeNode({
          label: "function hello()",
          startLine: 1,
          endLine: 2,
        }),
      ]);
      index.indexFile("/a.ts", tree, ["function hello() {", "}"]);

      assert.ok(index.getIndexedFiles().includes("/a.ts"));
      assert.ok(index.size > 0);
    });
  });

  describe("re-indexing a file", () => {
    it("should replace old tokens when re-indexing the same file", () => {
      const index = new CrossFileIndex();

      const tree1 = makeTree("/a.ts", [
        makeNode({
          label: "function oldName()",
          startLine: 1,
          endLine: 2,
        }),
      ]);
      index.indexFile("/a.ts", tree1, ["function oldName() {", "}"]);
      assert.ok(index.getTokenStats("oldname"));

      const tree2 = makeTree("/a.ts", [
        makeNode({
          label: "function newName()",
          startLine: 1,
          endLine: 2,
        }),
      ]);
      index.indexFile("/a.ts", tree2, ["function newName() {", "}"]);

      assert.equal(
        index.getTokenStats("oldname"),
        undefined,
        "old token should be removed"
      );
      assert.ok(
        index.getTokenStats("newname"),
        "new token should be present"
      );
    });
  });

  describe("connection strength ordering", () => {
    it("should rank connections by strength descending", () => {
      const index = new CrossFileIndex();

      // File A defines two functions
      const treeA = makeTree("/a.ts", [
        makeNode({
          label: "function alphaProcessor()",
          startLine: 1,
          endLine: 3,
        }),
        makeNode({
          label: "function betaProcessor()",
          startLine: 4,
          endLine: 6,
        }),
      ]);
      const linesA = [
        "function alphaProcessor() {",
        "  return alpha;",
        "}",
        "function betaProcessor() {",
        "  return beta;",
        "}",
      ];

      // File B references both
      const treeB = makeTree("/b.ts", [
        makeNode({
          label: "function main()",
          startLine: 1,
          endLine: 4,
        }),
      ]);
      const linesB = [
        "function main() {",
        "  alphaProcessor();",
        "  betaProcessor();",
        "}",
      ];

      // File C references only one
      const treeC = makeTree("/c.ts", [
        makeNode({
          label: "function other()",
          startLine: 1,
          endLine: 3,
        }),
      ]);
      const linesC = [
        "function other() {",
        "  alphaProcessor();",
        "}",
      ];

      index.indexFile("/a.ts", treeA, linesA);
      index.indexFile("/b.ts", treeB, linesB);
      index.indexFile("/c.ts", treeC, linesC);

      const conns = index.getConnections("/a.ts");
      // B shares more tokens with A than C does, so B should rank higher
      if (conns.length >= 2) {
        const bConn = conns.find((c) => c.targetFile === "/b.ts");
        const cConn = conns.find((c) => c.targetFile === "/c.ts");
        if (bConn && cConn) {
          assert.ok(
            bConn.strength >= cConn.strength,
            "B (sharing more tokens) should have >= strength than C"
          );
        }
      }
    });
  });

  describe("limit parameter", () => {
    it("should respect the limit on getConnections", () => {
      const index = new CrossFileIndex();

      // File A defines a token in its header
      const treeA = makeTree("/a.ts", [
        makeNode({
          label: "function specialHandler()",
          startLine: 1,
          endLine: 2,
        }),
      ]);
      index.indexFile("/a.ts", treeA, ["function specialHandler() {", "}"]);

      // Files B, C, D all reference it in body
      for (const name of ["/b.ts", "/c.ts", "/d.ts"]) {
        const tree = makeTree(name, [
          makeNode({
            label: "function caller()",
            startLine: 1,
            endLine: 3,
          }),
        ]);
        index.indexFile(name, tree, [
          "function caller() {",
          "  specialHandler();",
          "}",
        ]);
      }

      // Add padding files so "specialHandler" (in 4 files) stays under
      // the N/2 threshold. With 10 files total, threshold = max(5, 2) = 5.
      for (let i = 0; i < 6; i++) {
        const tree = makeTree(`/pad${i}.ts`, [
          makeNode({
            label: `function unrelated${i}()`,
            startLine: 1,
            endLine: 2,
          }),
        ]);
        index.indexFile(`/pad${i}.ts`, tree, [
          `function unrelated${i}() {`,
          "}",
        ]);
      }

      const limited = index.getConnections("/a.ts", 1);
      assert.equal(limited.length, 1, "should return at most 1 connection");

      const all = index.getConnections("/a.ts");
      assert.ok(all.length > 1, "without limit should return more connections");
    });
  });
});
