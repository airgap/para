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

import { rewriteCodeRegions, scanRegions } from "../lex";

const LHS = String.raw`[\w$.\[\]()]+`;
const RHS = String.raw`[A-Z][\w$]*`;

// Literal-membership mirror of the canonical Zig lowering
// (test/bundler/transpiler/parabun-is.test.js, "literal-membership"):
//   S is 'a' | 'b'      → (S === "a" || S === "b")
//   S is not 'a' | 'b'  → (S !== "a" && S !== "b")
// Operand restricted to an identifier / property path (mirrors the
// parser's isSimpleMembershipSubject) so it's side-effect-free to repeat
// and TS narrows it like a hand-written chain — non-simple operands don't
// match (the parser errors on them). String & numeric literals only. The
// chain is always parenthesised: a textual rewrite needs the parens to
// keep precedence inside larger exprs (`a && S is 'x'|'y'`); parity's AST
// normaliser canonicalises the redundant parens vs the Zig printer.
const MEM_LHS = String.raw`[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*`;
const LIT = String.raw`'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\d[\d_.eE]*`;

// The canonical Zig printer normalises string literals to double quotes;
// numbers pass through. Match that so the membership chain is byte-equal
// after parity normalisation (which preserves quote style). Handles the
// common membership literals (`'open'`, `'a|b'`, `'a\'b'`); exotic escape
// forms are a documented v1 edge.
function toCanonicalLit(lit: string): string {
  if (lit[0] !== "'") return lit; // already double-quoted, or numeric
  const body = lit
    .slice(1, -1)
    .replace(/\\'/g, "'")
    .replace(/(?<!\\)"/g, '\\"');
  return `"${body}"`;
}

export function transformIs(src: string): string {
  if (!/\bis\b/.test(src)) return src;
  // Schema guards (RHS is a bare Capitalized ident → lives entirely in a
  // code region, so the standard string/comment-skipping pass works).
  let out = rewriteCodeRegions(src, code => {
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

  // Literal membership: the RHS literals are *string regions*, so this
  // can't run inside rewriteCodeRegions' per-code-chunk mapper (the
  // literals are masked from it). Run over the full text, but only rewrite
  // a match whose operand starts in a CODE region — so an `is` sitting
  // inside a string/comment is left alone. (Same documented toolchain-wide
  // limitation as the schema rule for a `function f(v): v is 'a'|'b'` TS
  // type-predicate annotation; the parity corpus does not cover it.)
  if (!/\bis\b/.test(out)) return out;
  const spans = scanRegions(out);
  const regionAt = (pos: number): string => {
    for (const s of spans) if (pos >= s.start && pos < s.end) return s.region;
    return "code";
  };
  const memRe = new RegExp(String.raw`\b(${MEM_LHS})\s+is\s+(not\s+)?((?:${LIT})(?:\s*\|\s*(?:${LIT}))*)`, "g");
  const litRe = new RegExp(LIT, "g");
  let result = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = memRe.exec(out)) !== null) {
    if (regionAt(m.index) !== "code") continue; // `is` inside a string/comment
    const lhs = m[1]!;
    const notKw = m[2];
    const lits = m[3]!.match(litRe) ?? [];
    const eq = notKw ? "!==" : "===";
    const join = notKw ? " && " : " || ";
    result += out.slice(last, m.index) + "(" + lits.map(l => `${lhs} ${eq} ${toCanonicalLit(l)}`).join(join) + ")";
    last = m.index + m[0].length;
  }
  result += out.slice(last);
  return result;
}
