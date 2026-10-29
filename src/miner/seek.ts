// The fixed definition of "looking for something" (AGENTS.md section 6.1).
// This list describes behavior, not causes. It should stay small.

import { splitCommands, type SimpleCommand } from "./shell.js";
import type { EpisodicEvent, Seek } from "./types.js";

const GREP_TOOLS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "ack-grep"]);

// Options that consume the following word as their value, per tool family.
// The same short flag means different things across tools (grep -r is recursive, rg -r replaces).
const LONG_VALUE_OPTS = [
  "--regexp", "--file", "--max-count", "--after-context", "--before-context", "--context",
  "--include", "--exclude", "--exclude-dir", "--label", "--binary-files", "--devices",
  "--directories", "--glob", "--iglob", "--type", "--type-not", "--type-add", "--max-columns",
  "--threads", "--encoding", "--sort", "--sortr", "--replace", "--max-depth", "--ignore",
  "--file-search-regex", "--depth",
];
const GREP_VALUE_OPTS: Record<string, Set<string>> = {
  grep: new Set(["-e", "-f", "-A", "-B", "-C", "-m", "-d", "-D", ...LONG_VALUE_OPTS]),
  rg: new Set(["-e", "-f", "-A", "-B", "-C", "-m", "-g", "-t", "-T", "-M", "-j", "-r", "-E", "-d", ...LONG_VALUE_OPTS]),
  ag: new Set(["-A", "-B", "-C", "-m", "-G", "-g", ...LONG_VALUE_OPTS]),
};
const GREP_FAMILY: Record<string, string> = {
  grep: "grep", egrep: "grep", fgrep: "grep", rg: "rg", ag: "ag", ack: "ag", "ack-grep": "ag",
};

// Commands whose output, piped into grep, is a status listing rather than content being
// searched. Single-purpose tools match by name; multi-purpose tools only for their listing
// subcommands (`docker ps | grep api` lists, `docker logs svc | grep timeout` searches).
const STATUS_LISTERS = new Set([
  "ps", "pgrep", "lsof", "env", "printenv", "ls", "ll", "la", "exa", "eza", "netstat", "ss",
  "top", "jobs", "alias", "set", "declare", "df", "du", "ifconfig", "ip", "mount", "ioreg",
  "system_profiler", "uname", "sw_vers",
]);
const STATUS_SUBCOMMANDS: Record<string, Set<string>> = {
  docker: new Set(["ps", "images"]),
  kubectl: new Set(["get"]),
  brew: new Set(["list", "ls"]),
  pip: new Set(["list", "freeze"]),
  pip3: new Set(["list", "freeze"]),
  npm: new Set(["ls", "list"]),
  pnpm: new Set(["ls", "list"]),
  yarn: new Set(["list"]),
  launchctl: new Set(["list"]),
  systemctl: new Set(["list-units", "list-unit-files", "status"]),
  dpkg: new Set(["-l"]),
  rpm: new Set(["-qa"]),
  apt: new Set(["list"]),
  nvm: new Set(["ls", "list"]),
  pyenv: new Set(["versions"]),
};

function isStatusListing(upstream: string[] | undefined): boolean {
  const [tool, sub] = upstream ?? [];
  if (!tool) return false;
  return STATUS_LISTERS.has(tool) || (STATUS_SUBCOMMANDS[tool]?.has(sub ?? "") ?? false);
}

const FIND_NAME_PREDICATES = new Set(["-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-regex", "-iregex"]);
const FD_VALUE_OPTS = new Set(["-e", "-t", "-E", "-d", "-j", "-S", "-c", "-x", "-X", "--extension", "--type", "--exclude", "--max-depth", "--threads", "--size", "--color", "--exec", "--exec-batch", "--changed-within", "--changed-before", "--owner", "--base-directory", "--search-path"]);
const GIT_GLOBAL_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const HELP_TOOLS = new Set(["tldr", "cheat", "apropos", "whatis", "info"]);

export function classifyCommand(cmd: SimpleCommand): Seek | null {
  const [tool, ...args] = cmd.argv;
  if (!tool) return null;

  if (GREP_TOOLS.has(tool)) return grepSeek(GREP_FAMILY[tool] ?? "grep", args, cmd.pipedFrom);
  if (tool === "git") return gitSeek(args, cmd.pipedFrom);
  if (tool === "find") return findSeek(args);
  if (tool === "fd" || tool === "fdfind") {
    const q = firstPositional(args, FD_VALUE_OPTS);
    return q ? { kind: "GREP", query: q } : null;
  }
  if (tool === "man") {
    const rest = args.filter((a) => !a.startsWith("-") && !/^\d[a-z]*$/i.test(a));
    return rest.length ? { kind: "HELP_LOOKUP", query: rest.join(" ") } : null;
  }
  if (HELP_TOOLS.has(tool)) {
    const rest = args.filter((a) => !a.startsWith("-"));
    return rest.length ? { kind: "HELP_LOOKUP", query: rest.join(" ") } : null;
  }
  const helpAt = args.indexOf("--help");
  if (helpAt >= 0) {
    const words = [tool, ...args.slice(0, helpAt).filter((a) => !a.startsWith("-"))];
    return { kind: "HELP_LOOKUP", query: words.join(" ") };
  }
  return null;
}

function grepSeek(family: string, args: string[], pipedFrom: string[] | undefined): Seek | null {
  if (isStatusListing(pipedFrom)) return null;
  const explicit = family === "ag" ? undefined : optionValue(args, ["-e", "--regexp"]);
  const q = explicit ?? firstPositional(args, GREP_VALUE_OPTS[family]!);
  return q ? { kind: "GREP", query: q } : null;
}

function gitSeek(args: string[], pipedFrom: string[] | undefined): Seek | null {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) {
    if (GIT_GLOBAL_VALUE_OPTS.has(args[i]!)) i++;
    i++;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === "grep") return grepSeek("grep", rest, pipedFrom);
  if (sub === "log") {
    for (let j = 0; j < rest.length; j++) {
      const a = rest[j]!;
      for (const flag of ["-S", "-G"]) {
        if (a === flag && rest[j + 1]) return { kind: "GIT_ARCHAEOLOGY", query: rest[j + 1]! };
        if (a.startsWith(flag) && a.length > 2) return { kind: "GIT_ARCHAEOLOGY", query: a.slice(2) };
      }
      if (a === "--grep" && rest[j + 1]) return { kind: "GIT_ARCHAEOLOGY", query: rest[j + 1]! };
      if (a.startsWith("--grep=")) return { kind: "GIT_ARCHAEOLOGY", query: a.slice("--grep=".length) };
    }
    return null;
  }
  if (sub === "blame") {
    const positionals = rest.filter((a, j) => !a.startsWith("-") && !["-L", "-S", "--contents"].includes(rest[j - 1] ?? ""));
    const file = positionals.at(-1);
    return file ? { kind: "GIT_ARCHAEOLOGY", query: file } : null;
  }
  if (sub === "show") {
    const sha = rest.find((a) => /^[0-9a-f]{7,40}(:.*)?$/.test(a));
    return sha ? { kind: "GIT_ARCHAEOLOGY", query: sha } : null;
  }
  return null;
}

function findSeek(args: string[]): Seek | null {
  for (let j = 0; j < args.length - 1; j++) {
    if (FIND_NAME_PREDICATES.has(args[j]!)) return { kind: "GREP", query: args[j + 1]! };
  }
  return null;
}

function optionValue(args: string[], names: string[]): string | undefined {
  for (let j = 0; j < args.length; j++) {
    const a = args[j]!;
    if (a === "--") return undefined;
    if (names.includes(a)) return args[j + 1];
    for (const n of names) {
      if (n.startsWith("--") && a.startsWith(n + "=")) return a.slice(n.length + 1);
      if (!n.startsWith("--") && a.startsWith(n) && a.length > n.length) return a.slice(n.length);
    }
  }
  return undefined;
}

function firstPositional(args: string[], valueOpts: Set<string>): string | undefined {
  for (let j = 0; j < args.length; j++) {
    const a = args[j]!;
    if (a === "--") return args[j + 1];
    if (a.startsWith("-") && a.length > 1) {
      if (valueOpts.has(a)) j++;
      continue;
    }
    return a;
  }
  return undefined;
}

// ASK_AGENT: an owner turn in a coding-agent session that asks a question. The question
// can come anywhere, often after a pasted log or diff, so the whole turn is read, minus
// fenced code. A sentence is a question if it ends in "?" right after a word (not
// "x ? y", "a?.b", or "?q=" in a URL), or if it is the turn's first or last sentence and
// starts with a question word. Requests phrased as questions ("can you fix X?") are not
// seeking. Returns the question sentences (the search query), or null.
const REQUEST = /^(can|could|would|will) you\b|^please\b/i;
const QUESTION_START = /^(what|how|why|where|when|which|who|whose|is|are|does|do(?! not\b)|did|should|has|have)\b/i;
const QUESTION_END = /[\p{L}\p{N}"'`]\?+$/u;

export function askedQuestion(text: string): string | null {
  const sentences: string[] = [];
  let inFence = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line) continue;
    // List and quote markers ("- ", "1. ", "> ") are not part of the sentence.
    const text = line.replace(/^(?:(?:[-*+]|\d+[.)]|>)\s*)+/, "");
    sentences.push(...text.split(/(?<=[.!?])\s+/).filter(Boolean));
  }
  const found = sentences.filter(
    (s, i) => !REQUEST.test(s) && (QUESTION_END.test(s) || ((i === 0 || i === sentences.length - 1) && QUESTION_START.test(s))),
  );
  return found.length > 0 ? found.join(" ").slice(0, 500) : null;
}

export function isQuestion(text: string): boolean {
  return askedQuestion(text) !== null;
}

const DOCS_HOSTS = /(^|\.)(docs\.rs|pkg\.go\.dev|devdocs\.io|developer\.mozilla\.org|developer\.apple\.com|learn\.microsoft\.com)$|^docs\.[^.]+\.[^.]+$|\.readthedocs\.(io|org)$/i;
const DOCS_PATH = /^\/(docs|documentation|reference|manual|man|api)(\/|$)/i;

// Detects a visit to a documentation page from its URL and title/contentText.
export function docsSiteQuery(sourceUri: string, contentText: string): string | null {
  let u: URL;
  try {
    u = new URL(sourceUri);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.pathname === "/" || u.pathname === "") return null;
  const isDocs = DOCS_HOSTS.test(u.hostname) || DOCS_PATH.test(u.pathname);
  if (!isDocs) return null;
  const firstLine = contentText.split("\n")[0]?.trim() ?? "";
  if (firstLine && !firstLine.startsWith("http://") && !firstLine.startsWith("https://")) {
    return firstLine.slice(0, 200);
  }
  const slug = u.pathname
    .split("/")
    .filter(Boolean)
    .slice(-2)
    .join(" ")
    .replace(/[-_]+/g, " ")
    .replace(/\.[a-z0-9]+$/i, "")
    .trim();
  return slug || null;
}

// Every seek action in one event. A shell entry can hold several (`rg foo; rg bar`).
export function classifyEventAll(e: EpisodicEvent): Seek[] {
  if (e.source === "zsh" || e.source === "zsh_hook") {
    return splitCommands(e.contentText)
      .map(classifyCommand)
      .filter((s): s is Seek => s !== null);
  }
  const meta = parseMeta(e.metadataJson);
  if (e.source === "chrome" && meta.kind === "search") return [{ kind: "WEB_SEARCH", query: e.contentText }];
  if (e.source === "chrome" && meta.kind === "visit") {
    const q = docsSiteQuery(e.sourceUri, e.contentText);
    return q ? [{ kind: "HELP_LOOKUP", query: q }] : [];
  }
  if ((e.source === "codex_session" || e.source === "antigravity_session") && meta.role === "user") {
    const question = askedQuestion(e.contentText);
    return question ? [{ kind: "ASK_AGENT", query: question }] : [];
  }
  return [];
}

// The first seek action in an event, or null.
export function classifyEvent(e: EpisodicEvent): Seek | null {
  return classifyEventAll(e)[0] ?? null;
}

export function withSeeks(events: EpisodicEvent[]): Array<{ event: EpisodicEvent; seeks: Seek[] }> {
  return events.map((event) => ({ event, seeks: classifyEventAll(event) }));
}

export function parseMeta(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
