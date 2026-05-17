// `Nd` numeric-literal suffix → `__paraDec("N")` runtime call.
//
// Lowers `0.1d`, `1d`, `1.5d`, `100.25d`, `1.5e3d`, etc. The string form of
// the source is critical — we never go through `Number(0.1)` because the
// whole point of the literal is to skip the float roundtrip. So `0.1d`
// lowers to `__paraDec("0.1")`, NOT `__paraDec(0.1)`.
//
// The rewrite is conservative: only fires when we see a numeric literal
// followed immediately by a lowercase `d` that's NOT part of a longer
// identifier. We need to check the character BEFORE the number too, so we
// don't transform e.g. `let id = 1` (where `d` is part of `id`, not a
// suffix on `1`). The regex's leading `\B` boundary on the digit handles
// that — a number can only start where the previous char is not an
// identifier character.

import { rewriteCodeRegions } from "../lex";

// Numeric literal grammar accepted as a base for the `d` suffix:
//   - integer: 1, 42, 100
//   - decimal: 0.1, 1.5, 100.25, .5
//   - scientific: 1e3, 1.5e-3, 2E+10
// We deliberately do NOT match:
//   - hex / octal / binary literals (0x.., 0o.., 0b..) — Decimal accepts
//     base-10 strings only.
//   - bigint suffix (1n) — that's a different token.
//   - leading sign — `-1d` parses as the unary minus on the Decimal,
//     same as how `-1n` is unary minus on a BigInt.
//   - trailing `..` (range operator) — captured separately by the range
//     pass; the `(?!\.\.)` lookahead prevents `1d..5` from misfiring.
const DECIMAL_LITERAL_RE = new RegExp(
  // (?<![\w$.]) — not after an identifier character or a `.` (so we don't
  // grab the `5` from `obj.5d` or the `2` from `1e2d` partway through).
  String.raw`(?<![\w$.])` +
    // The number itself, captured in group 1.
    String.raw`(` +
    // Either `.5` style (leading dot) OR `1`/`1.5`/`1.` style.
    String.raw`(?:\.\d+|\d+(?:\.\d*)?)` +
    // Optional exponent.
    String.raw`(?:[eE][+-]?\d+)?` +
    String.raw`)` +
    // The `d` suffix — must NOT be followed by another identifier character
    // (so we don't grab `1do` etc.).
    String.raw`d(?![\w$])`,
  "g",
);

export function transformDecimal(src: string): string {
  if (!src.includes("d")) return src;
  return rewriteCodeRegions(src, code => {
    return code.replace(DECIMAL_LITERAL_RE, (_m, num: string) => `__paraDec(${JSON.stringify(num)})`);
  });
}
