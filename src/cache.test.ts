import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync, existsSync } from "node:fs";
import { JITCache, writeCacheFile, getCacheFilePath } from "./cache.js";
import type { CacheEntry, StructuralTree } from "./types.js";

function makeTree(filePath: string, mtime: number): StructuralTree {
  return { filePath, mtime, lineCount: 100, children: [] };
}

function makeEntry(filePath: string, mtime: number): CacheEntry {
  return {
    tree: makeTree(filePath, mtime),
    tokens: [],
    renderedView: "rendered",
    cachedAt: Date.now(),
  };
}

describe("JITCache", () => {
  let cache: JITCache;

  beforeEach(() => {
    cache = new JITCache();
  });

  it("returns null for unknown file", () => {
    assert.equal(cache.get("/foo.ts", 1000), null);
  });

  it("stores and retrieves an entry", () => {
    const entry = makeEntry("/foo.ts", 1000);
    cache.set("/foo.ts", entry);
    const result = cache.get("/foo.ts", 1000);
    assert.deepEqual(result, entry);
  });

  it("returns null when mtime is stale", () => {
    cache.set("/foo.ts", makeEntry("/foo.ts", 1000));
    assert.equal(cache.get("/foo.ts", 2000), null);
  });

  it("invalidates an entry", () => {
    cache.set("/foo.ts", makeEntry("/foo.ts", 1000));
    cache.invalidate("/foo.ts");
    assert.equal(cache.get("/foo.ts", 1000), null);
    assert.equal(cache.size, 0);
  });

  it("clears all entries", () => {
    cache.set("/a.ts", makeEntry("/a.ts", 1));
    cache.set("/b.ts", makeEntry("/b.ts", 2));
    assert.equal(cache.size, 2);
    cache.clear();
    assert.equal(cache.size, 0);
  });

  it("returns keys", () => {
    cache.set("/a.ts", makeEntry("/a.ts", 1));
    cache.set("/b.ts", makeEntry("/b.ts", 2));
    assert.deepEqual(cache.keys().sort(), ["/a.ts", "/b.ts"]);
  });

  it("replaces entry on re-set", () => {
    cache.set("/foo.ts", makeEntry("/foo.ts", 1000));
    const newEntry = makeEntry("/foo.ts", 2000);
    cache.set("/foo.ts", newEntry);
    assert.equal(cache.get("/foo.ts", 1000), null);
    assert.deepEqual(cache.get("/foo.ts", 2000), newEntry);
    assert.equal(cache.size, 1);
  });
});

describe("JITCache LRU eviction", () => {
  it("evicts oldest entry when maxSize exceeded", () => {
    const cache = new JITCache(3);
    cache.set("/a.ts", makeEntry("/a.ts", 1));
    cache.set("/b.ts", makeEntry("/b.ts", 2));
    cache.set("/c.ts", makeEntry("/c.ts", 3));
    assert.equal(cache.size, 3);

    // Adding a 4th evicts the oldest (/a.ts)
    cache.set("/d.ts", makeEntry("/d.ts", 4));
    assert.equal(cache.size, 3);
    assert.equal(cache.get("/a.ts", 1), null);
    assert.notEqual(cache.get("/b.ts", 2), null);
    assert.notEqual(cache.get("/d.ts", 4), null);
  });

  it("accessing an entry promotes it in LRU order", () => {
    const cache = new JITCache(3);
    cache.set("/a.ts", makeEntry("/a.ts", 1));
    cache.set("/b.ts", makeEntry("/b.ts", 2));
    cache.set("/c.ts", makeEntry("/c.ts", 3));

    // Access /a.ts to promote it (it was oldest)
    cache.get("/a.ts", 1);

    // Now /b.ts is oldest — adding /d.ts should evict /b.ts, not /a.ts
    cache.set("/d.ts", makeEntry("/d.ts", 4));
    assert.equal(cache.size, 3);
    assert.notEqual(cache.get("/a.ts", 1), null);
    assert.equal(cache.get("/b.ts", 2), null);
  });

  it("re-setting a key promotes it in LRU order", () => {
    const cache = new JITCache(3);
    cache.set("/a.ts", makeEntry("/a.ts", 1));
    cache.set("/b.ts", makeEntry("/b.ts", 2));
    cache.set("/c.ts", makeEntry("/c.ts", 3));

    // Re-set /a.ts (updates mtime)
    cache.set("/a.ts", makeEntry("/a.ts", 10));

    // /b.ts is now oldest — adding /d.ts should evict /b.ts
    cache.set("/d.ts", makeEntry("/d.ts", 4));
    assert.equal(cache.size, 3);
    assert.notEqual(cache.get("/a.ts", 10), null);
    assert.equal(cache.get("/b.ts", 2), null);
  });
});

describe("filesystem cache", () => {
  const cleanupPaths: string[] = [];

  after(() => {
    for (const p of cleanupPaths) {
      try {
        unlinkSync(p);
      } catch {
        // ignore
      }
    }
  });

  it("writes and reads a cache file", () => {
    // mtime in ms (e.g., 1700000000123) → seconds (1700000000) in filename
    const mtimeMs = 1700000000123;
    const path = writeCacheFile("/test/file.ts", mtimeMs, "hello world");
    cleanupPaths.push(path);
    assert.ok(path.includes(".strata/"));
    assert.ok(path.endsWith("-1700000000-v2.txt"), `expected versioned seconds in filename, got: ${path}`);
    assert.ok(existsSync(path));
  });

  it("getCacheFilePath returns path when file exists", () => {
    const mtimeMs = 1700099999456;
    const path = writeCacheFile("/test/file2.ts", mtimeMs, "content");
    cleanupPaths.push(path);
    const found = getCacheFilePath("/test/file2.ts", mtimeMs);
    assert.equal(found, path);
  });

  it("getCacheFilePath returns null when file does not exist", () => {
    const found = getCacheFilePath("/nonexistent/file.ts", 1700011111000);
    assert.equal(found, null);
  });
});
