// `x |> f`        → f(x)
// `x |> f |> g`   → g(f(x))   (left-associative threading)
// `x |> f(y)`     → f(y)(x)   (function-target form: result of f(y) is called)
// `x |> .method()`→ x.method()  (method-shorthand: leading dot binds receiver)
// `x |> f(_, y)`  → f(x, y)   (placeholder: `_` substitutes the LHS)
//
// Scanner-based, not regex — pipeline expressions span balanced parens
// (`x |> f(_, y)`) and chain through other `|>` operators, both of which
// regex with depth-blind lookaheads gets wrong. We walk the code with a
// brace-tracking pass to find the START and END of each pipeline
// expression (delimited by `=` / `,` / `(` / `[` / `{` / `;` / `return`
// / `=>` on the left and `;` / depth-0 `,` / `)` / `]` / `}` / EOL on
// the right), then split on top-level `|>` and reduce.
//
// LYK-914: pipelines inside `{ }` STATEMENT blocks (function / arrow /
// control / desugared effect|mount bodies) are real and must lower. We
// recurse into statement-block braces. Object / expression braces are
// left alone (their `:`-bound property values would mis-scan an LHS — a
// separate, rarer concern), exactly as before — no regression there.
//
// String / comment / regex handling: we can't use `rewriteCodeRegions`
// (it chunks the source AT non-code spans, so a block containing a
// string is split and brace-matching breaks). Instead we mask non-code
// spans to same-length blanks and scan over THAT, while emitting slices
// from the real source — brace/`|>` tokens inside strings are
// neutralised, positions stay aligned.

import { scanRegions } from "../lex";

/** Sentinel a masked literal char becomes. Deliberately NOT a space:
 *  a string/template/regex literal is an opaque *operand token*, not
 *  whitespace. Filling with spaces made `scanLhsStart`'s `\s`-skip and
 *  `collapse`'s leading/trailing-ws trim swallow a literal LHS
 *  (`"hello" |> .toUpperCase()` → the `"hello"` was eaten as ws). A
 *  non-`\s`, non-structural char makes every ws-based scanner stop at
 *  the literal boundary while brace/`|>` scanners (which match specific
 *  chars) stay inert. Newlines are preserved (real statement
 *  terminators + offset/line structure). \x00 never appears in JS
 *  source, so it can't collide with real code. */
const MASK = "\x00";

/** Same-length copy of `src` with string/comment/regex spans masked to
 *  {@link MASK} (newlines kept, so length + line structure + offsets are
 *  preserved). Brace / `|>` tokens inside literals become inert; the
 *  literal as a whole reads as one opaque non-ws token. */
function maskNonCode(src: string): string {
  const spans = scanRegions(src);
  let out = "";
  for (const s of spans) {
    const chunk = src.slice(s.start, s.end);
    if (s.region === "code") out += chunk;
    else out += chunk.replace(/[^\n]/g, MASK);
  }
  return out;
}

export function transformPipeline(src: string): string {
  if (!src.includes("|>")) return src;
  const scan = maskNonCode(src);
  return collapse(src, scan, 0, src.length);
}

/**
 * Process `[lo, hi)` of the source. `real` is the original text (emitted
 * verbatim / sliced for operands); `scan` is the masked copy (all
 * structural decisions index this). Recurses into statement-block braces.
 */
function collapse(real: string, scan: string, lo: number, hi: number): string {
  let out = "";
  let i = lo;
  while (i < hi) {
    const ev = nextEvent(scan, i, hi, lo);
    if (ev === null) {
      out += real.slice(i, hi);
      return out;
    }
    if (ev.kind === "block") {
      const close = matchBrace(scan, ev.pos, hi);
      // Emit up to and including `{`, recurse the body, emit `}`.
      out += real.slice(i, ev.pos + 1);
      out += collapse(real, scan, ev.pos + 1, close);
      out += real.slice(close, close + 1); // the `}` (or hi sentinel)
      i = close + 1;
      continue;
    }
    // ev.kind === "pipe"
    const start = scanLhsStart(scan, ev.pos, lo);
    const end = scanRhsEnd(scan, ev.pos + 2, hi);
    out += real.slice(i, start);
    const realExpr = real.slice(start, end);
    const scanExpr = scan.slice(start, end);
    const leadingWs = scanExpr.match(/^\s*/)![0];
    const trailingWs = scanExpr.match(/\s*$/)![0];
    out +=
      leadingWs +
      collapsePipelineChain(realExpr.slice(leadingWs.length, realExpr.length - trailingWs.length), scanExpr.trim()) +
      trailingWs;
    i = end;
  }
  return out;
}

type Event = { kind: "pipe" | "block"; pos: number };

/**
 * Next thing of interest at the current bracket level: a top-level `|>`,
 * or the `{` of a statement block (to recurse). `(`/`[` raise depth and
 * suppress pipes (operand grouping — unchanged behaviour). A `{` at
 * paren/bracket depth 0 is either a statement block (→ recurse) or an
 * object/expression literal (→ skip its whole extent, leaving any inner
 * `|>` alone, as before). Braces nested inside `(`/`[` are skipped too.
 */
function nextEvent(scan: string, from: number, hi: number, lo: number): Event | null {
  let depth = 0; // ( and [ only
  for (let i = from; i < hi; i++) {
    const c = scan[i]!;
    if (c === "(" || c === "[") {
      depth++;
      continue;
    }
    if (c === ")" || c === "]") {
      depth--;
      continue;
    }
    if (c === "{") {
      // A statement block (arrow/function/control body) must be recursed
      // REGARDLESS of paren depth — `map(x => { … })`, `effect(() => { …
      // })` (transformBlocks already lowered `effect { }` to that form)
      // put the body brace inside call parens. Object/expression braces
      // are skipped wholesale (their inner `|>` is left alone — separate
      // concern, no regression).
      if (isStatementBlock(scan, i, lo)) return { kind: "block", pos: i };
      i = matchBrace(scan, i, hi);
      continue;
    }
    if (c === "}") continue; // stray (shouldn't happen at this level)
    if (depth === 0 && c === "|" && scan[i + 1] === ">") return { kind: "pipe", pos: i };
  }
  return null;
}

/** Index of the `}` matching the `{` at openPos (scan is brace-balanced
 *  since literals are masked). Clamped to hi-1 if unbalanced. */
function matchBrace(scan: string, openPos: number, hi: number): number {
  let depth = 0;
  for (let i = openPos; i < hi; i++) {
    const c = scan[i]!;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return hi - 1;
}

/**
 * Is the `{` at `bracePos` a statement block (function / arrow / control
 * body, bare block) rather than an object/expression literal? Decided by
 * the preceding significant char in `scan`:
 *   • `)` `}` `;` `{` or region start → block
 *   • `=>` (arrow body)               → block
 *   • `else` / `do` / `try` / `finally` keyword → block
 *   • anything else (`=` `(` `,` `:` `[` `return` `?` operators …) → expr
 */
function isStatementBlock(scan: string, bracePos: number, lo: number): boolean {
  let i = bracePos - 1;
  while (i >= lo && /\s/.test(scan[i]!)) i--;
  if (i < lo) return true; // start of the (sub)region → statement position
  const c = scan[i]!;
  if (c === ")" || c === "}" || c === ";" || c === "{") return true;
  if (c === ">" && scan[i - 1] === "=") return true; // `=>` arrow body
  // keyword forms: …else { …do { …try { …finally {
  const wordEnd = i + 1;
  let j = i;
  while (j >= lo && /[A-Za-z]/.test(scan[j]!)) j--;
  const word = scan.slice(j + 1, wordEnd);
  if (word === "else" || word === "do" || word === "try" || word === "finally") return true;
  return false;
}

/**
 * Walk backward from `pipePos` through balanced parens to the start of the
 * pipeline expression. Stops at the first depth-0 delimiter, floored at
 * `lo` (the start of the region we're allowed to touch).
 */
function scanLhsStart(scan: string, pipePos: number, lo: number): number {
  let depth = 0;
  let i = pipePos - 1;
  while (i >= lo && /\s/.test(scan[i]!)) i--;
  while (i >= lo) {
    const c = scan[i]!;
    if (c === ")" || c === "]" || c === "}") {
      depth++;
      i--;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      if (depth === 0) return i + 1;
      depth--;
      i--;
      continue;
    }
    if (depth === 0) {
      if (c === "," || c === ";" || c === "\n") return i + 1;
      const left = scan[i - 1] ?? "";
      const right = scan[i + 1] ?? "";
      if (c === "=") {
        if (right === ">") {
          let k = i + 2;
          while (k < scan.length && /\s/.test(scan[k]!)) k++;
          return k;
        }
        if (/[!<>+\-*/%&|^?.=]/.test(left) || right === "=") {
          i--;
          continue;
        }
        return i + 1;
      }
      if (c === "n" && scan.slice(Math.max(lo, i - 5), i + 1) === "return") {
        let k = i + 1;
        while (k < scan.length && /\s/.test(scan[k]!)) k++;
        return k;
      }
    }
    i--;
  }
  return lo;
}

/**
 * Walk forward from `startPos` through balanced parens to the end of the
 * pipeline expression (capped at `hi`). Skips chained `|>` so the whole
 * chain is one expression; ends before a looser-precedence `..!/..&/..>`.
 */
function scanRhsEnd(scan: string, startPos: number, hi: number): number {
  let depth = 0;
  let i = startPos;
  while (i < hi) {
    const c = scan[i]!;
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      i++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return i;
      depth--;
      i++;
      continue;
    }
    if (depth === 0) {
      if (c === ";" || c === "\n" || c === ",") return i;
      if (c === "." && scan[i + 1] === "." && (scan[i + 2] === "!" || scan[i + 2] === "&" || scan[i + 2] === ">")) {
        return i;
      }
    }
    i++;
  }
  return hi;
}

// ── chain reduction (operand text from `real`, splits from `scan`) ──────

function collapsePipelineChain(realExpr: string, scanExpr: string): string {
  const cuts = pipeCuts(scanExpr);
  if (cuts.length === 0) return realExpr;
  const parts: string[] = [];
  let s = 0;
  for (const c of cuts) {
    parts.push(realExpr.slice(s, c));
    s = c + 2;
  }
  parts.push(realExpr.slice(s));
  let result = parts[0]!.trim();
  for (let k = 1; k < parts.length; k++) result = applyStage(parts[k]!.trim(), result);
  return result;
}

/** Offsets of top-level `|>` within the (masked) expr. */
function pipeCuts(scanExpr: string): number[] {
  const cuts: number[] = [];
  let depth = 0;
  for (let i = 0; i < scanExpr.length; i++) {
    const c = scanExpr[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && c === "|" && scanExpr[i + 1] === ">") {
      cuts.push(i);
      i++;
    }
  }
  return cuts;
}

function applyStage(stage: string, lhs: string): string {
  if (stage.startsWith(".")) return `${lhs}${stage}`;
  const callMatch = matchCall(stage);
  if (callMatch) {
    const { fn, args } = callMatch;
    if (hasTopLevelPlaceholder(args)) return `${fn}(${substitutePlaceholder(args, lhs)})`;
    return `${stage}(${lhs})`;
  }
  return `${stage}(${lhs})`;
}

function matchCall(stage: string): { fn: string; args: string } | null {
  const open = stage.indexOf("(");
  if (open < 0) return null;
  if (stage[stage.length - 1] !== ")") return null;
  let depth = 0;
  for (let i = open; i < stage.length; i++) {
    const c = stage[i]!;
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) {
        if (i !== stage.length - 1) return null;
        return { fn: stage.slice(0, open), args: stage.slice(open + 1, i) };
      }
    }
  }
  return null;
}

function hasTopLevelPlaceholder(args: string): boolean {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && c === "_") {
      const before = args[i - 1] ?? "";
      const after = args[i + 1] ?? "";
      if (!/[\w$]/.test(before) && !/[\w$]/.test(after)) return true;
    }
  }
  return false;
}

function substitutePlaceholder(args: string, replacement: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i]!;
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      out += c;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      depth--;
      out += c;
      continue;
    }
    if (depth === 0 && c === "_") {
      const before = args[i - 1] ?? "";
      const after = args[i + 1] ?? "";
      if (!/[\w$]/.test(before) && !/[\w$]/.test(after)) {
        out += replacement;
        continue;
      }
    }
    out += c;
  }
  return out;
}
