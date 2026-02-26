import { describe, test } from "node:test";
import assert from "node:assert";
import {
  computeHash,
  hashLines,
  formatTag,
  parseTag,
  validateTag,
  applyEdits,
} from "./hashline.js";

const ALPHABET = "ZPMQVRWSNKTXJBYH";

describe("computeHash", () => {
  test("returns a 3-character string from the alphabet", () => {
    const hash = computeHash("const x = 5;");
    assert.strictEqual(hash.length, 3);
    for (const ch of hash) {
      assert.ok(ALPHABET.includes(ch), `char '${ch}' not in alphabet`);
    }
  });

  test("same content produces same hash", () => {
    const a = computeHash("hello world");
    const b = computeHash("hello world");
    assert.strictEqual(a, b);
  });

  test("different content may produce different hash", () => {
    const a = computeHash("hello");
    const b = computeHash("goodbye");
    // Not strictly guaranteed to differ for all inputs, but these should
    assert.notStrictEqual(a, b);
  });

  test("strips whitespace before hashing", () => {
    const a = computeHash("  const x = 5;  ");
    const b = computeHash("constx=5;");
    assert.strictEqual(a, b);
  });
});

describe("hashLines", () => {
  test("tags lines with 1-based line numbers", () => {
    const lines = ["first", "second", "third"];
    const result = hashLines(lines);
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0].lineNumber, 1);
    assert.strictEqual(result[1].lineNumber, 2);
    assert.strictEqual(result[2].lineNumber, 3);
  });

  test("preserves original content", () => {
    const lines = ["  indented line", "normal line"];
    const result = hashLines(lines);
    assert.strictEqual(result[0].content, "  indented line");
    assert.strictEqual(result[1].content, "normal line");
  });

  test("each line has a 3-char hash", () => {
    const result = hashLines(["a", "b", "c"]);
    for (const hl of result) {
      assert.strictEqual(hl.hash.length, 3);
    }
  });
});

describe("formatTag", () => {
  test("produces LINE#HASH:content format", () => {
    const result = formatTag({ lineNumber: 42, hash: "VRK", content: "  const x = 5;" });
    assert.strictEqual(result, "42#VRK:  const x = 5;");
  });
});

describe("parseTag", () => {
  test("parses valid tag", () => {
    const { lineNumber, hash } = parseTag("42#VRK");
    assert.strictEqual(lineNumber, 42);
    assert.strictEqual(hash, "VRK");
  });

  test("throws on invalid tag", () => {
    assert.throws(() => parseTag("invalid"), /Invalid tag format/);
    assert.throws(() => parseTag("42#vr"), /Invalid tag format/);
    assert.throws(() => parseTag("#VRK"), /Invalid tag format/);
    assert.throws(() => parseTag("42VRK"), /Invalid tag format/);
  });
});

describe("validateTag", () => {
  test("returns valid for matching tag", () => {
    const lines = ["hello", "world"];
    const tagged = hashLines(lines);
    const tag = `${tagged[0].lineNumber}#${tagged[0].hash}`;
    const result = validateTag(tag, lines);
    assert.strictEqual(result.valid, true);
  });

  test("returns invalid for mismatched hash", () => {
    const lines = ["hello", "world"];
    const result = validateTag("1#ZZZ", lines);
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason?.includes("Hash mismatch"));
  });

  test("returns invalid for out-of-range line", () => {
    const lines = ["hello"];
    const result = validateTag("5#VRK", lines);
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason?.includes("out of range"));
  });
});

describe("applyEdits", () => {
  function tagAt(lines: string[], idx: number): string {
    const tagged = hashLines(lines);
    return `${tagged[idx].lineNumber}#${tagged[idx].hash}`;
  }

  test("set replaces a single line", () => {
    const lines = ["aaa", "bbb", "ccc"];
    const content = lines.join("\n");
    const tag = tagAt(lines, 1);
    const result = applyEdits(content, [
      { op: "set", tag, content: ["BBB"] },
    ]);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.content, "aaa\nBBB\nccc");
  });

  test("delete removes a single line", () => {
    const lines = ["aaa", "bbb", "ccc"];
    const content = lines.join("\n");
    const tag = tagAt(lines, 1);
    const result = applyEdits(content, [{ op: "delete", tag }]);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.content, "aaa\nccc");
  });

  test("append adds lines after target", () => {
    const lines = ["aaa", "bbb", "ccc"];
    const content = lines.join("\n");
    const tag = tagAt(lines, 0);
    const result = applyEdits(content, [
      { op: "append", tag, content: ["inserted"] },
    ]);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.content, "aaa\ninserted\nbbb\nccc");
  });

  test("prepend adds lines before target", () => {
    const lines = ["aaa", "bbb", "ccc"];
    const content = lines.join("\n");
    const tag = tagAt(lines, 1);
    const result = applyEdits(content, [
      { op: "prepend", tag, content: ["inserted"] },
    ]);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.content, "aaa\ninserted\nbbb\nccc");
  });

  test("replace replaces a range", () => {
    const lines = ["aaa", "bbb", "ccc", "ddd"];
    const content = lines.join("\n");
    const startTag = tagAt(lines, 1);
    const endTag = tagAt(lines, 2);
    const result = applyEdits(content, [
      { op: "replace", tag: startTag, endTag, content: ["XXX"] },
    ]);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.content, "aaa\nXXX\nddd");
  });

  test("delete range removes multiple lines", () => {
    const lines = ["aaa", "bbb", "ccc", "ddd"];
    const content = lines.join("\n");
    const startTag = tagAt(lines, 1);
    const endTag = tagAt(lines, 2);
    const result = applyEdits(content, [
      { op: "delete", tag: startTag, endTag },
    ]);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.content, "aaa\nddd");
  });

  test("multiple edits applied bottom-up", () => {
    const lines = ["line1", "line2", "line3", "line4"];
    const content = lines.join("\n");
    const tag1 = tagAt(lines, 0);
    const tag3 = tagAt(lines, 2);
    // Edit line 3 and line 1 - should work correctly bottom-up
    const result = applyEdits(content, [
      { op: "set", tag: tag1, content: ["LINE1"] },
      { op: "set", tag: tag3, content: ["LINE3"] },
    ]);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.content, "LINE1\nline2\nLINE3\nline4");
  });

  test("returns error for unresolvable tag", () => {
    const result = applyEdits("hello", [
      { op: "set", tag: "999#ZZZ", content: ["x"] },
    ]);
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("out of range"));
  });

  test("empty edits returns original content", () => {
    const result = applyEdits("hello\nworld", []);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.content, "hello\nworld");
    assert.strictEqual(result.linesChanged, 0);
  });
});

describe("autocorrect", () => {
  test("finds matching hash within ±3 lines", () => {
    // Create content, compute tag for line 3, then shift lines so
    // the original line 3 content is now at line 4
    const original = ["aaa", "bbb", "target_line", "ddd", "eee"];
    const tagged = hashLines(original);
    const targetTag = `${tagged[2].lineNumber}#${tagged[2].hash}`; // "3#XXX"

    // Shift: insert a line at the beginning so "target_line" moves to index 3
    const shifted = ["new_first", "aaa", "bbb", "target_line", "ddd", "eee"];
    const shiftedContent = shifted.join("\n");

    // Tag says line 3 but content is now at line 4 - autocorrect should find it
    const result = applyEdits(shiftedContent, [
      { op: "set", tag: targetTag, content: ["REPLACED"] },
    ]);
    assert.strictEqual(result.success, true);
    const resultLines = result.content!.split("\n");
    assert.strictEqual(resultLines[3], "REPLACED");
  });

  test("falls back to line number when hash not found nearby", () => {
    const lines = ["aaa", "bbb", "ccc"];
    const content = lines.join("\n");
    // Use a wrong hash but valid line number
    const result = applyEdits(content, [
      { op: "set", tag: "2#ZZZ", content: ["REPLACED"] },
    ]);
    assert.strictEqual(result.success, true);
    // Should have replaced line 2 despite wrong hash
    assert.strictEqual(result.content, "aaa\nREPLACED\nccc");
    // Should have a warning
    assert.ok(result.error?.includes("hash mismatch"));
  });
});
