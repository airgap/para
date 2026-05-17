// Block-form Para constructs:
//
//   signal NAME = EXPR;             → const NAME = require("@lyku/para-signals").signal(EXPR);
//   derived NAME = EXPR;            → const NAME = require("@lyku/para-signals").derived(() => EXPR);
//   effect { BODY }                 → require("@lyku/para-signals").effect(() => { BODY });
//   arena  { BODY }                 → require("@lyku/para-arena").scope(() => { BODY });
//   when EXPR { BODY }              → require("@lyku/para-signals").when(() => EXPR, () => { BODY });
//   when not EXPR { BODY }          → require("@lyku/para-signals").when(() => !(EXPR), () => { BODY });
//
// Bare-read sugar (rewriting `count` to `count.get()` inside tracked
// contexts) is NOT applied here — it requires real scope analysis and
// lands in v0.2. Until then user code must call `.get()` / `.set()`
// explicitly. Auto-promotion of `signal x = EXPR` to `derived(...)` when
// EXPR reads other signals is also v0.2-territory.
//
// All block parsers walk through the source brace-aware, using lex.ts's
// findMatchingBrace so braces inside strings/comments/regex don't confuse
// the matcher.

import { findMatchingBrace, scanRegions } from "../lex";

export function transformBlocks(src: string): string {
  let out = src;
  out = transformSignalDecls(out);
  out = transformDerivedDecls(out);
  out = transformEffectBlocks(out);
  out = transformArenaBlocks(out);
  out = transformWhenBlocks(out);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// signal NAME = EXPR;
// ─────────────────────────────────────────────────────────────────────────

function transformSignalDecls(src: string): string {
  // Scan on the FULL source (not per code region) because a single
  // `signal x = …` initializer can contain string literals — splitting
  // by region first breaks the brace-depth scan halfway through. Instead
  // we use the spans only to (a) skip matches whose `signal` keyword is
  // inside a string/comment, and (b) advance over non-code regions during
  // the forward scan without counting their braces.
  const spans = scanRegions(src);
  const findSpan = (pos: number) => spans.find(s => pos >= s.start && pos < s.end);
  const inCode = (pos: number) => findSpan(pos)?.region === "code";

  const re = /(^|[;\n{}])(\s*)signal\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+?)?\s*=\s*/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const matchStart = m.index + m[1]!.length + m[2]!.length;
    if (!inCode(matchStart)) continue;
    const matchEnd = re.lastIndex;
    const name = m[3]!;
    // Forward-scan through full source with paren tracking. String /
    // comment regions are skipped wholesale (their interior doesn't
    // contribute to brace depth).
    let depth = 0;
    let i = matchEnd;
    while (i < src.length) {
      if (!inCode(i)) {
        const span = findSpan(i);
        i = span ? span.end : i + 1;
        continue;
      }
      const c = src[i]!;
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (depth === 0 && (c === ";" || c === "\n")) break;
      i++;
    }
    const initializer = src.slice(matchEnd, i).trim();
    out += src.slice(last, matchStart);
    out += `const ${name} = require("@lyku/para-signals").signal(${initializer})`;
    last = i; // the trailing `;` / `\n` is appended on the next iter or final tail
    re.lastIndex = i;
  }
  out += src.slice(last);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// derived NAME = EXPR;
//
// Mirrors `signal NAME = EXPR` exactly, but always wraps the RHS in an
// arrow and routes through `derived(() => EXPR)` instead of `signal(EXPR)`.
// Bare-read rewriting of signal references inside EXPR is handled by the
// existing bare-read pass — it walks `signals.derived(...)` initializers
// the same as `signals.signal(...)` ones.
//
// If EXPR doesn't read any signals, the result is a derived that never
// re-fires. Mirroring how `signal NAME = LITERAL` doesn't error, we don't
// error here either — the user is explicit about wanting a derived.
// ─────────────────────────────────────────────────────────────────────────

// End (exclusive) of a `derived NAME =` initializer expression. Mirrors
// the canonical Zig parser: a full JS expression that may span newlines
// (ternary / binary / member-chain wrap). Terminates at the depth-0 `;`,
// an ASI newline (expression complete AND next line not a continuation),
// a depth-0 `}` (enclosing block close), or EOF. Skips string / template
// / comment / regex spans so a `;` or newline inside one doesn't end it.
// MUST stay byte-identical to the copy in @lyku/para-preprocess
// (index.ts) — the two are parity mirrors of the same parser.
function derivedInitEnd(src: string, start: number): number {
  const contPrev = (c: string) => c !== "" && "+-*/%&|^<>=!~?:.,([{".includes(c);
  const contNext = (c: string) => c !== "" && "?:.,)]}+-*/%&|^<>=!([".includes(c);
  let i = start;
  let depth = 0;
  let lastSig = "";
  while (i < src.length) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < src.length) {
        const d = src[i]!;
        if (d === "\\") {
          i += 2;
          continue;
        }
        if (q === "`" && d === "$" && src[i + 1] === "{") {
          let td = 1;
          i += 2;
          while (i < src.length && td > 0) {
            const e = src[i]!;
            if (e === "{") td++;
            else if (e === "}") td--;
            i++;
          }
          continue;
        }
        if (d === q) {
          i++;
          break;
        }
        i++;
      }
      lastSig = q;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "/" && (lastSig === "" || contPrev(lastSig))) {
      i++;
      while (i < src.length) {
        const d = src[i]!;
        if (d === "\\") {
          i += 2;
          continue;
        }
        if (d === "[") {
          i++;
          while (i < src.length && src[i] !== "]") {
            if (src[i] === "\\") i++;
            i++;
          }
          continue;
        }
        if (d === "/" || d === "\n") {
          if (d === "/") i++;
          break;
        }
        i++;
      }
      lastSig = "/";
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      lastSig = c;
      i++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth--;
      lastSig = c;
      i++;
      continue;
    }
    if (depth === 0 && c === ";") break;
    if (depth === 0 && c === "\n") {
      let j = i + 1;
      while (j < src.length) {
        const e = src[j]!;
        if (e === " " || e === "\t" || e === "\r" || e === "\n") {
          j++;
          continue;
        }
        if (e === "/" && src[j + 1] === "/") {
          while (j < src.length && src[j] !== "\n") j++;
          continue;
        }
        if (e === "/" && src[j + 1] === "*") {
          j += 2;
          while (j < src.length && !(src[j] === "*" && src[j + 1] === "/")) j++;
          j += 2;
          continue;
        }
        break;
      }
      if (contPrev(lastSig) || contNext(src[j] ?? "")) {
        i++;
        continue;
      }
      break;
    }
    if (c !== " " && c !== "\t" && c !== "\r" && c !== "\n") lastSig = c;
    i++;
  }
  return i;
}

function transformDerivedDecls(src: string): string {
  const spans = scanRegions(src);
  const findSpan = (pos: number) => spans.find(s => pos >= s.start && pos < s.end);
  const inCode = (pos: number) => findSpan(pos)?.region === "code";

  const re = /(^|[;\n{}])(\s*)derived\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+?)?\s*=\s*/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const matchStart = m.index + m[1]!.length + m[2]!.length;
    if (!inCode(matchStart)) continue;
    const matchEnd = re.lastIndex;
    const name = m[3]!;
    const i = derivedInitEnd(src, matchEnd);
    const initializer = src.slice(matchEnd, i).trim();
    out += src.slice(last, matchStart);
    out += `const ${name} = require("@lyku/para-signals").derived(() => ${initializer})`;
    last = i;
    re.lastIndex = i;
  }
  out += src.slice(last);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// effect { BODY } and arena { BODY } — both are keyword + block,
// shared shape.
// ─────────────────────────────────────────────────────────────────────────

// `effect EXPR;` → `require("@lyku/para-signals").effect(() => EXPR)` — an
// EXPRESSION-bodied arrow, NOT a block. This preserves the implicit
// return so an effect whose expression yields a teardown
// (`effect useKeybind(...)`) registers it as the effect's cleanup, just
// like `$effect(() => EXPR)`. Mirrors the `derived NAME = EXPR` →
// `derived(() => EXPR)` precedent; the block form `effect { … }` stays
// statement-bodied (explicit `return cleanup`). Disambiguation matches
// the parser: `effect` is the keyword only at statement position, same
// line, followed by an identifier — `effect(` `effect.` `effect[`
// `effect=` `effect;` and labels keep `effect` as a plain identifier
// (lookahead requires [A-Za-z_$]). The scanner (derivedInitEnd) MUST
// stay byte-identical to the copy in @lyku/para-preprocess (index.ts);
// only the emitted wrapper differs ($effect there).
function expandEffectSingle(src: string): string {
  const re = /(^|[;\n{}])([ \t]*)effect[ \t]+(?=[A-Za-z_$])/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const kwStart = m.index + m[1]!.length;
    const bodyStart = re.lastIndex;
    const end = derivedInitEnd(src, bodyStart);
    const body = src.slice(bodyStart, end).trim();
    out += src.slice(last, kwStart);
    out += `${m[2]}require("@lyku/para-signals").effect(() => ${body})`;
    last = src[end] === ";" ? end + 1 : end;
    re.lastIndex = last;
  }
  out += src.slice(last);
  return out;
}

function transformEffectBlocks(src: string): string {
  return rewriteKeywordBlocks(
    expandEffectSingle(src),
    "effect",
    body => `require("@lyku/para-signals").effect(() => {${body}})`,
  );
}

function transformArenaBlocks(src: string): string {
  return rewriteKeywordBlocks(src, "arena", body => `require("@lyku/para-arena").scope(() => {${body}})`);
}

function rewriteKeywordBlocks(src: string, keyword: string, wrap: (body: string) => string): string {
  // Find `keyword` at statement-start position, immediately followed by `{`
  // (whitespace allowed). Replace `keyword { … }` with the wrapped form.
  // The `{` is matched via findMatchingBrace which is string-aware.
  const re = new RegExp(`(^|[;\\n{}])(\\s*)${keyword}(\\s*)\\{`, "g");
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const blockStart = m.index + m[1]!.length + m[2]!.length;
    // Position of the `{` is m.index + (full match length) - 1
    const openBrace = re.lastIndex - 1;
    const closeBrace = findMatchingBrace(src, openBrace);
    if (closeBrace === -1) continue; // unmatched — leave source alone
    const body = src.slice(openBrace + 1, closeBrace);
    out += src.slice(last, blockStart);
    out += wrap(body);
    last = closeBrace + 1;
    re.lastIndex = last;
  }
  out += src.slice(last);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// when EXPR { BODY }      →  signals.when(() => EXPR, () => { BODY })
// when not EXPR { BODY }  →  signals.when(() => !(EXPR), () => { BODY })
// ─────────────────────────────────────────────────────────────────────────

function transformWhenBlocks(src: string): string {
  // Walk the source statement-by-statement at top-level, finding `when`
  // tokens and identifying the form. We can't use a simple regex because
  // the predicate can contain operators / property accesses / etc.
  let out = "";
  let i = 0;
  while (i < src.length) {
    // Look for the next `when` keyword at a statement boundary.
    const wp = findNextWhenStart(src, i);
    if (wp === -1) {
      out += src.slice(i);
      return out;
    }
    out += src.slice(i, wp.start);
    // Parse predicate + body.
    const result = parseWhenStatement(src, wp.kwPos);
    if (!result) {
      // Couldn't parse — emit the keyword unchanged and continue.
      out += src.slice(wp.kwPos, wp.kwPos + 4);
      i = wp.kwPos + 4;
      continue;
    }
    out += emitWhenCall(result.rawPredicate, result.body, result.negated);
    i = result.end;
  }
  return out;
}

function findNextWhenStart(src: string, from: number): { start: number; kwPos: number } | -1 {
  // Walk forward through code regions looking for `\bwhen\b` followed by
  // something that can start a predicate (`not`, an identifier, `!`, `(`,
  // a digit). For each candidate, verify the prior non-whitespace char is
  // a statement boundary (`;` `{` `}` `\n`-equivalent or start-of-input).
  // The whitespace-walking-back step is what lets two consecutive when
  // blocks find each other across only whitespace between them.
  const spans = scanRegions(src);
  let pos = from;
  while (pos < src.length) {
    const span = spans.find(s => pos >= s.start && pos < s.end);
    if (!span) return -1;
    if (span.region !== "code") {
      pos = span.end;
      continue;
    }
    const code = src.slice(span.start, span.end);
    const startInChunk = pos - span.start;
    const re = /\bwhen(?=\s+(?:not\s+)?[A-Za-z_$!(\d])/g;
    re.lastIndex = startInChunk;
    const m = re.exec(code);
    if (!m) {
      pos = span.end;
      continue;
    }
    const whenPos = span.start + m.index;
    // Validate: prior non-whitespace char is a statement boundary.
    let prev = whenPos - 1;
    while (prev >= 0 && /[ \t]/.test(src[prev]!)) prev--;
    const prevChar = prev < 0 ? "" : src[prev]!;
    if (prev < 0 || prevChar === ";" || prevChar === "{" || prevChar === "}" || prevChar === "\n") {
      return { start: prev + 1, kwPos: whenPos };
    }
    // Not at a boundary — `when` is mid-expression (or part of a longer
    // identifier the `\b` happened to allow through). Skip past it.
    pos = whenPos + 4;
  }
  return -1;
}

type WhenParse = {
  rawPredicate: string;
  predicate: string;
  body: string;
  negated: boolean;
  end: number; // position after the closing `}`
};

function parseWhenStatement(src: string, kwPos: number): WhenParse | null {
  // kwPos points at the `w` of `when`. Move past `when` + whitespace.
  let i = kwPos + 4;
  while (i < src.length && /\s/.test(src[i]!)) i++;
  // Optional `not`.
  let negated = false;
  if (src.startsWith("not", i) && /\s/.test(src[i + 3] ?? "")) {
    negated = true;
    i += 3;
    while (i < src.length && /\s/.test(src[i]!)) i++;
  }
  // Predicate ends at the next top-level `{`. Track paren depth so a `{`
  // inside the predicate (object literal, etc.) doesn't terminate it.
  let depth = 0;
  const predStart = i;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth === 0 && c === "{") break;
    i++;
  }
  if (i >= src.length) return null;
  const rawPredicate = src.slice(predStart, i).trim();
  const predicate = negated ? `!(${rawPredicate})` : rawPredicate;
  // Body via brace-match.
  const openBrace = i;
  const closeBrace = findMatchingBrace(src, openBrace);
  if (closeBrace === -1) return null;
  const body = src.slice(openBrace + 1, closeBrace);
  return { rawPredicate, predicate, body, negated, end: closeBrace + 1 };
}

function emitWhenCall(rawPredicate: string, body: string, negate: boolean): string {
  const predicate = negate ? `!(${rawPredicate})` : rawPredicate;
  return `require("@lyku/para-signals").when(() => ${predicate}, () => {${body}})`;
}
