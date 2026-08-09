/**
 * Parabun → TypeScript source transform.
 *
 * Desugars Parabun-specific syntax into valid TypeScript so the TS
 * language service can type-check it.  Position-preserving where
 * possible (pure keyword → same-length whitespace).
 *
 * This is NOT the runtime transpiler. Bun's Zig parser handles
 * actual compilation.  This only needs to satisfy the type checker.
 */

const PARABUN_SYNTAX_RE =
  /\bpure\s|\bfun\b|\.\.=|\.\.!|\.\.&|\|>|\bschema\s+[A-Za-z_$]|\bschema\s*\{|\bmatch\s+[A-Za-z_$(]|\beffect\s*\{|\beffect\s+[A-Za-z_$]|\bwhen(?:\s+not)?\s+|\bsignal\s+[A-Za-z_$]|\barena\s*\{|::\s*[A-Z]|\bis\s+(?:not\s+)?[A-Z]|(?:\|\||&&|\?\??|=>|:)\s*throw\s/;

// LYK-827: `_` in expression contexts (e.g. `arr.filter(_ > 0)`) wraps
// in `(__pu => _ > 0)` at parse time in the Zig parser. The ts-plugin
// doesn't replicate that wrap, too risky with regex on real-world
// expressions, but it still has to make tsc accept the source as-is
// for IDE type-checking on unstaged Para code. Pattern matches a `_`
// token used in expression position (with an operator on at least one
// side or inside a function-call arg expression), distinguishing from
// `const _ = ...` / `_:` / `_(` etc. where `_` is a real binding the
// user declared.
const UNDERSCORE_EXPR_RE = /(?<![A-Za-z0-9$_."])_(?=\s*(?:[<>=!+\-*/%&|^?:.,)]|\?\?|===|!==|==|!=|\|\||&&))/;
const UNDERSCORE_DECL_RE = /(?:^|[\s;{(,])(?:const|let|var)\s+_\b/m;

export function containsParabunSyntax(text: string): boolean {
  // The `_`-lambda check is its own predicate (gated by the declaration
  // sniff). We don't want to fire the full Para transform pipeline on
  // any file that happens to use lodash with `_.map`, only on files
  // where `_` appears as a free expression-position reference.
  if (PARABUN_SYNTAX_RE.test(text)) return true;
  if (UNDERSCORE_EXPR_RE.test(text) && !UNDERSCORE_DECL_RE.test(text)) {
    // Defend against import / param forms, same checks
    // `injectUnderscoreLambdaHelper` uses, lifted here so the
    // detection and the inject agree.
    if (/import\s*\{[^}]*\b_\b[^}]*\}/.test(text)) return false;
    if (/\bfunction\s+[A-Za-z0-9_$]*\s*\([^)]*\b_\b[^)]*\)/.test(text)) return false;
    return true;
  }
  return false;
}

export function transformParabunToTS(source: string): string {
  if (!containsParabunSyntax(source)) return source;

  // Whole-source transforms first. These need multi-line awareness
  // (`schema X { ... }` body, `match e { ... }` arms).
  source = transformModelDecls(source);
  source = transformSchemaEqualsBlock(source);
  source = transformInlineSchemaExpr(source);
  source = transformThrowExpr(source);
  source = transformMatchExprs(source);

  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    lines[i] = transformLine(lines[i]);
  }

  let result = lines.join("\n");
  result = transformMultilinePipeline(result);
  // After all desugars, scan for __paraIs_<Type>() calls and prepend
  // typed-predicate helpers so TS narrows `if (x is Type) { ... }`.
  result = injectIsHelpers(result);
  // Inject the `__paraFromSchema` ambient declaration so `schema X = body`
  // and `schema { ... }` results carry `.parse` / `.is` / `.schema` for tsc.
  result = injectSchemaHelper(result);
  // LYK-827: when the source uses `_` as a lambda shorthand in an
  // expression position (`arr.filter(_ > 0)`), inject an ambient
  // `declare const _: any;` so tsc doesn't flag the reference. The
  // Zig parser handles the actual lambda wrap at parse time; tsc just
  // needs `_` to resolve to something. Skipped when the source already
  // binds `_` (so we don't redeclare a user-owned name).
  result = injectUnderscoreLambdaHelper(result);
  return result;
}

function transformLine(line: string): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//")) return line;

  if (trimmed.startsWith("/*")) return line;

  line = expandFun(line);
  line = stripPure(line);
  line = stripValidationMarker(line);
  line = transformIsTypeGuard(line);
  line = transformModelFromLine(line);
  line = transformEffectLine(line);
  line = transformWhenLine(line);
  line = transformArenaLine(line);
  line = transformSignalLine(line);
  line = transformCatchFinally(line);
  line = transformPipeline(line);

  return line;
}

// `fun` → `function` (only in declaration context, not as a variable name)
function expandFun(line: string): string {
  return line.replace(/(?<!\.)(\bfun)\b(?=\s*[a-zA-Z_$*(<])/g, "function");
}

// `(req:: User)` → `(req:  User)`. Strip the second `:` so TS sees a normal
// type annotation. Position-preserving.
function stripValidationMarker(line: string): string {
  return line.replace(/(:):/g, "$1 ");
}

// `expr is Type` / `expr is not Type` → `__paraIs_Type(expr)` /
// `!__paraIs_Type(expr)`. Helper functions are injected at the top of
// the source by `injectIsHelpers`. They're typed `(v: any): v is Type`,
// so TS narrows `expr` inside `if (...) { ... }` bodies.
function transformIsTypeGuard(line: string): string {
  line = line.replace(
    /\b([\w$.\[\]()]+)\s+is\s+not\s+([A-Z][\w$]*)\b/g,
    (_m, lhs, type) => `!__paraIs_${type}(${lhs})`,
  );
  line = line.replace(/\b([\w$.\[\]()]+)\s+is\s+([A-Z][\w$]*)\b/g, (_m, lhs, type) => `__paraIs_${type}(${lhs})`);
  return line;
}

// Scan the (already-transformed) source for `__paraIs_<Type>(...)`
// references and prepend a typed-predicate helper for each unique Type.
// Each helper has shape `(v: any): v is Type => Type.parse(v).tag === "Ok"`,
// which gives TS proper narrowing in `if (x is Type) { ... }` bodies.
function injectIsHelpers(source: string): string {
  const types = new Set<string>();
  const re = /__paraIs_([A-Z][\w$]*)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) types.add(m[1]);
  if (types.size === 0) return source;
  const helpers = [...types]
    .map(t => `const __paraIs_${t} = (v: any): v is ${t} => (${t} as any).parse(v).tag === "Ok";`)
    .join("\n");
  return helpers + "\n" + source;
}

// Single-line `schema X from <expr>` and single-line `schema X = <expr>`
// (where `<expr>` is NOT an open-brace literal: `transformSchemaEqualsBlock`
// already handled `schema X = { ... }`). Wraps the rhs in
// `__paraFromSchema(() => (<expr>))` so tsc sees the typed result.
function transformModelFromLine(line: string): string {
  // `from` form
  line = line.replace(
    /\b(export\s+)?schema\s+([A-Za-z_$][\w$]*)\s+from\s+(.+?)(\s*;?\s*)$/,
    (_m, exportKw, name, expr, trailing) =>
      `${exportKw ?? ""}const ${name} = __paraFromSchema(() => (${expr}))${trailing}${schemaTypeAlias(exportKw, name)}`,
  );
  // `=` form, but ONLY when the rhs is not an object-literal opening (`{`),
  // since `transformSchemaEqualsBlock` already handled those at whole-source
  // scope.
  line = line.replace(
    /\b(export\s+)?schema\s+([A-Za-z_$][\w$]*)\s*=\s*(?!\{)(.+?)(\s*;?\s*)$/,
    (_m, exportKw, name, expr, trailing) =>
      `${exportKw ?? ""}const ${name} = __paraFromSchema(() => (${expr}))${trailing}${schemaTypeAlias(exportKw, name)}`,
  );
  return line;
}

// Emit a TS type alias so a `schema X` declaration is usable in BOTH
// value AND type position. The alias resolves to `(typeof X)["schema"]`
// (the unwrapped JSON Schema body) so `PostgresTableModel<X>` and
// other heavy generics skip the `{...} & S` intersection walk that
// the full helper return type forces. Measured 1.5-2.2x speedup on
// warm edits in lyku.
function schemaTypeAlias(exportKw: string | undefined, name: string): string {
  return `;${exportKw ?? ""}type ${name} = (typeof ${name})["schema"]`;
}

// `[export ]schema NAME = { ...body... }[ as const][ satisfies T];` →
// `[export ]const NAME = __paraFromSchema(() => ({ ...body... }))[ as const][ satisfies T];`.
// Multi-line and brace-balanced. Strings / comments respected so a `}`
// inside a string literal can't close early.
function transformSchemaEqualsBlock(source: string): string {
  const re = /\b(export\s+)?schema\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g;
  const out: string[] = [];
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const exportKw = m[1] ?? "";
    const name = m[2];
    const openIdx = m.index + m[0].length - 1; // position of `{`
    let i = openIdx + 1;
    let depth = 1;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === '"' || ch === "'" || ch === "`") {
        const q = ch;
        i++;
        while (i < source.length && source[i] !== q) {
          if (source[i] === "\\") i++;
          i++;
        }
        i++;
        continue;
      }
      if (ch === "/" && source[i + 1] === "/") {
        while (i < source.length && source[i] !== "\n") i++;
        continue;
      }
      if (ch === "/" && source[i + 1] === "*") {
        i += 2;
        while (i < source.length - 1 && !(source[i] === "*" && source[i + 1] === "/")) i++;
        i += 2;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    if (depth !== 0) continue;
    const closeIdx = i - 1;
    const body = source.slice(openIdx, closeIdx + 1);
    out.push(source.slice(lastEnd, m.index));
    out.push(`${exportKw}const ${name} = __paraFromSchema(() => (${body}))${schemaTypeAlias(exportKw, name)}`);
    lastEnd = closeIdx + 1;
    re.lastIndex = closeIdx + 1;
  }
  out.push(source.slice(lastEnd));
  return out.join("");
}

// `effect { ... }` → `(() => { ... }`: preserves the body for type-check.
// Single-statement `effect EXPR;` → blank `effect` to 6 spaces
// (column-preserving), leaving a plain expression statement for the TS
// pass. Same disambiguation as the parser/grammar: `effect(` `effect.`
// `effect[` `effect=` `effect:` keep `effect` as a plain identifier.
function transformEffectLine(line: string): string {
  return line
    .replace(/\b(effect)(\s*\{)/g, (_m, _kw, brace) => `(() =>${brace}`)
    .replace(/\b(effect)\b(?=\s+[A-Za-z_$])/g, "      ");
}

// `when EXPR { ... }` → `if (EXPR) { ... }`
// `when not EXPR { ... }` → `if (!(EXPR)) { ... }`
// `when not { ... }` (paired form) → `else { ... }`
function transformWhenLine(line: string): string {
  // Bare paired form first.
  line = line.replace(/\bwhen\s+not(\s*\{)/g, (_m, brace) => `else${brace}`);
  // Negated predicate form.
  line = line.replace(/\bwhen\s+not\s+(.+?)(\s*\{)/g, (_m, pred, brace) => `if (!(${pred}))${brace}`);
  // Plain predicate form.
  line = line.replace(/\bwhen\s+(.+?)(\s*\{)/g, (_m, pred, brace) => `if (${pred})${brace}`);
  return line;
}

// `arena { ... }` → `(() => { ... })()` (sync IIFE). DeferGC scope is runtime-only.
function transformArenaLine(line: string): string {
  return line.replace(/\b(arena)(\s*\{)/g, (_m, _kw, brace) => `(() =>${brace}`);
}

// `signal NAME = EXPR` → `let NAME: any = EXPR`: type-check fidelity only.
function transformSignalLine(line: string): string {
  // Rewrite `signal NAME` to `let NAME: any` so tsc accepts the decl.
  // Also strip the `every MS_EXPR` postfix. That part of the syntax
  // tells the parser to wrap the binding in a setInterval, but tsc
  // can't parse `=> RHS every MS` as a value-expression. Dropping the
  // postfix at the ts-plugin layer leaves tsc with `let NAME: any =
  // RHS;` which is well-formed. The runtime emission is unaffected
  // because the Zig parser handles the real lowering. The ts-plugin
  // is IDE-only.
  let out = line.replace(/\b(signal)\s+([A-Za-z_$][\w$]*)\b/g, (_m, _kw, name) => `let ${name}: any`);
  // `every <expr>` up to end-of-line / `;` / `,`. The regex is loose
  // (no nested-paren tracking), fine for `every 1_000` / `every
  // config.tickMs` / `every fn()` style postfixes; edge cases with
  // commas inside the MS expression would need a real parser, but
  // those don't show up in practice for an interval period.
  out = out.replace(/\bevery\s+[^;,\n]+/g, "");
  return out;
}

// Inline `schema { ... }` expression → `__paraFromSchema(() => ({ ... }))`.
// Wrapping in the typed helper (declared by `injectSchemaHelper`) means
// tsc sees the expression's type as `SchemaShape & body`: `.parse` /
// `.is` / `.schema` / field-accessors all resolve at the call site.
// Brace-balanced; strings/comments skipped so a `}` inside a literal
// can't close the body early.
function transformInlineSchemaExpr(source: string): string {
  const out: string[] = [];
  const re = /\bschema\s*\{/g;
  let match: RegExpExecArray | null;
  let lastEnd = 0;
  while ((match = re.exec(source)) !== null) {
    const start = match.index;
    if (isInsideStringOrComment(source, start)) continue;
    const openBraceIdx = start + match[0].length - 1;
    let depth = 1;
    let j = openBraceIdx + 1;
    while (j < source.length && depth > 0) {
      const ch = source[j];
      if (ch === '"' || ch === "'" || ch === "`") {
        const q = ch;
        j++;
        while (j < source.length && source[j] !== q) {
          if (source[j] === "\\") j++;
          j++;
        }
        j++;
        continue;
      }
      if (ch === "/" && source[j + 1] === "/") {
        while (j < source.length && source[j] !== "\n") j++;
        continue;
      }
      if (ch === "/" && source[j + 1] === "*") {
        j += 2;
        while (j < source.length - 1 && !(source[j] === "*" && source[j + 1] === "/")) j++;
        j += 2;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      j++;
    }
    if (depth !== 0) continue;
    const closeIdx = j - 1;
    const body = source.slice(openBraceIdx, closeIdx + 1);
    out.push(source.slice(lastEnd, start));
    out.push(`__paraFromSchema(() => (${body}))`);
    lastEnd = closeIdx + 1;
    re.lastIndex = closeIdx + 1;
  }
  out.push(source.slice(lastEnd));
  return out.join("");
}

// Prepend an ambient declaration of `__paraFromSchema` to the source
// when any of the schema transforms emitted a call. The return type
// is the JSON Schema literal `S` plus the runtime decoration:
// `.parse` / `.is` / `.schema` / field-accessors resolve naturally at
// the call site without a per-file `.d.ts` shim. Wide `S` (no `<const>`
// type parameter) so we don't compound tsc's literal-inference memory
// pressure across the workspace; narrow types come back from the
// offline `gen-dts-rewrite` pipeline (Phase 1 of the brand codegen).
// `<trigger> throw E` → `<trigger> (() => { throw E; })()`. Triggers:
// `||` / `&&` / `??` / `?` (ternary) / `:` / `=>`. `?.` excluded.
// Operand ends at the next depth-0 `;` / `,` / closing bracket. Strings
// and comments respected so a `}` inside a literal can't terminate
// the operand early.
function transformThrowExpr(source: string): string {
  const out: string[] = [];
  const re = /(\|\||&&|\?\?|\?(?!\.)|:|=>)\s*throw\s+/g;
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const start = m.index;
    if (isInsideStringOrComment(source, start)) continue;
    const trigger = m[1];
    let i = re.lastIndex;
    const operandStart = i;
    let depth = 0;
    while (i < source.length) {
      const ch = source[i];
      if (ch === '"' || ch === "'" || ch === "`") {
        const q = ch;
        i++;
        while (i < source.length && source[i] !== q) {
          if (source[i] === "\\") i++;
          i++;
        }
        i++;
        continue;
      }
      if (ch === "/" && source[i + 1] === "/") {
        while (i < source.length && source[i] !== "\n") i++;
        continue;
      }
      if (ch === "/" && source[i + 1] === "*") {
        i += 2;
        while (i < source.length - 1 && !(source[i] === "*" && source[i + 1] === "/")) i++;
        i += 2;
        continue;
      }
      if (ch === "(" || ch === "{" || ch === "[") {
        depth++;
        i++;
        continue;
      }
      if (ch === ")" || ch === "}" || ch === "]") {
        if (depth === 0) break;
        depth--;
        i++;
        continue;
      }
      if (depth === 0 && (ch === ";" || ch === ",")) break;
      i++;
    }
    const operandEnd = i;
    const operand = source.slice(operandStart, operandEnd).trim();
    if (!operand) continue;
    out.push(source.slice(lastEnd, start));
    out.push(`${trigger} (() => { throw ${operand}; })()`);
    lastEnd = operandEnd;
    re.lastIndex = operandEnd;
  }
  out.push(source.slice(lastEnd));
  return out.join("");
}

function injectSchemaHelper(source: string): string {
  if (!/\b__paraFromSchema\b/.test(source)) return source;
  // Recursive `SchemaValueOf<S>` mirrors the runtime decoration:
  //   - `.parse` / `.is` / `.schema` are always present.
  //   - The schema's own keys (`type`, `properties`, `required`, ...)
  //     pass through (`& S`), so `mySchema.type === "object"` resolves.
  //   - Fields under `properties` AND array elements under `items` /
  //     `prefixItems` get a `SchemaValueOf` wrap so `mySchema.field.type`
  //     works recursively (matching `__paraAddFieldAccessors` +
  //     `__paraWrapField` behaviour at runtime).
  const helper =
    `type __ParaResult<T> = { tag: "Ok"; value: T } | { tag: "Err"; error: string };\n` +
    `type __ParaSchemaValue<S> = {\n` +
    `  readonly parse: (v: unknown) => __ParaResult<unknown>;\n` +
    `  readonly validate: (v: unknown) => __ParaResult<unknown>;\n` +
    `  readonly schema: S;\n` +
    `  readonly element: S extends { items: infer I } ? __ParaSchemaValue<I> : never;\n` +
    `} & S & (S extends { properties: infer P } ? { readonly [K in keyof P]: __ParaSchemaValue<P[K]> } : {});\n` +
    `declare function __paraFromSchema<S>(s: () => S): __ParaSchemaValue<S>;`;
  return helper + "\n" + source;
}

// LYK-827: when `_` is used as a lambda shorthand (`arr.filter(_ > 0)`),
// the Zig parser wraps the surrounding arg expression in a fresh
// `(__pu => ...)` arrow at parse time. The ts-plugin lives on the
// IDE side and feeds tsc unstaged Para source. Without help, tsc
// would flag every expression-position `_` as "Cannot find name _".
//
// Rather than replicate the full expression-tree walk in regex (the
// arg shapes that need wrapping are arbitrary JS expressions,
// fragile), we inject a single ambient `declare const _: any;`. tsc
// then accepts `_` as a valid identifier of type `any`, and `any`
// flows through any operation including being assigned to a callable
// param. The runtime emit (from the Zig parser) still gets the real
// lambda wrap, so this only affects IDE type-checking.
//
// Skipped when the source already binds `_` (so a user-owned name
// isn't shadowed). The detection is conservative: any `const _ = …`,
// `let _ = …`, `var _ = …`, or `function _(…)` / param `_` declaration
// suppresses the inject.
function injectUnderscoreLambdaHelper(source: string): string {
  if (!UNDERSCORE_EXPR_RE.test(source)) return source;
  if (UNDERSCORE_DECL_RE.test(source)) return source;
  // Also bail if `_` is destructured (import { _ }) or a function
  // parameter. Both look like declarations to a human, and our
  // ambient `_` would conflict.
  if (/import\s*\{[^}]*\b_\b[^}]*\}/.test(source)) return source;
  if (/\bfunction\s+[A-Za-z0-9_$]*\s*\([^)]*\b_\b[^)]*\)/.test(source)) return source;
  return `declare const _: any;\n` + source;
}

function isInsideStringOrComment(source: string, offset: number): boolean {
  let i = 0;
  while (i < offset) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      i++;
      while (i < offset && source[i] !== q) {
        if (source[i] === "\\") i++;
        i++;
      }
      if (i >= offset) return true;
      i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      if (i > offset) return true;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length - 1 && !(source[i] === "*" && source[i + 1] === "/")) i++;
      if (i > offset) return true;
      i += 2;
      continue;
    }
    i++;
  }
  return false;
}

// Hybrid rewrite: open `schema NAME {` becomes `type NAME = {`, close `}`
// is augmented with the const decl. Body lines only get rewritten when
// they have Para-specific type fragments (refinements, array+bounds,
// lowercase Para aliases). Plain TS field types pass through verbatim
// Preserving hover positions for the common pg-models case.
function transformModelDecls(source: string): string {
  return source.replace(
    /\b(export\s+)?schema\s+([A-Za-z_$][\w$]*)(\s*\{)([\s\S]*?)(\n\s*)\}/g,
    (_m, exportKw, name, openBrace, body, closeWs) => {
      const e = exportKw ?? "";
      const rewritten = rewriteParaFieldLines(body);
      const constDecl =
        ` ${e}const ${name}: { parse: (v: any) => { tag: "Ok"; value: ${name} } | { tag: "Err"; error: string }; schema: any } = ` +
        `{ parse: (_v: any) => ({} as any), schema: {} as any };`;
      return `${e}type ${name} =${openBrace}${rewritten}${closeWs}};${constDecl}`;
    },
  );
}

function rewriteParaFieldLines(body: string): string {
  return body
    .split("\n")
    .map(line => {
      // Para syntax: `field: type` with optional `?` POSTFIX on the type
      // (`field: type?`). TS uses prefix `?:` (`field?: type`). Match
      // both shapes; detect the Para postfix by the trailing `?` on raw.
      const m = line.match(/^(\s*)([A-Za-z_$][\w$]*)(\??)\s*:\s*(.+?)(\?)?(\s*[,;]?\s*)$/);
      if (!m) return line;
      const [, leadWs, name, prefixOpt, raw, postfixOpt, trail] = m;
      const trimmed = raw.trim();
      const optional = prefixOpt === "?" || postfixOpt === "?";
      const isParaSpecific =
        /\(/.test(trimmed) ||
        /^\[[A-Za-z_$][\w$]*\]/.test(trimmed) ||
        /^(int|str|bool|float|num|Email|UUID|Url|Date|DateTime|IpV4|IpV6|Slug)$/.test(trimmed) ||
        postfixOpt === "?";
      if (!isParaSpecific) return line;
      const tsType = paraTypeFragmentToTs(trimmed);
      return `${leadWs}${name}${optional ? "?" : ""}: ${tsType}${trail}`;
    })
    .join("\n");
}

// Map Para field type names to TS types. Strips refinements / array
// suffix / range and normalizes to a plain TS type expression.
function parseModelFieldsForType(body: string): { name: string; tsType: string; optional: boolean }[] {
  const out: { name: string; tsType: string; optional: boolean }[] = [];
  const stripped = body.replace(/\/\/[^\n]*/g, "");
  // `field: type-frag` per non-comma/semi/newline token.
  const fieldRe = /([A-Za-z_$][\w$]*)\s*:\s*([^,;\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = fieldRe.exec(stripped)) !== null) {
    let raw = m[2].trim();
    const optional = raw.endsWith("?");
    if (optional) raw = raw.slice(0, -1).trim();
    out.push({ name: m[1], tsType: paraTypeFragmentToTs(raw), optional });
  }
  return out;
}

function paraTypeFragmentToTs(raw: string): string {
  raw = raw.trim();
  // Literal-union: `"a" | "b" | 0 | 1` → keep as-is (valid TS).
  if (/^\s*(?:"[^"]*"|\d+(?:\.\d+)?|true|false)/.test(raw)) {
    return raw;
  }
  // Array `[T]` or `[T](min..=max)` → `T[]`.
  const arrayMatch = raw.match(/^\[([A-Za-z_$][\w$]*)\](?:\([^)]*\))?$/);
  if (arrayMatch) return `${paraBaseTypeToTs(arrayMatch[1])}[]`;
  // Range refinement `int(0..150)` / `str(1..=64)`. Strip the parens.
  const rangeMatch = raw.match(/^([A-Za-z_$][\w$]*)\([^)]*\)$/);
  if (rangeMatch) return paraBaseTypeToTs(rangeMatch[1]);
  return paraBaseTypeToTs(raw);
}

function paraBaseTypeToTs(t: string): string {
  switch (t) {
    case "int":
    case "float":
    case "num":
    case "number":
      return "number";
    case "str":
    case "string":
    case "Email":
    case "UUID":
    case "Url":
    case "Date":
    case "DateTime":
    case "IpV4":
    case "IpV6":
    case "Slug":
      return "string";
    case "bool":
    case "boolean":
      return "boolean";
    default:
      return t; // capitalized → assumed model name (resolves to its own type)
  }
}

// `match EXPR { arm => result, ... }` → `((__m: any): any => null as any)(EXPR)`
// Same shape as the runtime emit (IIFE consuming the subject) so TS sees a
// well-typed expression. Body close is found by depth-balanced scan from
// the opening `{`. The older regex (`[\s\S]*?\n\s*\}`) couldn't terminate
// a single-line `match e { ... }` and swallowed the enclosing function's
// closing brace, which made tsc parse past EOF.
function transformMatchExprs(source: string): string {
  const out: string[] = [];
  const re = /\bmatch\s+([^{]+?)\s*\{/g;
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    let depth = 1;
    let j = openIdx + 1;
    while (j < source.length && depth > 0) {
      const ch = source[j];
      if (ch === '"' || ch === "'" || ch === "`") {
        const q = ch;
        j++;
        while (j < source.length && source[j] !== q) {
          if (source[j] === "\\") j++;
          j++;
        }
        j++;
        continue;
      }
      if (ch === "/" && source[j + 1] === "/") {
        while (j < source.length && source[j] !== "\n") j++;
        continue;
      }
      if (ch === "/" && source[j + 1] === "*") {
        j += 2;
        while (j < source.length - 1 && !(source[j] === "*" && source[j + 1] === "/")) j++;
        j += 2;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      j++;
    }
    if (depth !== 0) continue;
    const closeIdx = j - 1;
    out.push(source.slice(lastEnd, m.index));
    out.push(`((__m: any): any => null as any)(${m[1].trim()})`);
    lastEnd = closeIdx + 1;
    re.lastIndex = closeIdx + 1;
  }
  out.push(source.slice(lastEnd));
  return out.join("");
}

// Replace `pure` keyword with same-length whitespace (position-preserving).
function stripPure(line: string): string {
  return line.replace(
    /\bpure(\s+)(?=function\b|async\s+function\b|<[\w\s,=]+>\s*\(|\(|\w+\s*=>)/g,
    (_m, space) => "    " + space,
  );
}

// `expr ..! handler` → `expr.catch(handler)`
// `expr ..& handler` → `expr.finally(handler)`
function transformCatchFinally(line: string): string {
  // Process right-to-left so chaining works: `a ..! b ..& c` → `a.catch(b).finally(c)`
  // Handle ..& first, then ..!
  line = line.replace(/\s*\.\.&\s*(.+?)(?=\s*;|\s*$)/g, (_m, handler) => `.finally(${handler.trim()})`);
  line = line.replace(/\s*\.\.!\s*(.+?)(?=\.finally\(|\s*;|\s*$)/g, (_m, handler) => `.catch(${handler.trim()})`);
  return line;
}

// `x |> f |> g` → `g(f(x))`
function transformPipeline(line: string): string {
  if (!line.includes("|>")) return line;

  // Find contiguous pipeline expressions within assignments or returns.
  // We match the pipeline portion and replace it.
  return line.replace(/((?:=|return|=>)\s*)(.+?\|>.+?)(?=\s*;|\s*$)/g, (_m, prefix, pipeline) => {
    return prefix + collapsePipeline(pipeline);
  });
}

function collapsePipeline(expr: string): string {
  // Split on |> that aren't inside parens/brackets/braces.
  const parts = splitPipeline(expr);
  if (parts.length <= 1) return expr;

  let result = parts[0].trim();
  for (let i = 1; i < parts.length; i++) {
    const fn = parts[i].trim();
    result = `${fn}(${result})`;
  }
  return result;
}

function splitPipeline(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      current += ch;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      current += ch;
    } else if (depth === 0 && ch === "|" && expr[i + 1] === ">") {
      parts.push(current);
      current = "";
      i++; // skip >
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function transformMultilinePipeline(source: string): string {
  if (!source.includes("|>")) return source;

  const lines = source.split("\n");
  const joined: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (trimmed.startsWith("|>") && joined.length > 0) {
      joined[joined.length - 1] += " " + trimmed;
    } else {
      joined.push(lines[i]);
    }
  }

  for (let i = 0; i < joined.length; i++) {
    if (joined[i].includes("|>")) {
      joined[i] = transformPipeline(joined[i]);
    }
  }
  return joined.join("\n");
}
