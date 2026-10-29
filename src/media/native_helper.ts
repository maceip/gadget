import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function findExecutable(name: string, candidates: string[]): string {
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  const pathDirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of pathDirs) {
    const full = join(dir, name);
    if (existsSync(full)) return full;
  }
  throw new Error(`Executable not found: ${name} (checked ${candidates.join(", ")})`);
}

export function resolveSwiftSourcePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "macos_sensory.swift"),
    resolve(here, "../../../src/media/macos_sensory.swift"),
    resolve(process.cwd(), "src/media/macos_sensory.swift"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`macos_sensory.swift not found (checked ${candidates.join(", ")})`);
}

export function ensureSensoryBinary(binDir = join(homedir(), ".gadget", "bin")): string {
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const srcPath = resolveSwiftSourcePath();
  const srcHash = createHash("sha256").update(readFileSync(srcPath)).digest("hex");
  const binPath = join(binDir, "gadget-sensory");
  const hashPath = join(binDir, "gadget-sensory.sha256");

  if (existsSync(binPath) && existsSync(hashPath)) {
    const recorded = readFileSync(hashPath, "utf8").trim();
    if (recorded === srcHash) return binPath;
  }

  const swiftc = findExecutable("swiftc", [
    join(homedir(), ".swiftly/bin/swiftc"),
    "/usr/bin/swiftc",
    "/opt/homebrew/bin/swiftc",
  ]);

  execFileSync(swiftc, ["-O", srcPath, "-o", binPath], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  chmodSync(binPath, 0o700);
  writeFileSync(hashPath, `${srcHash}\n`, { mode: 0o600 });
  return binPath;
}

export function runSensoryCommand<T>(args: string[], binDir?: string): T {
  const bin = ensureSensoryBinary(binDir);
  const out = execFileSync(bin, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  return JSON.parse(out.trim()) as T;
}
