// `EXPR ..! HANDLER` → `EXPR.catch(HANDLER)`
// `EXPR ..& CLEANUP` → `EXPR.finally(CLEANUP)`
// `EXPR ..> HANDLER` → `EXPR.then(HANDLER)`
//
// Left-associative: `p ..> f ..! a ..& b` becomes
// `p.then(f).catch(a).finally(b)`.
//
// Scanner-based, not regex — handlers can be bare arrow functions
// (`p ..> r => r.json()`) which themselves can contain parens, calls and
// other chain operators inside parens (`..! err => (recover() ..! fb)`).
// A regex with depth-blind lookaheads either cuts the handler short at
// the `)` of `() =>` or fails to keep paren-grouped inner chain ops
// nested. We walk the code region with a brace-tracking pass so the
// handler captures everything from after the operator to the next
// depth-0 chain op or expression terminator.

import { rewriteCodeRegions } from "../lex";

type Op = { method: "catch" | "finally" | "then"; len: number };

function chainOpAt(code: string, i: number): Op | null {
  if (code[i] !== "." || code[i + 1] !== ".") return null;
  const c = code[i + 2];
  if (c === "!") return { method: "catch", len: 3 };
  if (c === "&") return { method: "finally", len: 3 };
  if (c === ">") return { method: "then", len: 3 };
  return null;
}

export function transformErrorChain(src: string): string {
  return rewriteCodeRegions(src, code => {
    if (!code.includes("..")) return code;
    return rewriteChainsInCode(code);
  });
}

function rewriteChainsInCode(code: string): string {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const op = findNextTopLevelChainOp(code, i);
    if (op === null) {
      out += code.slice(i);
      return out;
    }
    const lhsStart = scanLhsStart(code, op.pos);
    // Emit everything before the LHS unchanged.
    out += code.slice(i, lhsStart);

    // Consume the WHOLE left-associative chain: LHS (..* handler)+
    // The chain ends when we hit a token that is NOT another chain op at
    // depth 0 — i.e. an expression terminator. We accumulate the LHS
    // into `acc` so each subsequent chain op chains onto the rewritten
    // result of the prior one.
    // Recurse into the LHS so an LHS that itself contains chain ops inside
    // parens (e.g. function-call argument that's a chain) gets rewritten.
    let acc = rewriteChainsInCode(code.slice(lhsStart, op.pos).trimEnd());
    let cursor = op.pos;
    while (true) {
      const here = chainOpAt(code, cursor);
      if (here === null) break;
      const handlerStart = cursor + here.len;
      const handlerEnd = scanHandlerEnd(code, handlerStart);
      // Recurse into the handler — handlers may contain parens whose
      // contents themselves include chain ops (`err => (recover() ..! fb)`).
      const handlerRaw = code.slice(handlerStart, handlerEnd).trim();
      const handler = rewriteHandler(handlerRaw, here.method);
      acc = `${acc}.${here.method}(${handler})`;
      cursor = handlerEnd;
      // Skip whitespace looking for another chain op at top level.
      while (cursor < code.length && /[ \t]/.test(code[cursor]!)) cursor++;
    }
    out += acc;
    i = cursor;
  }
  return out;
}

/**
 * Rewrite a single chain-op handler. For ..> and ..!, a leading `.` after
 * trimming is the leading-dot sugar — `..> .json()` becomes the arrow
 * `(__pcv) => __pcv.json()`. ..& deliberately doesn't get the sugar (a
 * `.finally` callback receives no value, so there's no implicit receiver
 * to bind), so a leading-dot handler under ..& is left as-is and will
 * surface as a runtime error / parse error downstream.
 *
 * The synthesized param name (`__pcv` — "para chain value") matches what
 * the canonical Zig parser emits, so parity-fixture comparisons stay
 * byte-equivalent.
 */
function rewriteHandler(raw: string, method: "catch" | "finally" | "then"): string {
  if ((method === "then" || method === "catch") && raw.startsWith(".")) {
    // Recurse into the body too so nested chain ops inside the dot-chain
    // (`..> .compute() ..! .recover()` doesn't happen at the same nesting,
    // but a method arg might contain one). The body is `__pcv` followed by
    // the original handler text.
    const body = `__pcv${rewriteChainsInCode(raw)}`;
    return `(__pcv) => ${body}`;
  }
  return rewriteChainsInCode(raw);
}

/**
 * Find the next chain operator anywhere in `code`. We deliberately do NOT
 * track paren depth here — `(recover() ..! fb)` contains a real chain that
 * needs rewriting too. The LHS/handler scanners DO track depth, so the
 * inner chain's LHS won't escape its `(...)` and outer chains stay outside.
 * The lex pass already excluded strings/templates/comments before we got
 * here, so the only false positives are unlikely lone `..` within JSX or
 * decorators, neither of which use the `..[!&>]` triplets we look for.
 */
function findNextTopLevelChainOp(code: string, from: number): { pos: number; op: Op } | null {
  for (let i = from; i < code.length; i++) {
    const op = chainOpAt(code, i);
    if (op !== null) return { pos: i, op };
  }
  return null;
}

/**
 * Walk backward from `opPos` through balanced parens to find the start of
 * the LHS expression. Stops at the first depth-0 expression boundary.
 * `=>` is a HARD boundary — a chain op inside an arrow body chains onto
 * the body's expression, not back over the `=>`.
 */
function scanLhsStart(code: string, opPos: number): number {
  let depth = 0;
  let i = opPos - 1;
  while (i >= 0 && /\s/.test(code[i]!)) i--;
  while (i >= 0) {
    const c = code[i]!;
    if (c === ")" || c === "]" || c === "}") {
      depth++;
      i--;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      if (depth === 0) {
        return i + 1;
      }
      depth--;
      i--;
      continue;
    }
    if (depth === 0) {
      if (c === "," || c === ";" || c === "\n") {
        return i + 1;
      }
      if (c === ">" && code[i - 1] === "=") {
        // `=>` arrow — LHS starts immediately after.
        let j = i + 1;
        while (j < code.length && /\s/.test(code[j]!)) j++;
        return j;
      }
      if (c === "=") {
        // Plain `=` assignment — but skip compound operators.
        const left = code[i - 1] ?? "";
        const right = code[i + 1] ?? "";
        if (right === ">") {
          // `=>` handled in the previous arm.
          let j = i + 2;
          while (j < code.length && /\s/.test(code[j]!)) j++;
          return j;
        }
        if (/[!<>+\-*/%&|^?.=]/.test(left) || right === "=") {
          // Compound — keep walking.
          i--;
          continue;
        }
        return i + 1;
      }
      if (c === "n" && code.slice(Math.max(0, i - 5), i + 1) === "return") {
        let j = i + 1;
        while (j < code.length && /\s/.test(code[j]!)) j++;
        return j;
      }
    }
    i--;
  }
  return 0;
}

/**
 * Walk forward from `startPos` through balanced parens to find the end of
 * the handler expression. Stops at the next top-level chain op or
 * statement terminator. Handler bodies may include bare arrow functions —
 * a top-level chain op inside an arrow body terminates the body (matches
 * the Zig parser's `in_chain_op_arrow_rhs` behavior). Parens reset depth
 * so a user can opt back in to nested chain ops by wrapping with `(...)`.
 */
function scanHandlerEnd(code: string, startPos: number): number {
  let depth = 0;
  let i = startPos;
  while (i < code.length) {
    const c = code[i]!;
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
      if (c === ";" || c === "\n") return i;
      if (c === ",") return i;
      if (chainOpAt(code, i) !== null) return i;
    }
    i++;
  }
  return code.length;
}
