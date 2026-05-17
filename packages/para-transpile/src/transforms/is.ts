// `EXPR is Type`     → `Type.parse(EXPR).tag === "Ok"`
// `EXPR is not Type` → `Type.parse(EXPR).tag !== "Ok"`
//
// Para's runtime type-guard operator. `Type` is a `schema`-defined shape
// whose `.parse(v)` returns a tagged result (`{ tag: "Ok" | "Err", … }`).
// Matches the canonical Zig lowering (test/bundler/transpiler/
// parabun-is.test.js): only fires when the RHS is a **Capitalized**
// identifier (so `const is = 5; is + 1` and `obj.is(x)` are untouched);
// the LHS may be a chained member/call/index expression.
//
// Region-based (skips strings/comments/regex) and position-preserving
// per match, so it composes with the `.pui` LSP projection's per-line
// MagicString mapping. `is not` is rewritten before `is` (the bare `is`
// rule can't match `is not` anyway — `not` isn't Capitalized — but order
// is explicit for clarity).
//
// Known shared limitation (not introduced here): a TS type-predicate
// return annotation `function f(v): v is T {}` is also `EXPR is Type`
// shaped and will be rewritten. This ambiguity exists across the whole
// toolchain (the Zig parser / build path included); the parity corpus
// does not cover it. Prefer a `schema` guard or avoid `: v is T`
// predicate signatures in Para sources.

import { rewriteCodeRegions } from "../lex";

const LHS = String.raw`[\w$.\[\]()]+`;
const RHS = String.raw`[A-Z][\w$]*`;

export function transformIs(src: string): string {
  if (!/\bis\b/.test(src)) return src;
  return rewriteCodeRegions(src, code => {
    code = code.replace(
      new RegExp(String.raw`\b(${LHS})\s+is\s+not\s+(${RHS})\b`, "g"),
      (_m, lhs, type) => `${type}.parse(${lhs}).tag !== "Ok"`,
    );
    code = code.replace(
      new RegExp(String.raw`\b(${LHS})\s+is\s+(${RHS})\b`, "g"),
      (_m, lhs, type) => `${type}.parse(${lhs}).tag === "Ok"`,
    );
    return code;
  });
}
