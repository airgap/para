// `fun` is parabun's short function keyword. The Zig lexer treats the
// identifier `fun` as the `function` keyword in parabun files
// (js_lexer.zig: `isParabunFile() and eqlComptime(identifier, "fun")`;
// parseStmt.zig accepts it in declaration position). The transpiler
// mirrors that by rewriting the keyword to `function`.
//
// NOT length-preserving (`fun` 3 → `function` 8) — unlike the `pure`
// strip. That's inherent to the keyword expansion; downstream sourcemap
// consumers must map at line (not column) granularity for rewritten
// lines, which is the established contract for non-isometric rewrites.
//
// `(?<!\.)` guards member access (`obj.fun(...)` stays). The lookahead
// requires `fun` to be immediately followed (after optional whitespace)
// by an identifier / `(` / `*` (generator) / `<` (generic) — i.e. a
// function-declaration or function-expression head — so a variable named
// `fun` used as a value (`return fun;`, `fun]`) is untouched.

import { rewriteCodeRegions } from "../lex";

export function transformFun(src: string): string {
  return rewriteCodeRegions(src, code =>
    code.replace(/(?<!\.)\bfun\b(\s*)(?=[A-Za-z_$*(<])/g, (_m, ws) => "function" + ws),
  );
}
