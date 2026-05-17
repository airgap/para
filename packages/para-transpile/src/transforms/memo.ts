// `memo` declarator + expression prefix.
//
// Declaration forms:
//   memo NAME(args) { body }                  → const NAME = __parabunMemo(function (args) { body }, ARITY);
//   memo async NAME(args) { body }            → const NAME = __parabunMemo(async function (args) { body }, ARITY);
//   memo NAME(args): TYPE { body }            → const NAME = __parabunMemo(function (args): TYPE { body }, ARITY);
//   export memo NAME(...) {...}               → export const NAME = __parabunMemo(...);
//
// Arrow expression forms (memo prefixes an arrow):
//   memo (args) => body                       → __parabunMemo((args) => body, ARITY)
//   memo arg => body                          → __parabunMemo(arg => body, 1)
//   memo async (args) => body                 → __parabunMemo(async (args) => body, ARITY)
//   memo <T>(args) => body                    → __parabunMemo(<T>(args) => body, ARITY)
//
// The function/arrow is rendered ANONYMOUS in the decl form so recursive
// self-references resolve through the outer `const` (the memoized wrapper)
// — a named inner `function fib(...)` would self-bind and bypass the cache.
//
// Disambiguation from a normal `memo` identifier:
//   memo(5)        — call: `(` immediately after, no `=>` after the close paren → leave alone
//   memo.foo       — property access → leave alone
//   memo = 1       — assignment → leave alone
//   memo(a, b)     — same: leave alone
//
// Arity is the formal parameter count. Rest parameters count toward the
// arity but always land in the multi-arg path at runtime; we don't
// distinguish rest at the syntactic level.

import { findMatchingBrace, scanRegions } from "../lex";

export function transformMemo(src: string): string {
  if (!src.includes("memo")) return src;
  const spans = scanRegions(src);
  const findSpan = (pos: number) => spans.find(s => pos >= s.start && pos < s.end);
  const inCode = (pos: number) => findSpan(pos)?.region === "code";

  let out = "";
  let last = 0;
  // Find every `\bmemo\b` token. For each, determine which form applies
  // and emit the rewrite, or leave it alone.
  const re = /\bmemo\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const memoPos = m.index;
    if (!inCode(memoPos)) continue;
    const result = tryParseMemo(src, memoPos);
    if (!result) continue;
    out += src.slice(last, result.replaceStart);
    out += result.replacement;
    last = result.replaceEnd;
    re.lastIndex = result.replaceEnd;
  }
  out += src.slice(last);
  return out;
}

type MemoMatch = {
  replaceStart: number;
  replaceEnd: number;
  replacement: string;
};

function tryParseMemo(src: string, memoPos: number): MemoMatch | null {
  // Determine whether this is a declaration or arrow-expression form.
  // Decl markers (at this position):
  //   - immediately preceded by start-of-input or `;` `\n` `{` `}` (after
  //     skipping whitespace) → could be a statement-start decl
  //   - preceded by `export ` → also a decl
  // Arrow markers:
  //   - preceded by `=`, `(`, `,`, `return`, `=>`, etc. → expression position

  // Find the previous non-whitespace char to classify position.
  let prev = memoPos - 1;
  while (prev >= 0 && /[ \t]/.test(src[prev]!)) prev--;
  const prevChar = prev < 0 ? "" : src[prev]!;

  // Check for `export memo` decl form: previous non-ws word is `export`.
  let isExported = false;
  let declStart = memoPos;
  if (prev >= 0) {
    const exportMatch = src.slice(0, prev + 1).match(/(^|[;\n{}])(\s*)export\s*$/);
    if (exportMatch) {
      isExported = true;
      declStart = exportMatch.index! + exportMatch[1]!.length + exportMatch[2]!.length;
    }
  }

  // Walk past `memo` + whitespace.
  let i = memoPos + 4;
  while (i < src.length && /[ \t]/.test(src[i]!)) i++;

  // Optional `async`.
  let isAsync = false;
  if (src.startsWith("async", i) && /[\s(<]/.test(src[i + 5] ?? "")) {
    isAsync = true;
    i += 5;
    while (i < src.length && /[ \t]/.test(src[i]!)) i++;
  }

  // Decl form: `memo [async] NAME(...)`
  // Arrow form: `memo [async] (...)` or `memo [async] <T>(...)` or `memo IDENT =>`

  const isDeclStart =
    prev < 0 || prevChar === ";" || prevChar === "{" || prevChar === "}" || prevChar === "\n" || isExported;

  // Try decl: identifier then `(`.
  const nameMatch = src.slice(i).match(/^([A-Za-z_$][\w$]*)\s*\(/);
  if (nameMatch && isDeclStart) {
    const name = nameMatch[1]!;
    const parenStart = i + nameMatch[0]!.length - 1; // position of `(`
    const parenEnd = matchParen(src, parenStart);
    if (parenEnd === -1) return null;
    const args = src.slice(parenStart + 1, parenEnd);
    // Optional return type annotation.
    let afterParen = parenEnd + 1;
    while (afterParen < src.length && /\s/.test(src[afterParen]!)) afterParen++;
    let typeAnnot = "";
    if (src[afterParen] === ":") {
      const typeStart = afterParen;
      // Find the `{` that opens the body, accounting for type-level `<>`.
      let depth = 0;
      let j = afterParen + 1;
      while (j < src.length) {
        const c = src[j]!;
        if (c === "<" || c === "(" || c === "[") depth++;
        else if (c === ">" || c === ")" || c === "]") depth--;
        else if (depth === 0 && c === "{") break;
        j++;
      }
      typeAnnot = src.slice(typeStart, j);
      afterParen = j;
    }
    if (src[afterParen] !== "{") return null;
    const bodyEnd = findMatchingBrace(src, afterParen);
    if (bodyEnd === -1) return null;
    const body = src.slice(afterParen, bodyEnd + 1);
    const arity = countArgs(args);
    const fnExpr = `${isAsync ? "async " : ""}function (${args})${typeAnnot} ${body}`;
    const replacement = `${isExported ? "export " : ""}const ${name} = __parabunMemo(${fnExpr}, ${arity})`;
    return { replaceStart: declStart, replaceEnd: bodyEnd + 1, replacement };
  }

  // Try arrow form: `memo (args) => body`.
  if (src[i] === "(" || src[i] === "<") {
    // For type-param form `memo <T>(args) => body`, walk past the `<...>`.
    let parenStart = i;
    if (src[i] === "<") {
      // Match `<...>` at type-level (not real expression).
      let depth = 1;
      let j = i + 1;
      while (j < src.length && depth > 0) {
        const c = src[j]!;
        if (c === "<") depth++;
        else if (c === ">") depth--;
        j++;
      }
      while (j < src.length && /\s/.test(src[j]!)) j++;
      parenStart = j;
    }
    if (src[parenStart] !== "(") return null;
    const parenEnd = matchParen(src, parenStart);
    if (parenEnd === -1) return null;
    // Look for `=>` after the `)` (with optional return-type annotation).
    let afterParen = parenEnd + 1;
    while (afterParen < src.length && /\s/.test(src[afterParen]!)) afterParen++;
    if (src[afterParen] === ":") {
      // Skip type annotation up to `=>`.
      while (afterParen < src.length && !(src[afterParen] === "=" && src[afterParen + 1] === ">")) afterParen++;
    }
    if (src.slice(afterParen, afterParen + 2) !== "=>") return null;
    // Find the end of the arrow body.
    const arrowBodyStart = afterParen + 2;
    const bodyEnd = findArrowBodyEnd(src, arrowBodyStart);
    const args = src.slice(parenStart + 1, parenEnd);
    const arity = countArgs(args);
    const arrowExpr = `${isAsync ? "async " : ""}${src.slice(i, bodyEnd)}`;
    const replacement = `__parabunMemo(${arrowExpr}, ${arity})`;
    return { replaceStart: memoPos, replaceEnd: bodyEnd, replacement };
  }

  // Single-arg arrow form: `memo IDENT =>`
  const singleArgMatch = src.slice(i).match(/^([A-Za-z_$][\w$]*)\s*=>/);
  if (singleArgMatch) {
    const startOfIdent = i;
    const arrowAt = i + singleArgMatch[0]!.length - 2; // position of `=`
    const arrowBodyStart = arrowAt + 2;
    const bodyEnd = findArrowBodyEnd(src, arrowBodyStart);
    const arrowExpr = `${isAsync ? "async " : ""}${src.slice(startOfIdent, bodyEnd)}`;
    const replacement = `__parabunMemo(${arrowExpr}, 1)`;
    return { replaceStart: memoPos, replaceEnd: bodyEnd, replacement };
  }

  return null;
}

function matchParen(src: string, openPos: number): number {
  if (src[openPos] !== "(") return -1;
  let depth = 1;
  let i = openPos + 1;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function countArgs(args: string): number {
  const trimmed = args.trim();
  if (!trimmed) return 0;
  let depth = 0;
  let count = 1;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i]!;
    if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
    else if (c === ")" || c === "]" || c === "}" || c === ">") depth--;
    else if (depth === 0 && c === ",") count++;
  }
  return count;
}

/** Find the end of an arrow body — either a `{ … }` block or an expression
 * that ends at a top-level `;` / `,` / `)` / `]` / `}` / EOL. */
function findArrowBodyEnd(src: string, from: number): number {
  let i = from;
  while (i < src.length && /\s/.test(src[i]!)) i++;
  if (src[i] === "{") {
    const end = findMatchingBrace(src, i);
    return end === -1 ? src.length : end + 1;
  }
  // Expression body — walk until top-level delimiter.
  let depth = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return i;
      depth--;
    } else if (depth === 0 && (c === ";" || c === "," || c === "\n")) return i;
    i++;
  }
  return src.length;
}
