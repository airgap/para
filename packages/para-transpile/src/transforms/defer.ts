// `defer EXPR;`        → using __paraDefer0 = __parabunDefer0(() => EXPR);
// `defer await EXPR;`  → await using __paraDefer0 = __parabunAsyncDefer0(async () => EXPR);
//
// Schedules cleanup at the end of the enclosing block via ES2024 `using` /
// `await using` declarations. The runtime helpers `__parabunDefer0` and
// `__parabunAsyncDefer0` wrap the callback in a `Symbol.dispose` /
// `Symbol.asyncDispose` shape so the LIFO disposal mechanics fall out of
// the language's own scope-exit semantics.
//
// The synthesized binding name uses a per-transpile counter to avoid
// collisions when multiple `defer` statements appear in the same scope.

import { scanRegions } from "../lex";

let counter = 0;

export function transformDefer(src: string): string {
  if (!src.includes("defer")) return src;
  const spans = scanRegions(src);
  const findSpan = (pos: number) => spans.find(s => pos >= s.start && pos < s.end);
  const inCode = (pos: number) => findSpan(pos)?.region === "code";

  // Match `defer` (optionally followed by `await`) at statement-start, then
  // grab the expression up to the next top-level `;`. Statement-start =
  // start-of-input or after `;` `\n` `{` `}`.
  const re = /(^|[;\n{}])(\s*)defer(\s+await)?\s+/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const matchStart = m.index + m[1]!.length + m[2]!.length;
    if (!inCode(matchStart)) continue;
    const matchEnd = re.lastIndex;
    const isAsync = !!m[3];
    // Forward-scan to the end of the deferred expression (depth-0 `;`).
    let depth = 0;
    let i = matchEnd;
    while (i < src.length) {
      if (!inCode(i)) {
        const span = findSpan(i);
        i = span ? span.end : i + 1;
        continue;
      }
      const c = src[i]!;
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (depth === 0 && (c === ";" || c === "\n")) break;
      i++;
    }
    const expr = src.slice(matchEnd, i).trim();
    const name = `__paraDefer${counter++}`;
    out += src.slice(last, matchStart);
    if (isAsync) {
      out += `await using ${name} = __parabunAsyncDefer0(async () => ${expr})`;
    } else {
      out += `using ${name} = __parabunDefer0(() => ${expr})`;
    }
    last = i;
    re.lastIndex = i;
  }
  out += src.slice(last);
  return out;
}

/**
 * Reset the counter — primarily for tests to get deterministic output
 * across calls. In normal use the counter persists per-process which is
 * fine because the names are unique per emitted file.
 */
export function _resetDeferCounter() {
  counter = 0;
}
