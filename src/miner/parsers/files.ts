import { readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

// Recursively lists files under dir (no symlinks followed). Missing dir -> [].
export function listFiles(dir: string, filter: (path: string) => boolean = () => true): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && filter(p)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

export interface FileCensus {
  files: number;
  bytes: number;
  byExtension: Record<string, number>;
}

// Counts files by extension without reading their contents (used for Antigravity).
export function censusFiles(dir: string): FileCensus {
  const census: FileCensus = { files: 0, bytes: 0, byExtension: {} };
  for (const p of listFiles(dir)) {
    census.files++;
    try {
      census.bytes += statSync(p).size;
    } catch {
      // vanished
    }
    const ext = extname(p).toLowerCase() || "(none)";
    census.byExtension[ext] = (census.byExtension[ext] ?? 0) + 1;
  }
  return census;
}
