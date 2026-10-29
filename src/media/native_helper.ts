import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SENSORY_APP_NAME = "Gadget Read-Only Sensory Capture";
export const SENSORY_BUNDLE_ID = "local.gadget.sensory-capture";
export const SENSORY_EXEC_NAME = "GadgetSensoryCapture";

const INFO_PLIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>${SENSORY_APP_NAME}</string>
  <key>CFBundleDisplayName</key>
  <string>${SENSORY_APP_NAME}</string>
  <key>CFBundleIdentifier</key>
  <string>${SENSORY_BUNDLE_ID}</string>
  <key>CFBundleExecutable</key>
  <string>${SENSORY_EXEC_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSAccessibilityUsageDescription</key>
  <string>Gadget Read-Only Sensory Capture reads focused non-password text and listen-only keystrokes strictly to local ~/.gadget/capture/ journals. Network and process execution are kernel-sandboxed off.</string>
  <key>NSScreenCaptureUsageDescription</key>
  <string>Gadget Read-Only Sensory Capture runs local Vision OCR on screen frames strictly to local ~/.gadget/capture/ journals. Network and process execution are kernel-sandboxed off.</string>
</dict>
</plist>
`;

export interface SensoryPermissionsStatus {
  appName: string;
  bundleId: string;
  executablePath: string;
  appBundlePath: string;
  kernelNetworkAndExecSandboxed: boolean;
  accessibilityTrusted: boolean;
  inputMonitoringAccess: boolean;
  screenCaptureAccess: boolean;
  readOnlyContained: boolean;
}

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

export function getSensoryAppBundlePath(binDir = join(homedir(), ".gadget", "bin")): string {
  return join(binDir, `${SENSORY_APP_NAME}.app`);
}

export function ensureSensoryBinary(binDir = join(homedir(), ".gadget", "bin")): string {
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const srcPath = resolveSwiftSourcePath();
  const srcHash = createHash("sha256")
    .update(readFileSync(srcPath))
    .update(INFO_PLIST_XML)
    .digest("hex");

  const appBundlePath = getSensoryAppBundlePath(binDir);
  const contentsDir = join(appBundlePath, "Contents");
  const macosDir = join(contentsDir, "MacOS");
  const plistPath = join(contentsDir, "Info.plist");
  const binPath = join(macosDir, SENSORY_EXEC_NAME);
  const hashPath = join(binDir, `${SENSORY_EXEC_NAME}.sha256`);

  if (existsSync(binPath) && existsSync(plistPath) && existsSync(hashPath)) {
    const recorded = readFileSync(hashPath, "utf8").trim();
    if (recorded === srcHash) return binPath;
  }

  mkdirSync(macosDir, { recursive: true, mode: 0o700 });
  writeFileSync(plistPath, INFO_PLIST_XML, { mode: 0o644 });

  const swiftc = findExecutable("swiftc", [
    join(homedir(), ".swiftly/bin/swiftc"),
    "/usr/bin/swiftc",
    "/opt/homebrew/bin/swiftc",
  ]);

  const tmpBinPath = `${binPath}.tmp.${process.pid}`;
  rmSync(tmpBinPath, { force: true });
  execFileSync(
    swiftc,
    [
      "-O",
      "-Xlinker",
      "-sectcreate",
      "-Xlinker",
      "__TEXT",
      "-Xlinker",
      "__info_plist",
      "-Xlinker",
      plistPath,
      srcPath,
      "-o",
      tmpBinPath,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    },
  );
  chmodSync(tmpBinPath, 0o700);
  renameSync(tmpBinPath, binPath);

  // Ad-hoc sign the .app bundle with its descriptive bundle identifier so macOS TCC
  // tracks permissions for "Gadget Read-Only Sensory Capture" (local.gadget.sensory-capture).
  const codesign = findExecutable("codesign", ["/usr/bin/codesign"]);
  execFileSync(
    codesign,
    ["--force", "--sign", "-", "--identifier", SENSORY_BUNDLE_ID, appBundlePath],
    {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    },
  );

  // Also install a copy into ~/Applications when building in the default ~/.gadget/bin
  // so the user can see and toggle "Gadget Read-Only Sensory Capture.app" in System Settings.
  const defaultBinDir = join(homedir(), ".gadget", "bin");
  if (resolve(binDir) === resolve(defaultBinDir)) {
    try {
      const userAppsDir = join(homedir(), "Applications");
      mkdirSync(userAppsDir, { recursive: true });
      const installedAppPath = join(userAppsDir, `${SENSORY_APP_NAME}.app`);
      cpSync(appBundlePath, installedAppPath, { recursive: true, force: true });
      execFileSync(
        codesign,
        ["--force", "--sign", "-", "--identifier", SENSORY_BUNDLE_ID, installedAppPath],
        { stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 },
      );
    } catch {
      // ignore if ~/Applications is restricted in a sandboxed test environment
    }
  }

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

export function checkSensoryPermissions(opts: { prompt?: boolean; binDir?: string } = {}): SensoryPermissionsStatus {
  const args = opts.prompt ? ["permissions", "--prompt"] : ["permissions"];
  const raw = runSensoryCommand<Omit<SensoryPermissionsStatus, "appBundlePath">>(args, opts.binDir);
  return {
    ...raw,
    appBundlePath: getSensoryAppBundlePath(opts.binDir),
  };
}
