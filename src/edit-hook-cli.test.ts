import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { computeHash } from "./hashline.js";

const CLI_PATH = path.resolve(import.meta.dirname, "../dist/edit-hook-cli.js");
const TMP_DIR = "/tmp/strata-test-edit-hook";

function runCli(input: object): object {
  const result = execSync(`node ${CLI_PATH}`, {
    input: JSON.stringify(input),
    encoding: "utf-8",
    timeout: 5000,
  });
  return JSON.parse(result);
}

function makeTestFile(lines: string[]): string {
  const filePath = path.join(TMP_DIR, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`);
  fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
  return filePath;
}

function hashTag(content: string, lineNum: number): string {
  return `${lineNum}#${computeHash(content)}:${content}`;
}

describe("edit-hook-cli", () => {
  beforeEach(() => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  describe("hashline tag detection", () => {
    test("detects single hashline-tagged line in old_string", () => {
      const lines = ["function foo() {", "  return 42;", "}"];
      const filePath = makeTestFile(lines);
      const taggedOld = hashTag(lines[1], 2);

      const result = runCli({
        file_path: filePath,
        old_string: taggedOld,
        new_string: "  return 99;",
      }) as any;

      assert.ok(result.hookSpecificOutput);
      assert.strictEqual(result.hookSpecificOutput.permissionDecision, "allow");
      assert.strictEqual(result.hookSpecificOutput.updatedInput.old_string, lines[1]);
      assert.strictEqual(result.hookSpecificOutput.updatedInput.new_string, "  return 99;");
    });

    test("detects multiline hashline-tagged old_string", () => {
      const lines = ["function foo() {", "  const x = 1;", "  const y = 2;", "  return x + y;", "}"];
      const filePath = makeTestFile(lines);

      const taggedOld = [hashTag(lines[1], 2), hashTag(lines[2], 3)].join("\n");
      const newStr = "  const x = 10;\n  const y = 20;";

      const result = runCli({
        file_path: filePath,
        old_string: taggedOld,
        new_string: newStr,
      }) as any;

      assert.ok(result.hookSpecificOutput);
      assert.strictEqual(
        result.hookSpecificOutput.updatedInput.old_string,
        "  const x = 1;\n  const y = 2;",
      );
    });

    test("handles mixed hashline and non-hashline lines", () => {
      const lines = ["function foo() {", "  const x = 1;", "  return x;", "}"];
      const filePath = makeTestFile(lines);

      // Mix: first line tagged, second line plain
      const taggedOld = hashTag(lines[1], 2) + "\n  return x;";

      const result = runCli({
        file_path: filePath,
        old_string: taggedOld,
        new_string: "  const x = 99;\n  return x;",
      }) as any;

      assert.ok(result.hookSpecificOutput);
      // Tagged line stripped, plain line kept as-is
      assert.strictEqual(
        result.hookSpecificOutput.updatedInput.old_string,
        "  const x = 1;\n  return x;",
      );
    });
  });

  describe("hash verification", () => {
    test("verifies hash matches file content at declared line", () => {
      const lines = ["aaa", "bbb", "ccc"];
      const filePath = makeTestFile(lines);
      const taggedOld = hashTag(lines[1], 2);

      const result = runCli({
        file_path: filePath,
        old_string: taggedOld,
        new_string: "BBB",
      }) as any;

      assert.ok(result.hookSpecificOutput);
      assert.ok(result.hookSpecificOutput.additionalContext.includes("verified"));
    });
  });

  describe("autocorrect", () => {
    test("autocorrects when line numbers shift ±3 lines", () => {
      const lines = ["new_first", "aaa", "bbb", "target_line", "ddd", "eee"];
      const filePath = makeTestFile(lines);

      // Tag says line 3 but "target_line" is now at line 4
      const hash = computeHash("target_line");
      const taggedOld = `3#${hash}:target_line`;

      const result = runCli({
        file_path: filePath,
        old_string: taggedOld,
        new_string: "REPLACED",
      }) as any;

      assert.ok(result.hookSpecificOutput);
      assert.strictEqual(result.hookSpecificOutput.updatedInput.old_string, "target_line");
      assert.ok(result.hookSpecificOutput.additionalContext.includes("autocorrected"));
    });
  });

  describe("fuzzy matching", () => {
    test("passthrough when no hashlines and exact match exists", () => {
      const lines = ["function foo() {", "  return 42;", "}"];
      const filePath = makeTestFile(lines);

      const result = runCli({
        file_path: filePath,
        old_string: "  return 42;",
        new_string: "  return 99;",
      });

      // No hashlines, exact match → passthrough
      assert.deepStrictEqual(result, {});
    });

    test("passthrough when no hashlines and no match", () => {
      const lines = ["function foo() {", "  return 42;", "}"];
      const filePath = makeTestFile(lines);

      const result = runCli({
        file_path: filePath,
        old_string: "completely different content",
        new_string: "replacement",
      });

      // Let native Edit handle the error
      assert.deepStrictEqual(result, {});
    });
  });

  describe("new_string stripping", () => {
    test("strips hashline prefixes from new_string too", () => {
      const lines = ["function foo() {", "  return 42;", "}"];
      const filePath = makeTestFile(lines);

      const taggedOld = hashTag(lines[1], 2);
      const taggedNew = hashTag("  return 99;", 2); // new content also tagged

      const result = runCli({
        file_path: filePath,
        old_string: taggedOld,
        new_string: taggedNew,
      }) as any;

      assert.ok(result.hookSpecificOutput);
      assert.strictEqual(result.hookSpecificOutput.updatedInput.old_string, "  return 42;");
      assert.strictEqual(result.hookSpecificOutput.updatedInput.new_string, "  return 99;");
    });
  });

  describe("tag-only resolution (no content reproduction)", () => {
    test("resolves single tag-only line to file content", () => {
      const lines = ["function foo() {", "  return 42;", "}"];
      const filePath = makeTestFile(lines);
      const hash = computeHash(lines[1]);

      // Model writes just the tag, no content after colon
      const result = runCli({
        file_path: filePath,
        old_string: `2#${hash}:`,
        new_string: "  return 99;",
      }) as any;

      assert.ok(result.hookSpecificOutput);
      assert.strictEqual(result.hookSpecificOutput.updatedInput.old_string, "  return 42;");
      assert.strictEqual(result.hookSpecificOutput.updatedInput.new_string, "  return 99;");
    });

    test("resolves multiple tag-only lines to file content", () => {
      const lines = ["function foo() {", "  const x = 1;", "  const y = 2;", "  return x + y;", "}"];
      const filePath = makeTestFile(lines);

      const h2 = computeHash(lines[1]);
      const h3 = computeHash(lines[2]);
      const h4 = computeHash(lines[3]);

      // Model references 3 lines without reproducing any content
      const result = runCli({
        file_path: filePath,
        old_string: `2#${h2}:\n3#${h3}:\n4#${h4}:`,
        new_string: "  const x = 10;\n  const y = 20;\n  return x + y;",
      }) as any;

      assert.ok(result.hookSpecificOutput);
      assert.strictEqual(
        result.hookSpecificOutput.updatedInput.old_string,
        "  const x = 1;\n  const y = 2;\n  return x + y;",
      );
    });

    test("autocorrects tag-only lines when line numbers shift", () => {
      const lines = ["new_first", "aaa", "bbb", "target_line", "ddd"];
      const filePath = makeTestFile(lines);

      // Tag says line 3 but "target_line" is at line 4
      const hash = computeHash("target_line");
      const result = runCli({
        file_path: filePath,
        old_string: `3#${hash}:`,
        new_string: "REPLACED",
      }) as any;

      assert.ok(result.hookSpecificOutput);
      // Should resolve to actual file content at the autocorrected line
      assert.strictEqual(result.hookSpecificOutput.updatedInput.old_string, "target_line");
      assert.ok(result.hookSpecificOutput.additionalContext.includes("autocorrected"));
    });

    test("mixes tag-only and content-bearing lines", () => {
      const lines = ["function foo() {", "  const x = 1;", "  return x;", "}"];
      const filePath = makeTestFile(lines);

      const h2 = computeHash(lines[1]);
      // Line 2: tag-only (resolved from file), Line 3: has content (stripped)
      const result = runCli({
        file_path: filePath,
        old_string: `2#${h2}:\n${hashTag(lines[2], 3)}`,
        new_string: "  const x = 99;\n  return x;",
      }) as any;

      assert.ok(result.hookSpecificOutput);
      assert.strictEqual(
        result.hookSpecificOutput.updatedInput.old_string,
        "  const x = 1;\n  return x;",
      );
    });
  });

  describe("passthrough on missing inputs", () => {
    test("passthrough on empty file_path", () => {
      const result = runCli({
        file_path: "",
        old_string: "foo",
        new_string: "bar",
      });
      assert.deepStrictEqual(result, {});
    });

    test("passthrough on nonexistent file", () => {
      const result = runCli({
        file_path: "/tmp/nonexistent-file-for-test.ts",
        old_string: `1#VRK:foo`,
        new_string: "bar",
      });
      assert.deepStrictEqual(result, {});
    });
  });
});
