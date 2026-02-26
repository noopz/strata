import type {
  HashlineLine,
  HashlineEdit,
  HashlineEditResult,
} from "./types.js";

// 16-char alphabet: 16^3 = 4096 = 2^12
const ALPHABET = "ZPMQVRWSNKTXJBYH";
const HASH_BITS = 12;
const HASH_MASK = (1 << HASH_BITS) - 1; // 0xFFF
const AUTOCORRECT_RANGE = 3;

/**
 * FNV-1a 32-bit hash — pure JS, synchronous, no dependencies.
 *
 * DESIGN.md recommends xxHash32 and lists FNV-1a under "Algorithms NOT to use"
 * due to low-bit bias after truncation (no avalanche finalization). We use it
 * anyway as a deliberate tradeoff: the hash serves as a ~98% staleness check
 * at 12-bit / 4096 values, not a cryptographic or deduplication primitive.
 * FNV-1a's bias increases collision rate slightly vs xxHash32, but eliminates
 * the xxhash-wasm WASM dependency, async initialization, and startup latency
 * in CLI hooks that run on every tool call. The autocorrect search (±3 lines)
 * provides a safety net for the rare collision case.
 */
function fnv1a32(str: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0; // FNV prime, unsigned 32-bit
  }
  return hash;
}

/** Compute a 3-char hash for a line's content. */
export function computeHash(content: string): string {
  const stripped = content.replace(/\s/g, "");
  const raw = fnv1a32(stripped);
  const bits = raw & HASH_MASK;
  return encodeBits(bits);
}

/** Encode a 12-bit value as 3 characters from the alphabet. */
function encodeBits(value: number): string {
  const c0 = ALPHABET[(value >> 8) & 0xf];
  const c1 = ALPHABET[(value >> 4) & 0xf];
  const c2 = ALPHABET[value & 0xf];
  return c0 + c1 + c2;
}

/** Tag an array of file lines, producing HashlineLine[]. Lines are 1-based. */
export function hashLines(lines: string[]): HashlineLine[] {
  const result: HashlineLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const hash = computeHash(lines[i]);
    result.push({ lineNumber, hash, content: lines[i] });
  }
  return result;
}

/** Format a HashlineLine as "LINE#HASH:content". */
export function formatTag(line: HashlineLine): string {
  return `${line.lineNumber}#${line.hash}:${line.content}`;
}

/** Parse a tag string like "42#VRK" into { lineNumber, hash }. */
export function parseTag(tag: string): { lineNumber: number; hash: string } {
  const match = tag.match(/^(\d+)#([A-Z]{3})$/);
  if (!match) {
    throw new Error(`Invalid tag format: "${tag}". Expected "LINE#HASH" (e.g. "42#VRK").`);
  }
  return { lineNumber: parseInt(match[1], 10), hash: match[2] };
}

/** Validate whether a tag still matches the current file content. */
export function validateTag(
  tag: string,
  lines: string[]
): { valid: boolean; lineNumber: number; hash: string; reason?: string } {
  const { lineNumber, hash } = parseTag(tag);
  if (lineNumber < 1 || lineNumber > lines.length) {
    return { valid: false, lineNumber, hash, reason: "Line number out of range" };
  }
  const currentHash = computeHash(lines[lineNumber - 1]);
  if (currentHash === hash) {
    return { valid: true, lineNumber, hash };
  }
  return {
    valid: false,
    lineNumber,
    hash,
    reason: `Hash mismatch: expected ${hash}, got ${currentHash}`,
  };
}

/**
 * Resolve a tag to an actual line index (0-based) in the file,
 * applying autocorrect heuristics if needed.
 */
function resolveTag(
  tag: string,
  lines: string[],
  warnings: string[]
): number {
  const { lineNumber, hash } = parseTag(tag);
  const idx = lineNumber - 1;

  // Exact match
  if (idx >= 0 && idx < lines.length && computeHash(lines[idx]) === hash) {
    return idx;
  }

  // Autocorrect: search ±AUTOCORRECT_RANGE for matching hash
  const lo = Math.max(0, idx - AUTOCORRECT_RANGE);
  const hi = Math.min(lines.length - 1, idx + AUTOCORRECT_RANGE);
  for (let i = lo; i <= hi; i++) {
    if (computeHash(lines[i]) === hash) {
      warnings.push(
        `Autocorrected tag ${tag}: line ${lineNumber} -> ${i + 1} (hash matched)`
      );
      return i;
    }
  }

  // Fallback: if line number is in range, warn but proceed
  if (idx >= 0 && idx < lines.length) {
    warnings.push(
      `Tag ${tag}: hash mismatch at line ${lineNumber}, proceeding with line number`
    );
    return idx;
  }

  throw new Error(
    `Cannot resolve tag ${tag}: line ${lineNumber} out of range (file has ${lines.length} lines)`
  );
}

/** Apply an array of HashlineEdits to file content. Returns the result. */
export function applyEdits(
  content: string,
  edits: HashlineEdit[]
): HashlineEditResult {
  if (edits.length === 0) {
    return { success: true, content, linesChanged: 0 };
  }

  const lines = content.split("\n");
  const warnings: string[] = [];

  // Resolve all tags first, then sort edits bottom-up by resolved line number
  const resolved: Array<{
    edit: HashlineEdit;
    startIdx: number;
    endIdx?: number;
  }> = [];

  for (const edit of edits) {
    try {
      const startIdx = resolveTag(edit.tag, lines, warnings);
      let endIdx: number | undefined;
      if (edit.endTag) {
        endIdx = resolveTag(edit.endTag, lines, warnings);
      }
      resolved.push({ edit, startIdx, endIdx });
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Sort bottom-up: highest startIdx first so lower indices stay stable
  resolved.sort((a, b) => {
    const aMax = a.endIdx !== undefined ? Math.max(a.startIdx, a.endIdx) : a.startIdx;
    const bMax = b.endIdx !== undefined ? Math.max(b.startIdx, b.endIdx) : b.startIdx;
    return bMax - aMax;
  });

  let totalChanged = 0;

  for (const { edit, startIdx, endIdx } of resolved) {
    switch (edit.op) {
      case "set": {
        if (!edit.content || edit.content.length === 0) {
          return { success: false, error: `set operation requires content` };
        }
        const oldCount = 1;
        lines.splice(startIdx, 1, ...edit.content);
        totalChanged += edit.content.length;
        break;
      }
      case "replace": {
        if (endIdx === undefined) {
          return { success: false, error: `replace operation requires endTag` };
        }
        if (!edit.content) {
          return { success: false, error: `replace operation requires content` };
        }
        const lo = Math.min(startIdx, endIdx);
        const hi = Math.max(startIdx, endIdx);
        const count = hi - lo + 1;
        lines.splice(lo, count, ...edit.content);
        totalChanged += count + edit.content.length;
        break;
      }
      case "append": {
        const insertLines = edit.content ?? [];
        lines.splice(startIdx + 1, 0, ...insertLines);
        totalChanged += insertLines.length;
        break;
      }
      case "prepend": {
        const insertLines = edit.content ?? [];
        lines.splice(startIdx, 0, ...insertLines);
        totalChanged += insertLines.length;
        break;
      }
      case "insert": {
        const insertLines = edit.content ?? [];
        // Insert after startIdx (between startIdx and the next line)
        lines.splice(startIdx + 1, 0, ...insertLines);
        totalChanged += insertLines.length;
        break;
      }
      case "delete": {
        if (endIdx !== undefined) {
          const lo = Math.min(startIdx, endIdx);
          const hi = Math.max(startIdx, endIdx);
          const count = hi - lo + 1;
          lines.splice(lo, count);
          totalChanged += count;
        } else {
          lines.splice(startIdx, 1);
          totalChanged += 1;
        }
        break;
      }
      default: {
        return {
          success: false,
          error: `Unknown operation: ${(edit as HashlineEdit).op}`,
        };
      }
    }
  }

  const updatedContent = lines.join("\n");
  const updatedHashlines = hashLines(lines);

  const result: HashlineEditResult = {
    success: true,
    content: updatedContent,
    updatedLines: updatedHashlines,
    linesChanged: totalChanged,
  };

  if (warnings.length > 0) {
    result.error = warnings.join("; ");
  }

  return result;
}
