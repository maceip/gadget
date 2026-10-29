// Minimal POSIX-ish shell word splitter, enough to classify commands.
// Not a shell: command substitution and expansions are kept as literal text.

export interface SimpleCommand {
  argv: string[];
  pipedFrom?: string; // argv[0] (after wrappers) of the command feeding this one through a pipe
}

type Token = { kind: "word"; value: string } | { kind: "op"; value: string };

export function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  let word = "";
  let inWord = false;
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
    if (c === "#" && !inWord) break; // comment
    if (c === " " || c === "\t") {
      flush();
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

// Strips leading VAR=value assignments, wrappers (sudo, env, time, ...) and xargs with its options.
export function stripWrappers(argv: string[]): string[] {
  let i = 0;
  for (;;) {
    while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]!)) i++;
    const w = argv[i];
    if (w === undefined) break;
    if (WRAPPERS.has(w)) {
      // A wrapper with nothing to run is the command itself (`env`, `time`).
      let j = i + 1;
      while (j < argv.length && (argv[j]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[j]!))) j++;
      if (j >= argv.length) break;
      i++;
      while (i < argv.length && argv[i]!.startsWith("-")) i++;
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
  let pipedFrom: string | undefined;
  let skipNextWord = false;
  const end = (nextPiped: boolean) => {
    const stripped = stripWrappers(argv);
    if (stripped.length > 0) commands.push(pipedFrom ? { argv: stripped, pipedFrom } : { argv: stripped });
    pipedFrom = nextPiped ? stripped[0] : undefined;
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
    end(t.value === "|" || t.value === "|&");
  }
  end(false);
  return commands;
}
