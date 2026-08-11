// @ts-nocheck: Para browser-lowering pass (canonical home; consumed by Parascape + E)
function _nullishCoalesce(lhs, rhsFn) {
  if (lhs != null) {
    return lhs;
  } else {
    return rhsFn();
  }
}
function _optionalChain(ops) {
  let lastAccessLHS = undefined;
  let value = ops[0];
  let i = 1;
  while (i < ops.length) {
    const op = ops[i];
    const fn = ops[i + 1];
    i += 2;
    if ((op === "optionalAccess" || op === "optionalCall") && value == null) {
      return undefined;
    }
    if (op === "access" || op === "optionalAccess") {
      lastAccessLHS = value;
      value = fn(value);
    } else if (op === "call" || op === "optionalCall") {
      value = fn((...args) => value.call(lastAccessLHS, ...args));
      lastAccessLHS = undefined;
    }
  }
  return value;
}

function skipString(src, at, quote) {
  let i = at + 1;
  const len = src.length;
  while (i < len && src[i] !== quote) {
    if (src[i] === "\\") i++;
    i++;
  }
  return i + 1;
}

// A `/` begins a regex literal (not a divide) when the previous significant
// char is an expression-opener / operator: never after an identifier, `)`,
// `]`, or digit. Mirrors the single-char heuristic used elsewhere in this file.
function isRegexCtx(prev) {
  if (!prev) return true;
  return "([{,;:=!&|?+-*/%^~<>".includes(prev);
}

// Skip a regex literal starting at `at` (the opening `/`), honouring `\`
// escapes and `[...]` character classes (a `/` inside a class is literal), then
// any trailing flags. Returns the index just AFTER the literal. Without this,
// an escaped slash before the closing delimiter (`\//`, as in `/…\*\//g`) reads
// as a `//` line comment and swallows the rest of the line.
function skipRegex(src, at) {
  let i = at + 1;
  const len = src.length;
  let inClass = false;
  while (i < len) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "\n") break; // unterminated: bail rather than run away
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      i++;
      break;
    }
    i++;
  }
  while (i < len && /[a-z]/i.test(src[i])) i++; // flags
  return i;
}

function skipTemplate(src, at) {
  let i = at + 1;
  const len = src.length;
  while (i < len) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src[i] === "`") return i + 1;
    if (src[i] === "$" && src[i + 1] === "{") {
      i = skipBalanced(src, i + 2, "}");
      continue;
    }
    i++;
  }
  return i;
}

/** Walk from `at` to the matching close paren/brace/bracket. Returns
 *  the index AFTER the close. */
function skipBalanced(src, at, closeChar) {
  const opens = "({[";
  const closes = ")}]";
  let i = at;
  let depth = 1;
  let prev = "";
  const len = src.length;
  while (i < len && depth > 0) {
    const c = src[i];
    if (c === "'" || c === '"') {
      i = skipString(src, i, c);
      prev = c;
      continue;
    }
    if (c === "`") {
      i = skipTemplate(src, i);
      prev = "`";
      continue;
    }
    // Regex literal (in expression position) before the comment checks, so an
    // escaped slash near the close (`\//`) isn't mistaken for a `//` comment.
    if (c === "/" && src[i + 1] !== "/" && src[i + 1] !== "*" && isRegexCtx(prev)) {
      i = skipRegex(src, i);
      prev = "/";
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < len && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < len && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    if (opens.includes(c)) {
      if (c === closeChar.replace(")", "(").replace("}", "{").replace("]", "[")) depth++;
      else {
        const matchClose = closes[opens.indexOf(c)];
        i = skipBalanced(src, i + 1, matchClose);
        prev = matchClose; // a closed group is a value → next `/` is divide
        continue;
      }
    } else if (c === closeChar) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return i;
}

/**
 * Tell whether the character before index `i` makes `i`'s `.` a
 * placeholder. Placeholders fire when the dot is at the start of an
 * expression: after whitespace from an opener (`(`, `,`, `[`, `{`)
 * or after a binary/unary operator (`&&`, `||`, `==`, `?`, `:`, `!`,
 * `+`, `-`, `*`, etc.). After an identifier / closing bracket / digit,
 * `.` is property access, NOT a placeholder.
 */
function isPlaceholderDotAt(arg, dotIdx) {
  let j = dotIdx - 1;
  while (j >= 0 && /\s/.test(arg[j])) j--;
  if (j < 0) return true; // beginning of arg
  const prev = arg[j];
  if (
    prev === "(" ||
    prev === "[" ||
    prev === "{" ||
    prev === "," ||
    prev === "?" ||
    prev === ":" ||
    prev === "!" ||
    prev === "+" ||
    prev === "-" ||
    prev === "*" ||
    prev === "/" ||
    prev === "%" ||
    prev === "=" ||
    prev === "<" ||
    prev === ">" ||
    prev === "&" ||
    prev === "|" ||
    prev === "^" ||
    prev === "~"
  )
    return true;
  return false;
}

/** Walk arg text, prepending `__x` to every top-level placeholder `.`.
 *  Nested calls aren't recursed here: the outer pass handles them. */
function bindPlaceholders(arg, name = "__x") {
  const out = [];
  let i = 0;
  let prev = "";
  const len = arg.length;
  while (i < len) {
    const c = arg[i];
    if (c === "'" || c === '"') {
      const end = skipString(arg, i, c);
      out.push(arg.slice(i, end));
      i = end;
      prev = c;
      continue;
    }
    if (c === "`") {
      const end = skipTemplate(arg, i);
      out.push(arg.slice(i, end));
      i = end;
      prev = "`";
      continue;
    }
    if (c === "/" && arg[i + 1] !== "/" && arg[i + 1] !== "*" && isRegexCtx(prev)) {
      const end = skipRegex(arg, i);
      out.push(arg.slice(i, end));
      i = end;
      prev = "/";
      continue;
    }
    if (c === "/" && arg[i + 1] === "/") {
      const nl = arg.indexOf("\n", i);
      const end = nl === -1 ? len : nl;
      out.push(arg.slice(i, end));
      i = end;
      continue;
    }
    if (c === "/" && arg[i + 1] === "*") {
      const end = arg.indexOf("*/", i + 2);
      const stop = end === -1 ? len : end + 2;
      out.push(arg.slice(i, stop));
      i = stop;
      continue;
    }
    // Skip over nested bracket groups verbatim: those are
    // sub-expressions that have their own placeholder scope handled
    // by the outer call-pass when this fn is invoked recursively.
    if (c === "(" || c === "[" || c === "{") {
      const closeChar = c === "(" ? ")" : c === "[" ? "]" : "}";
      const end = skipBalanced(arg, i + 1, closeChar);
      out.push(arg.slice(i, end));
      i = end;
      prev = closeChar;
      continue;
    }
    // Placeholder dot detection. Must be followed by an identifier
    // to be a chain start; a `.0` is a decimal literal.
    if (c === "." && /[A-Za-z_$]/.test(_nullishCoalesce(arg[i + 1], () => "")) && isPlaceholderDotAt(arg, i)) {
      out.push(name + ".");
      i++;
      prev = ".";
      continue;
    }
    out.push(c);
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join("");
}

/**
 * Top-level driver. Scans `src` for call-arg-open `(`, splits args on
 * top-level commas, and lowers any arg whose first non-whitespace
 * character is a placeholder-dot. Recurses into the lowered arg so
 * nested calls work too.
 */
export function lowerLeadingDot(src, opts) {
  // Placeholder-lambda parameter name. Default `__x` is hygienic; the
  // `readable` option uses `it` for display contexts (the fused
  // tooltip), matching @lyku/fuse's readable temp names.
  const name = opts?.readable ? "it" : "__x";
  const out = [];
  const len = src.length;
  let i = 0;
  let lastSig = ""; // last non-whitespace char emitted

  while (i < len) {
    const c = src[i];
    // Pass through strings / templates / comments verbatim.
    if (c === "'" || c === '"') {
      const end = skipString(src, i, c);
      out.push(src.slice(i, end));
      i = end;
      lastSig = _nullishCoalesce(src[end - 1], () => "");
      continue;
    }
    if (c === "`") {
      const end = skipTemplate(src, i);
      out.push(src.slice(i, end));
      i = end;
      lastSig = "`";
      continue;
    }
    // Regex literal in expression position: emit verbatim. Must precede the
    // comment checks so `\//` (escaped slash + close) isn't read as `//`.
    if (c === "/" && src[i + 1] !== "/" && src[i + 1] !== "*" && isRegexCtx(lastSig)) {
      const end = skipRegex(src, i);
      out.push(src.slice(i, end));
      i = end;
      lastSig = "/";
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      const end = nl === -1 ? len : nl;
      out.push(src.slice(i, end));
      i = end;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? len : end + 2;
      out.push(src.slice(i, stop));
      i = stop;
      continue;
    }

    // CALL-OPEN: `(` preceded by an identifier, `)`, or `]` (or after
    // a property access: `foo.bar(`). Anything else (`(` after an
    // operator) is a paren-group, not a call; we leave those alone.
    if (c === "(" && /[\w$)\].]/.test(lastSig)) {
      const argsStart = i + 1;
      const argsEnd = skipBalanced(src, argsStart, ")") - 1; // index of `)`
      const argsText = src.slice(argsStart, argsEnd);
      // Split on top-level commas. Comments and regex literals must pass
      // through whole here, exactly as in the outer scan: an apostrophe
      // inside `// can't` would otherwise open a phantom string that
      // swallows real code (and its brackets) up to the next apostrophe,
      // desyncing `depth` for everything after.
      const parts = [];
      let buf = "";
      let depth = 0;
      let p = 0;
      let prevSig = "";
      while (p < argsText.length) {
        const ch = argsText[p];
        if (ch === "'" || ch === '"') {
          const end = skipString(argsText, p, ch);
          buf += argsText.slice(p, end);
          p = end;
          prevSig = ch;
          continue;
        }
        if (ch === "`") {
          const end = skipTemplate(argsText, p);
          buf += argsText.slice(p, end);
          p = end;
          prevSig = "`";
          continue;
        }
        if (ch === "/" && argsText[p + 1] !== "/" && argsText[p + 1] !== "*" && isRegexCtx(prevSig)) {
          const end = skipRegex(argsText, p);
          buf += argsText.slice(p, end);
          p = end;
          prevSig = "/";
          continue;
        }
        if (ch === "/" && argsText[p + 1] === "/") {
          const nl = argsText.indexOf("\n", p);
          const end = nl === -1 ? argsText.length : nl;
          buf += argsText.slice(p, end);
          p = end;
          continue;
        }
        if (ch === "/" && argsText[p + 1] === "*") {
          const close = argsText.indexOf("*/", p + 2);
          const end = close === -1 ? argsText.length : close + 2;
          buf += argsText.slice(p, end);
          p = end;
          continue;
        }
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") depth--;
        if (ch === "," && depth === 0) {
          parts.push(buf);
          buf = "";
          p++;
          prevSig = ",";
          continue;
        }
        buf += ch;
        if (!/\s/.test(ch)) prevSig = ch;
        p++;
      }
      if (buf.length > 0) parts.push(buf);

      // For each arg: check if its first non-whitespace char is `.`
      // followed by an identifier. If yes, recurse into the arg
      // (handles inner calls' placeholders), then bind placeholders
      // at this arg's scope, then wrap in `(__x) => …`.
      const loweredParts = parts.map(arg => {
        const stripped = arg.replace(/^[\s\n]+/, "");
        const leadIdx = arg.length - stripped.length;
        const isPlaceholder = stripped[0] === "." && /[A-Za-z_$]/.test(_nullishCoalesce(stripped[1], () => ""));
        // Always recurse first so nested calls' args get processed.
        const recursedArg = lowerLeadingDot(arg, opts);
        if (!isPlaceholder) return recursedArg;
        // `recursedArg` may have a different prefix length after
        // recursion shifts things; re-trim.
        const recursedStripped = recursedArg.replace(/^[\s\n]+/, "");
        const lead = recursedArg.slice(0, recursedArg.length - recursedStripped.length);
        const bound = bindPlaceholders("." + recursedStripped.slice(1), name);
        return `${lead}(${name}) => ${bound.replace(/^\./, name + ".")}`;
      });
      out.push("(");
      out.push(loweredParts.join(","));
      out.push(")");
      i = argsEnd + 1;
      lastSig = ")";
      continue;
    }

    out.push(c);
    if (!/\s/.test(c)) lastSig = c;
    i++;
  }
  return out.join("");
}

/**
 * Svelte preprocess wrapper. Runs the lowering on `.pui` script blocks
 * BEFORE parabunPreprocess sees the source, so Bun.Transpiler / Svelte
 * parse plain JS.
 */
export default function lowerLeadingDotPreprocess() {
  return {
    name: "lower-leading-dot",
    script({ content, filename }) {
      if (!_optionalChain([filename, "optionalAccess", _ => _.endsWith, "call", _2 => _2(".pui")])) return;
      // Quick reject: no `.<ident>` immediately after `(` or `,` ?
      if (!/[(,]\s*\.[A-Za-z_$]/.test(content)) return;
      const out = lowerLeadingDot(content);
      if (out === content) return;
      return { code: out };
    },
  };
}
