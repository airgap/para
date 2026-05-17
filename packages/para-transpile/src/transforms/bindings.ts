// Reactive binding operators:
//
//   A ~> B    →  require("@lyku/para-signals").effect(() => { B = A; })
//   A -> fn   →  require("@lyku/para-signals").effect(() => { fn(A); })
//
// `~>` is an assignment binding — B is the sink, A is the source. Both
// can be arbitrary expressions. The desugar wraps the assignment in an
// effect so any signal reads inside A are tracked and the binding re-fires
// on dep change.
//
// `->` is a call binding — fn is invoked with A as the argument. fn must
// be a callable target (identifier, property access, or index access);
// arrow functions and bare calls are rejected by the canonical Zig parser.
// We don't enforce that here — the JS runtime will throw if fn isn't
// callable, which surfaces the error at first dep change.
//
// Both operators bind at "assign" precedence (looser than ||, &&, etc.,
// tighter than the comma operator). To find the LHS / RHS bounds, we
// walk through balanced parens and stop at statement-level delimiters
// (`;`, top-level `,`, `)`, `]`, `}`, EOL).

import { scanRegions } from "../lex";

export function transformBindings(src: string): string {
  // Operate on the full source — LHS / RHS can span template literals,
  // and per-region scanning would treat those as opaque (e.g.
  // `\`count=${count}\` -> writer` would split at the backticks and
  // give the binding an empty LHS). Spans are still used to (a) reject
  // operator matches inside strings/comments and (b) skip non-code
  // regions during scanning without counting their interior braces.
  let out = src;
  out = transformOp(out, "~>", (lhs, rhs) => `require("@lyku/para-signals").effect(() => { ${rhs} = ${lhs}; })`);
  out = transformOp(out, "->", (lhs, rhs) => `require("@lyku/para-signals").effect(() => { ${rhs}(${lhs}); })`);
  return out;
}

function transformOp(src: string, op: string, wrap: (lhs: string, rhs: string) => string): string {
  if (!src.includes(op)) return src;
  const spans = scanRegions(src);
  const findSpan = (pos: number) => spans.find(s => pos >= s.start && pos < s.end);
  const inCode = (pos: number) => findSpan(pos)?.region === "code";

  let out = "";
  let i = 0;
  while (i < src.length) {
    const opPos = findNextTopLevelOp(src, i, op, inCode, findSpan);
    if (opPos === -1) {
      out += src.slice(i);
      return out;
    }
    const lhsStart = scanBindLhsStart(src, opPos, inCode, findSpan);
    const rhsEnd = scanBindRhsEnd(src, opPos + op.length, inCode, findSpan);
    out += src.slice(i, lhsStart);
    const lhs = src.slice(lhsStart, opPos).trim();
    const rhs = src.slice(opPos + op.length, rhsEnd).trim();
    out += wrap(lhs, rhs);
    i = rhsEnd;
  }
  return out;
}

type SpanLookup = (pos: number) => { start: number; end: number; region: string } | undefined;

function findNextTopLevelOp(
  src: string,
  from: number,
  op: string,
  inCode: (pos: number) => boolean,
  findSpan: SpanLookup,
): number {
  let depth = 0;
  let i = from;
  while (i < src.length) {
    if (!inCode(i)) {
      const span = findSpan(i);
      i = span ? span.end : i + 1;
      continue;
    }
    const c = src[i]!;
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      i++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      depth--;
      i++;
      continue;
    }
    if (depth === 0 && src.startsWith(op, i)) {
      // Disambiguate `->` from `=>` / `<-` / `--`. `~>` from `~~`/`>=`.
      const prev = src[i - 1] ?? "";
      const next = src[i + op.length] ?? "";
      if (op === "->" && (prev === "-" || prev === "=" || prev === "<")) {
        i++;
        continue;
      }
      if (op === "~>" && prev === "~") {
        i++;
        continue;
      }
      if (next === ">" || next === "=") {
        i++;
        continue;
      }
      return i;
    }
    i++;
  }
  return -1;
}

function scanBindLhsStart(src: string, opPos: number, inCode: (pos: number) => boolean, findSpan: SpanLookup): number {
  let depth = 0;
  let i = opPos - 1;
  // Skip whitespace immediately before the op (only spaces/tabs — newline
  // is a statement boundary so the LHS would already end there).
  while (i >= 0 && /[ \t]/.test(src[i]!)) i--;
  while (i >= 0) {
    if (!inCode(i)) {
      // Inside a string / template / comment / regex. Skip to its start.
      const span = findSpan(i);
      if (!span) return 0;
      i = span.start - 1;
      continue;
    }
    const c = src[i]!;
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
      if (c === ";" || c === "\n" || c === ",") return i + 1;
      if (c === "=") {
        const left = src[i - 1] ?? "";
        const right = src[i + 1] ?? "";
        if (right === ">") {
          let j = i + 2;
          while (j < src.length && /\s/.test(src[j]!)) j++;
          return j;
        }
        if (/[!<>+\-*/%&|^?.=]/.test(left) || right === "=") {
          i--;
          continue;
        }
        return i + 1;
      }
      if (c === "n" && src.slice(Math.max(0, i - 5), i + 1) === "return") {
        let j = i + 1;
        while (j < src.length && /\s/.test(src[j]!)) j++;
        return j;
      }
    }
    i--;
  }
  return 0;
}

function scanBindRhsEnd(src: string, startPos: number, inCode: (pos: number) => boolean, findSpan: SpanLookup): number {
  let depth = 0;
  let i = startPos;
  while (i < src.length) {
    if (!inCode(i)) {
      const span = findSpan(i);
      i = span ? span.end : i + 1;
      continue;
    }
    const c = src[i]!;
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
    }
    i++;
  }
  return src.length;
}
