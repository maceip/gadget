import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// dist/src/miner/paths.js -> repo root
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// Resolves symlinks in the longest existing prefix of p, so a path that does not exist
// yet still compares by where it would really be written.
export function realResolve(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    tail.unshift(basename(cur));
    cur = parent;
  }
  return join(existsSync(cur) ? realpathSync(cur) : cur, ...tail);
}

// Private data (the store, reports) must never be written where git could pick it up.
export function assertOutsideRepo(path: string, what: string): void {
  if (isInside(realResolve(path), realResolve(REPO_ROOT))) {
    throw new Error(`refusing to write ${what} inside the repo (${resolve(path)}); it contains private data`);
  }
}
