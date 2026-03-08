/**
 * PreToolUse hook — intercepts Read tool calls.
 *
 * Mode 1 (untargeted): file >= LINE_THRESHOLD, no offset/limit
 *   → always redirect to cached structural outline via updatedInput
 * Mode 2 (repeat reads): file REPEAT_THRESHOLD to LINE_THRESHOLD-1
 *   → first untargeted read passes through, subsequent reads serve outline
 * Targeted reads (offset/limit present) and small files pass through unmodified.
 *
 * Replaces pre-read.sh with pure Node.js for Windows compatibility.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readStdin, strataLog, normalizePath, getCacheDir } from "./lib/common.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LINE_THRESHOLD = 300;
const REPEAT_THRESHOLD = 100;

const input = await readStdin();
const toolInput = input.tool_input || input;
const rawPath = toolInput.file_path || "";
const offset = toolInput.offset;
const limit = toolInput.limit;

// If we couldn't extract a file path, pass through
if (!rawPath) {
  process.stdout.write("{}\n");
  process.exit(0);
}

const filePath = normalizePath(rawPath);

if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
  process.stdout.write("{}\n");
  process.exit(0);
}

// Cache in .strata/ inside the project root
const cacheDir = getCacheDir(filePath);

// Count lines (match wc -l: count newline characters)
const content = fs.readFileSync(filePath, "utf-8");
const lineCount = (content.match(/\n/g) || []).length;

// Set up cache key (shared by all modes)
fs.mkdirSync(cacheDir, { recursive: true });
const fileHash = createHash("sha256").update(filePath).digest("hex");
const fileMtime = Math.floor(fs.statSync(filePath).mtimeMs / 1000);
const CACHE_FORMAT_VERSION = 2;
const cacheFile = path.join(cacheDir, `${fileHash}-${fileMtime}-v${CACHE_FORMAT_VERSION}.txt`);
const seenMarker = path.join(cacheDir, `${fileHash}-${fileMtime}-seen`);

// --- Targeted read (offset present) → passthrough with optional context ---
if (offset !== undefined && offset !== null && offset !== "" && /^\d+$/.test(String(offset))) {
  // Large files with an existing outline: remind about editing workflow
  if (lineCount >= LINE_THRESHOLD && fs.existsSync(cacheFile)) {
    strataLog(cacheDir, {
      hook: "pre-read",
      decision: "passthrough_targeted_ctx",
      file: filePath,
      lines: lineCount,
      offset: Number(offset),
    });
    const output = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        additionalContext:
          "You can Edit this section using content from this Read. Make small, incremental edits — never rewrite the entire file.",
      },
    };
    process.stdout.write(JSON.stringify(output) + "\n");
    process.exit(0);
  }
  strataLog(cacheDir, {
    hook: "pre-read",
    decision: "passthrough_targeted",
    file: filePath,
    lines: lineCount,
  });
  process.stdout.write("{}\n");
  process.exit(0);
}

// --- Small file (< REPEAT_THRESHOLD) → always passthrough ---
if (lineCount < REPEAT_THRESHOLD) {
  strataLog(cacheDir, {
    hook: "pre-read",
    decision: "passthrough_small",
    file: filePath,
    lines: lineCount,
  });
  process.stdout.write("{}\n");
  process.exit(0);
}

// --- Determine context text based on mode ---
let contextPrefix;
let contextSuffix;

if (lineCount < LINE_THRESHOLD) {
  // Mode 2: Mid-size file (REPEAT_THRESHOLD to LINE_THRESHOLD-1)
  // First untargeted read → mark as seen, passthrough
  if (!fs.existsSync(seenMarker)) {
    // Create seen marker: touch equivalent
    fs.closeSync(fs.openSync(seenMarker, "a"));
    strataLog(cacheDir, {
      hook: "pre-read",
      decision: "passthrough_first_read",
      file: filePath,
      lines: lineCount,
    });
    process.stdout.write("{}\n");
    process.exit(0);
  }
  // Repeat read → fall through to outline generation
  contextPrefix = "Previously read in full. Outline of";
  contextSuffix =
    "for reference. Read with offset/limit to get actual code for any section — use the line ranges to target your read. Read returns at most 2000 lines per call; paginate with increasing offsets for larger spans. Never rewrite the entire file.";
} else {
  // Mode 1: Large file (>= LINE_THRESHOLD)
  contextPrefix = "Structural outline of";
  contextSuffix =
    "Read with offset/limit to get actual code for any section — use the line ranges to target your read. Read returns at most 2000 lines per call; paginate with increasing offsets for larger spans. Never rewrite an entire file.";
}

// --- Generate and serve outline ---
let cacheHit = true;
if (!fs.existsSync(cacheFile)) {
  cacheHit = false;
  try {
    const { generateOutline } = await import(
      path.join(__dirname, "..", "dist", "analyze-cli.js")
    );
    const outlineContent = generateOutline(filePath);
    fs.writeFileSync(cacheFile, outlineContent, "utf-8");
  } catch {
    try { fs.unlinkSync(cacheFile); } catch { /* ignore */ }
    strataLog(cacheDir, {
      hook: "pre-read",
      decision: "passthrough_outline_failed",
      file: filePath,
      lines: lineCount,
      cache_hit: false,
    });
    process.stdout.write("{}\n");
    process.exit(0);
  }
}

// Verify cache file was created and has content
try {
  const cacheStat = fs.statSync(cacheFile);
  if (cacheStat.size === 0) {
    throw new Error("empty");
  }
} catch {
  try { fs.unlinkSync(cacheFile); } catch { /* ignore */ }
  strataLog(cacheDir, {
    hook: "pre-read",
    decision: "passthrough_empty_outline",
    file: filePath,
    lines: lineCount,
    cache_hit: false,
  });
  process.stdout.write("{}\n");
  process.exit(0);
}

// Determine outline decision name
const decision = lineCount < LINE_THRESHOLD ? "outline_repeat" : "outline_always";

strataLog(cacheDir, {
  hook: "pre-read",
  decision,
  file: filePath,
  lines: lineCount,
  cache_hit: cacheHit,
});

const fileBasename = path.basename(filePath);
const additionalContext = `${contextPrefix} ${fileBasename} (${lineCount} lines). ${contextSuffix}`;

const output = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    updatedInput: {
      file_path: cacheFile,
    },
    additionalContext,
  },
};

process.stdout.write(JSON.stringify(output) + "\n");
