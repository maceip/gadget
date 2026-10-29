// Minimal POSIX-ish shell word splitter, enough to classify commands.
// Not a shell: command substitution and expansions are kept as literal text.

export interface SimpleCommand {
  argv: string[];
  pipedFrom?: string[]; // first two words (after wrappers) of the command piping into this one
}

type Token = { kind: "word"; value: string } | { kind: "op"; value: string };

export function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  let word = "";
  let inWord = false;
  // Heredocs seen on the current line; their bodies start after the next newline.
  let heredocs: Array<{ delim: string; stripTabs: boolean }> = [];
  const flush = () => {
    if (inWord) tokens.push({ kind: "word", value: word });
    word = "";
    inWord = false;
  };

  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "\\") {
      if (i + 1 < line.length) {
        const next = line[++i]!;
        if (next !== "\n") word += next;
        inWord = true;
      }
      continue;
    }
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      word += end < 0 ? line.slice(i + 1) : line.slice(i + 1, end);
      i = end < 0 ? line.length : end;
      inWord = true;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === "\\" && i + 1 < line.length && '"\\$`'.includes(line[i + 1]!)) i++;
        word += line[i];
        i++;
      }
      inWord = true;
      continue;
    }
    if (c === "$" && line[i + 1] === "(") {
      // keep $( ... ) as literal text inside the current word
      let depth = 0;
      for (; i < line.length; i++) {
        const d = line[i]!;
        word += d;
        if (d === "(") depth++;
        else if (d === ")" && --depth === 0) break;
      }
      inWord = true;
      continue;
    }
    if (c === "#" && !inWord) {
      // comment: skip to the end of this line; later lines are still commands
      const nl = line.indexOf("\n", i);
      if (nl < 0) break;
      i = nl - 1;
      continue;
    }
    if (c === " " || c === "\t") {
      flush();
      continue;
    }
    if (c === "\n" && heredocs.length > 0) {
      // Skip heredoc bodies: they are text being written, not commands.
      flush();
      tokens.push({ kind: "op", value: ";" });
      let pos = i + 1;
      for (const h of heredocs) {
        while (pos < line.length) {
          const nl = line.indexOf("\n", pos);
          const end = nl < 0 ? line.length : nl;
          const body = h.stripTabs ? line.slice(pos, end).replace(/^\t+/, "") : line.slice(pos, end);
          pos = end + 1;
          if (body === h.delim) break;
        }
      }
      heredocs = [];
      i = Math.min(pos, line.length) - 1;
      continue;
    }
    if (c === "\n" || c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
      flush();
      let op = c;
      const two = line.slice(i, i + 2);
      if (two === "&&" || two === "||" || two === "|&" || two === ";;") {
        op = two;
        i++;
      }
      tokens.push({ kind: "op", value: op === "\n" ? ";" : op });
      continue;
    }
    if (c === "<" && line[i + 1] === "<" && line[i + 2] !== "<") {
      // heredoc: read the delimiter (quotes and backslashes removed), skip the body later
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else flush();
      i += 2;
      let stripTabs = false;
      if (line[i] === "-") {
        stripTabs = true;
        i++;
      }
      while (line[i] === " " || line[i] === "\t") i++;
      let delim = "";
      while (i < line.length && !/[\s;&|<>()]/.test(line[i]!)) {
        const ch = line[i]!;
        if (ch === "'" || ch === '"') {
          const end = line.indexOf(ch, i + 1);
          delim += end < 0 ? line.slice(i + 1) : line.slice(i + 1, end);
          i = end < 0 ? line.length : end + 1;
        } else if (ch === "\\") {
          delim += line[i + 1] ?? "";
          i += 2;
        } else {
          delim += ch;
          i++;
        }
      }
      i--;
      if (delim) heredocs.push({ delim, stripTabs });
      tokens.push({ kind: "op", value: "heredoc" });
      continue;
    }
    if (c === ">" || c === "<") {
      // redirection: drop a pending all-digit fd word, the operator, and its target
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else flush();
      while (i + 1 < line.length && /[<>&|]/.test(line[i + 1]!)) i++;
      tokens.push({ kind: "op", value: "redirect" });
      continue;
    }
    word += c;
    inWord = true;
  }
  flush();
  return tokens;
}

const WRAPPERS = new Set(["sudo", "command", "builtin", "time", "noglob", "nocorrect", "nice", "nohup", "exec", "env"]);
const XARGS_VALUE_OPTS = new Set(["-n", "-I", "-P", "-L", "-s", "-d", "-E", "-J", "-R"]);
// Wrapper options that consume the following word (`sudo -u root rg x`).
const WRAPPER_VALUE_OPTS: Record<string, Set<string>> = {
  sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-U", "-D", "-r", "-t", "-T"]),
  env: new Set(["-u", "-C", "-P", "-S"]),
  nice: new Set(["-n"]),
  time: new Set(["-o", "-f"]),
  exec: new Set(["-a"]),
};

// Strips leading VAR=value assignments, wrappers (sudo, env, time, ...) and xargs with its options.
export function stripWrappers(argv: string[]): string[] {
  let i = 0;
  for (;;) {
    while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]!)) i++;
    const w = argv[i];
    if (w === undefined) break;
    if (WRAPPERS.has(w)) {
      // Skip the wrapper's options (and their values) and env-style assignments.
      // A wrapper with nothing left to run is the command itself (`env`, `time`).
      const valueOpts = WRAPPER_VALUE_OPTS[w];
      let j = i + 1;
      while (j < argv.length) {
        const a = argv[j]!;
        if (a.startsWith("-")) j += valueOpts?.has(a) ? 2 : 1;
        else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) j++;
        else break;
      }
      if (j >= argv.length) break;
      i = j;
      continue;
    }
    if (w === "xargs") {
      i++;
      while (i < argv.length && argv[i]!.startsWith("-")) {
        if (XARGS_VALUE_OPTS.has(argv[i]!)) i++;
        i++;
      }
      continue;
    }
    break;
  }
  return argv.slice(i);
}

export function splitCommands(line: string): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  let argv: string[] = [];
  let pipedFrom: string[] | undefined;
  let skipNextWord = false;
  const end = (nextPiped: boolean) => {
    const stripped = stripWrappers(argv);
    if (stripped.length > 0) commands.push(pipedFrom ? { argv: stripped, pipedFrom } : { argv: stripped });
    pipedFrom = nextPiped && stripped.length > 0 ? stripped.slice(0, 2) : undefined;
    argv = [];
  };
  for (const t of tokenize(line)) {
    if (t.kind === "word") {
      if (skipNextWord) skipNextWord = false;
      else argv.push(t.value);
      continue;
    }
    if (t.value === "redirect") {
      skipNextWord = true;
      continue;
    }
    if (t.value === "heredoc") continue; // delimiter already consumed by the tokenizer
    end(t.value === "|" || t.value === "|&");
  }
  end(false);
  return commands;
}
