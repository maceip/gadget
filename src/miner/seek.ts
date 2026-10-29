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
// can come anywhere, often after a pasted log or diff, so the whole turn is read. It is
// first reduced to prose (see proseLines): fenced code is dropped, and inline code and
// URLs are held out as opaque placeholders so their "?" never counts. A sentence is a
// question if it ends in "?" right after a word or a placeholder (not "x ? y" or "a?.b"),
// or if it is the turn's first or last sentence and starts with a question word. A
// sentence with a request clause ("can you fix X?", "Given that, could you ...") is not
// seeking, nor is "Do not ..."/"Don't ...", nor is a turn that opens with a tool's reply
// tag. Everything else (whether a question is worth surfacing on) is learned from
// episodes and labels by the Anticipator, not hand-filtered here (AGENTS.md 6.1).
// Returns the question sentences, with code and URLs restored (the search query), or null.
const SYSTEM_REPLY_TAG = /^<(send_user_message_question_reply|external_codex_apps_|environment_context|permissions|collaboration_mode|turn_aborted)\b/i;
const REQUEST = /^(?:can|could|would|will) you\b|^please\s+\S|^do\s+not\b|^don['’]?t\b/i;
// Opening formatting (**, _, quotes, brackets) and discourse openers ("Also, can you
// ...", "Then could you ...") come off before the request and question-word tests.
const OPENER = /^(?:[*_"'`(\[]+|(?:also|and|then|so|ok|okay|now|but|hey|btw|next|finally|lastly)\b[,:]?\s*)+/i;
const QUESTION_START = /^(what|how|why|where|when|which|who|whose|is|are|does|do(?!\s+not\b|n['’]?t\b)|did|should|has|have)\b/i;
// Placeholders for inline code and URLs: private-use characters around an index.
const HOLD_OPEN = "\uE000";
const HOLD_CLOSE = "\uE001";
// Closing formatting after the "?" is allowed: **Why does this fail?** or "Why?".
const QUESTION_END = /[\p{L}\p{N}"'\uE001]\?+[*_"'`)\]]*$/u;
const CONTAINER = /^(?:(?:[-*+]|\d+[.)])\s+|>\s*)+/;
const FENCE = /^(`{3,}|~{3,})/;
const INLINE_CODE = /(`+)[^`]*?\1/g;
const URL_SPAN = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

// The turn's prose lines: list and quote markers removed, fenced blocks dropped (a fence
// closes only on the same character, at least as long, as in CommonMark; it may sit
// inside a list item or quote), and inline code and URLs replaced by placeholders whose
// original text is kept in `held`.
function proseLines(text: string, held: string[]): string[] {
  const lines: string[] = [];
  let fence: string | null = null;
  // An indented code block (4+ spaces or a tab) starts after a blank line and runs
  // while lines stay indented or blank.
  let afterBlank = true;
  let indentedCode = false;
  for (const raw of text.split("\n")) {
    // Block quote markers ("> ", each taking one optional space) come off first, so an
    // indented block inside a quote is still code.
    const body = raw.replace(/^ {0,3}(?:> ?)+/, "");
    const indented = /^(?: {4}|\t)/.test(body) && body.trim() !== "";
    if (fence === null && indented && (afterBlank || indentedCode)) {
      indentedCode = true;
      continue;
    }
    indentedCode = indentedCode && body.trim() === "";
    afterBlank = body.trim() === "";
    const line = body.trim().replace(CONTAINER, "");
    // A backtick fence's info string cannot contain a backtick (CommonMark), so
    // "```--jitless``` why ...?" is inline code, not a fence.
    const found = FENCE.exec(line)?.[1];
    const marker = found && !(found[0] === "`" && line.slice(found.length).includes("`")) ? found : undefined;
    if (fence !== null) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.slice(marker.length).trim() === "") fence = null;
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    if (!line) continue;
    const hold = (m: string) => `${HOLD_OPEN}${held.push(m) - 1}${HOLD_CLOSE}`;
    lines.push(line.replace(INLINE_CODE, hold).replace(URL_SPAN, hold));
  }
  return lines;
}

function isRequest(sentence: string): boolean {
  return sentence.split(/[,;:]\s+/).some((clause) => REQUEST.test(clause.replace(OPENER, "")));
}

export function askedQuestion(text: string): string | null {
  if (SYSTEM_REPLY_TAG.test(text.trim())) return null;
  const held: string[] = [];
  const sentences = proseLines(text, held).flatMap((l) => l.split(/(?<=[.!?][*_"'`)\]]*)\s+/).filter(Boolean));
  const found = sentences.filter((s, i) => {
    if (isRequest(s)) return false;
    const edge = i === 0 || i === sentences.length - 1;
    return QUESTION_END.test(s) || (edge && QUESTION_START.test(s.replace(OPENER, "")));
  });
  if (found.length === 0) return null;
  const restore = (s: string) => s.replace(/\uE000(\d+)\uE001/g, (_, i: string) => held[Number(i)] ?? "");
  return found.map(restore).join(" ").slice(0, 500);
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
  if (
    (e.source === "codex_session" || e.source === "antigravity_session") &&
    meta.kind === "tool_command"
  ) {
    return splitCommands(e.contentText)
      .map(classifyCommand)
      .filter((s): s is Seek => s !== null);
  }
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
