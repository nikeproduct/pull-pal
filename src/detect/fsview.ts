/**
 * A four-method window onto the project directory.
 *
 * Detectors take a FsView rather than touching `node:fs`, so the whole detection
 * table can be exercised against in-memory fixtures — no temp directories, no
 * "create a fake Cargo project" dance, and every branch reachable in a test.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface FsView {
  exists(rel: string): boolean;
  isDirectory(rel: string): boolean;
  read(rel: string): string | null;
  readJson<T = unknown>(rel: string): T | null;
}

export function createFsView(root: string): FsView {
  const view: FsView = {
    exists(rel) {
      return existsSync(join(root, rel));
    },
    isDirectory(rel) {
      try {
        return statSync(join(root, rel)).isDirectory();
      } catch {
        return false;
      }
    },
    read(rel) {
      try {
        return readFileSync(join(root, rel), "utf8");
      } catch {
        return null;
      }
    },
    readJson(rel) {
      const raw = view.read(rel);
      if (raw === null) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
  };
  return view;
}

export interface MemoryFs {
  /** Path → file contents. */
  files?: Record<string, string>;
  /** Paths that should report as directories. */
  dirs?: string[];
}

/** In-memory FsView for tests. */
export function createMemoryFsView({ files = {}, dirs = [] }: MemoryFs): FsView {
  const dirSet = new Set(dirs);
  const view: FsView = {
    exists: (rel) => rel in files || dirSet.has(rel),
    isDirectory: (rel) => dirSet.has(rel),
    read: (rel) => files[rel] ?? null,
    readJson(rel) {
      const raw = view.read(rel);
      if (raw === null) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
  };
  return view;
}
