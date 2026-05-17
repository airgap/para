// `pure` is a parse-time purity marker — at runtime it has no effect.
// The Zig parser uses the flag to gate identifier-purity checks during
// parsing. The transpiler doesn't enforce purity (that's a static-analysis
// concern users would run separately); it just strips the keyword so the
// emitted JS is valid.
//
// Position-preserving rewrite: `pure ` becomes 5 spaces (4 for `pure` + the
// trailing space). This keeps column positions in source maps aligned with
// the original — important if the transpiler later emits source maps.

import { rewriteCodeRegions } from "../lex";

export function transformPure(src: string): string {
  return rewriteCodeRegions(src, code => {
    // `pure function`, `pure async function`, `pure (`, `pure x =>`, `pure <T>(`
    return code.replace(
      /\bpure(\s+)(?=function\b|async\s+function\b|<[\w\s,=]+>\s*\(|\(|\w+\s*=>)/g,
      (_m, ws) => "    " + ws,
    );
  });
}
