#!/usr/bin/env node
/**
 * CLI for hashline-aware Edit preprocessing.
 * Called by pre-edit.sh hook on Edit tool calls.
 *
 * Reads JSON from stdin: { file_path, old_string, new_string }
 * Detects hashline tags in old_string/new_string, strips them,
 * verifies hashes, and outputs updatedInput JSON.
 *
 * Behavior:
 * 1. If hashline tags detected → strip prefixes, verify hashes, autocorrect
 * 2. If no hashlines → attempt fuzzy matching (whitespace normalization)
 * 3. Passthrough on failure (let native Edit handle errors)
 */

import fs from "node:fs";
import path from "node:path";
import { computeHash } from "./hashline.js";

// Matches lines with hashline prefix: "42#VRK:content"
const HASHLINE_RE = /^\d+#[A-Z]{3}:/m;
// Parses a single hashline-prefixed line
const HASHLINE_LINE_RE = /^(\d+)#([A-Z]{3}):(.*)$/;

const AUTOCORRECT_RANGE = 3;

interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
}

interface HookOutput {
  hookSpecificOutput?: {
    hookEventName: string;
    permissionDecision: string;
    updatedInput?: {
      old_string: string;
      new_string: string;
    };
    additionalContext?: string;
  };
}

/**
 * Resolve a hashline tag to actual file content.
 * If content is provided (after the colon), use it.
 * If content is empty (tag-only like "42#VRK:"), look up the line from the file.
 * This lets the model reference lines without reproducing them.
 */
function resolveHashline(
  lineNum: number,
  hash: string,
  content: string,
  fileLines: string[],
): { resolved: string; status: "verified" | "autocorrected" | "failed" } {
  const idx = lineNum - 1;
  const tagOnly = content === "";

  // Exact match at declared line number
  if (idx >= 0 && idx < fileLines.length && computeHash(fileLines[idx]) === hash) {
    return { resolved: tagOnly ? fileLines[idx] : content, status: "verified" };
  }

  // Autocorrect: search ±AUTOCORRECT_RANGE for matching hash
  const lo = Math.max(0, idx - AUTOCORRECT_RANGE);
  const hi = Math.min(fileLines.length - 1, idx + AUTOCORRECT_RANGE);
  for (let i = lo; i <= hi; i++) {
    if (computeHash(fileLines[i]) === hash) {
      return { resolved: tagOnly ? fileLines[i] : content, status: "autocorrected" };
    }
  }

  // Hash not found — use file content at line number if tag-only, otherwise use provided content
  if (tagOnly && idx >= 0 && idx < fileLines.length) {
    return { resolved: fileLines[idx], status: "failed" };
  }
  return { resolved: content, status: "failed" };
}

/**
 * Strip hashline prefixes from a string, verifying hashes against file content.
 * Tag-only lines (e.g. "42#VRK:") are resolved to actual file content —
 * the model doesn't need to reproduce old code, just reference it.
 * Returns the cleaned string and diagnostics.
 */
function stripHashlines(
  tagged: string,
  fileLines: string[],
): { cleaned: string; verified: number; autocorrected: number; failed: number } {
  const lines = tagged.split("\n");
  const cleaned: string[] = [];
  let verified = 0;
  let autocorrected = 0;
  let failed = 0;

  for (const line of lines) {
    const match = line.match(HASHLINE_LINE_RE);
    if (!match) {
      // Not a hashline-tagged line — keep as-is
      cleaned.push(line);
      continue;
    }

    const lineNum = parseInt(match[1], 10);
    const hash = match[2];
    const content = match[3];

    const result = resolveHashline(lineNum, hash, content, fileLines);
    cleaned.push(result.resolved);
    if (result.status === "verified") verified++;
    else if (result.status === "autocorrected") autocorrected++;
    else failed++;
  }

  return { cleaned: cleaned.join("\n"), verified, autocorrected, failed };
}

/**
 * Try fuzzy matching: whitespace-normalized comparison.
 */
function fuzzyMatch(oldStr: string, fileContent: string): boolean {
  const normalize = (s: string) =>
    s.replace(/[ \t]+/g, " ").replace(/[ \t]+$/gm, "").replace(/^\s+$/gm, "");
  return fileContent.includes(normalize(oldStr)) || fileContent.includes(oldStr);
}

function main(): void {
  let rawInput: string;
  try {
    rawInput = fs.readFileSync(0, "utf-8");
  } catch {
    // Can't read stdin — passthrough
    process.stdout.write("{}");
    return;
  }

  let input: EditInput;
  try {
    input = JSON.parse(rawInput);
  } catch {
    process.stdout.write("{}");
    return;
  }

  const { file_path, old_string, new_string } = input;
  if (!file_path || old_string === undefined || new_string === undefined) {
    process.stdout.write("{}");
    return;
  }

  const absPath = path.resolve(file_path);

  // Check if old_string contains hashline tags
  const hasHashlines = HASHLINE_RE.test(old_string);

  if (!hasHashlines) {
    // No hashlines — check if old_string matches file content directly
    try {
      const fileContent = fs.readFileSync(absPath, "utf-8");
      if (fileContent.includes(old_string)) {
        // Exact match exists — passthrough, let native Edit handle it
        process.stdout.write("{}");
        return;
      }

      // Try fuzzy matching with whitespace normalization
      if (fuzzyMatch(old_string, fileContent)) {
        // Close match — passthrough (native Edit may still work, or will error clearly)
        process.stdout.write("{}");
        return;
      }
    } catch {
      // Can't read file — passthrough
    }

    process.stdout.write("{}");
    return;
  }

  // Hashline tags detected — strip prefixes and verify
  let fileLines: string[];
  try {
    const fileContent = fs.readFileSync(absPath, "utf-8");
    fileLines = fileContent.split("\n");
  } catch {
    // Can't read file — passthrough
    process.stdout.write("{}");
    return;
  }

  const oldResult = stripHashlines(old_string, fileLines);
  const newResult = stripHashlines(new_string, fileLines);

  const totalVerified = oldResult.verified + newResult.verified;
  const totalAutocorrected = oldResult.autocorrected + newResult.autocorrected;
  const totalFailed = oldResult.failed + newResult.failed;

  const parts: string[] = [];
  if (totalVerified > 0) parts.push(`${totalVerified} verified`);
  if (totalAutocorrected > 0) parts.push(`${totalAutocorrected} autocorrected`);
  if (totalFailed > 0) parts.push(`${totalFailed} unverified`);
  const summary = `Hashline edit resolved: ${parts.join(", ")}.`;

  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: {
        old_string: oldResult.cleaned,
        new_string: newResult.cleaned,
      },
      additionalContext: summary,
    },
  };

  process.stdout.write(JSON.stringify(output));
}

main();
