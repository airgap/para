// `a..b`  → __parabunRange(a, b)             (exclusive)
// `a..=b` → __parabunRangeInclusive(a, b)    (inclusive)
//
// Integer-literal bounds + step 1. Empty/inverted ranges produce []. The
// helpers are emitted as references to the runtime bundle (parabun-browser-
// shims provides them under the same names).
//
// Lexer note: `1..2` is the obscure-idiom break — baseline JS would
// tokenize `1.` as a numeric literal then `.2` as a property/number, but
// Para-aware tokenization treats `..` as the range operator. The
// canonical Zig parser handles this in js_lexer.zig; this text-level
// rewriter just needs to be careful about `1..method()` (range form: 1
// through `method()` reference, then call) vs `1.0..2` (number then
// range). Conservative: only rewrite when we see a clear digit-or-ident
// pattern around `..`.

import { rewriteCodeRegions } from "../lex";

export function transformRanges(src: string): string {
  return rewriteCodeRegions(src, code => {
    let out = code;
    // Inclusive form first (so the `=` doesn't get eaten by the exclusive
    // pattern). Operands: integer literal OR identifier OR a parenthesized
    // expression. Multi-char identifier names handled via \w+.
    const operand = String.raw`(?:\d+|[A-Za-z_$][\w$]*|\([^()]*\))`;
    out = out.replace(
      new RegExp(String.raw`(${operand})\.\.=(${operand})`, "g"),
      (_m, a, b) => `__parabunRangeInclusive(${a}, ${b})`,
    );
    // Exclusive form. Same operand shape; the negative lookahead on `.` /
    // `=` prevents matching `..=` (already handled) or `...` (spread).
    out = out.replace(
      new RegExp(String.raw`(${operand})\.\.(?![.=])(${operand})`, "g"),
      (_m, a, b) => `__parabunRange(${a}, ${b})`,
    );
    return out;
  });
}
