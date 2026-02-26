import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { CacheEntry } from "./types.js";

const PROJECT_MARKERS = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod"];

/**
 * Get the project root directory.
 * Primary: $CLAUDE_PROJECT_DIR (set by Claude Code)
 * Fallback: walk up from filePath looking for project markers
 * Last resort: cwd
 */
function getProjectRoot(filePath?: string): string {
  if (process.env.CLAUDE_PROJECT_DIR) {
    return process.env.CLAUDE_PROJECT_DIR;
  }
  if (filePath) {
    let dir = dirname(filePath);
    while (dir !== dirname(dir)) {
      for (const marker of PROJECT_MARKERS) {
        if (existsSync(join(dir, marker))) {
          return dir;
        }
      }
      dir = dirname(dir);
    }
  }
  return process.cwd();
}

/**
 * Get the .strata cache directory for a file's project.
 */
function getCacheDir(filePath?: string): string {
  return join(getProjectRoot(filePath), ".strata");
}

function ensureCacheDir(filePath?: string): void {
  mkdirSync(getCacheDir(filePath), { recursive: true });
}

export const CACHE_FORMAT_VERSION = 2;

function cacheFileName(filePath: string, mtime: number): string {
  const hash = createHash("sha256").update(filePath).digest("hex");
  // Convert ms → seconds to match shell hook's stat output
  const mtimeSec = Math.floor(mtime / 1000);
  return `${hash}-${mtimeSec}-v${CACHE_FORMAT_VERSION}.txt`;
}

/**
 * L1: In-memory LRU cache for structural analysis results.
 * Bounded by maxSize — evicts least recently accessed entries when full.
 * L2 (filesystem .strata/) provides persistence and serves hooks directly.
 */
export class JITCache {
  private entries: Map<string, CacheEntry> = new Map();
  private readonly maxSize: number;

  constructor(maxSize = 128) {
    this.maxSize = maxSize;
  }

  get(filePath: string, mtime: number): CacheEntry | null {
    const entry = this.entries.get(filePath);
    if (!entry) return null;
    if (entry.tree.mtime !== mtime) return null;
    // Move to end for LRU (Map iteration order = insertion order)
    this.entries.delete(filePath);
    this.entries.set(filePath, entry);
    return entry;
  }

  set(filePath: string, entry: CacheEntry): void {
    // If key already exists, delete first so re-insert goes to end
    if (this.entries.has(filePath)) {
      this.entries.delete(filePath);
    }
    this.entries.set(filePath, entry);
    // Evict oldest entries if over capacity
    while (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
  }

  invalidate(filePath: string): void {
    this.entries.delete(filePath);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  keys(): string[] {
    return Array.from(this.entries.keys());
  }
}

export function writeCacheFile(
  filePath: string,
  mtime: number,
  content: string,
): string {
  ensureCacheDir(filePath);
  const name = cacheFileName(filePath, mtime);
  const cacheDir = getCacheDir(filePath);
  const cachePath = join(cacheDir, name);
  writeFileSync(cachePath, content, "utf-8");
  return cachePath;
}

export function getCacheFilePath(
  filePath: string,
  mtime: number,
): string | null {
  const name = cacheFileName(filePath, mtime);
  const cachePath = join(getCacheDir(filePath), name);
  return existsSync(cachePath) ? cachePath : null;
}
