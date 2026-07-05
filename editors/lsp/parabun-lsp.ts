#!/usr/bin/env parabun
/**
 * Parabun Language Server
 *
 * Provides full TypeScript-level language features (hover, diagnostics,
 * completions, go-to-definition) for .pts/.ptsx/.pjs/.pjsx files by
 * embedding TypeScript's language service and transparently desugaring
 * Parabun syntax before the type checker sees it.
 *
 * Also provides Parabun-specific features: operator hover docs, code
 * actions, semantic tokens for `pure`, and Bun.Transpiler parse errors.
 *
 * Usage:  parabun run parabun-lsp.ts --stdio
 */

// ---------------------------------------------------------------------------
// Dual-mode: same file runs as the LSP main process OR as the tsc helper
// subprocess (depending on the `--tsc-helper` flag). The helper offloads
// `getSemanticDiagnostics` to a separate process so the main LSP's
// event loop stays responsive — hover, completions, parabun fast-pass
// diagnostics all keep working while tsc is mid-validate. Cancellation
// is "implicit by versioning": the main process discards any helper
// response whose document version no longer matches the latest content.
// ---------------------------------------------------------------------------

const HELPER_MODE = process.argv.includes("--tsc-helper");

// ---------------------------------------------------------------------------
// JSON-RPC / LSP message framing
// ---------------------------------------------------------------------------

const HEADER_SEP = "\r\n\r\n";

let inputBuffer = "";

function send(msg: object) {
  const body = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  process.stdout.write(header + body);
}

function sendResponse(id: number | string, result: unknown) {
  send({ jsonrpc: "2.0", id, result });
}

function sendNotification(method: string, params: unknown) {
  send({ jsonrpc: "2.0", method, params });
}

function publishDiagnostics(uri: string, diagnostics: LspDiagnostic[]) {
  sendNotification("textDocument/publishDiagnostics", { uri, diagnostics });
}

function logMessage(type: number, message: string) {
  sendNotification("window/logMessage", { type, message });
}

// ---------------------------------------------------------------------------
// LSP types (minimal subset)
// ---------------------------------------------------------------------------

interface LspDiagnostic {
  range: LspRange;
  severity: number;
  source: string;
  message: string;
  code?: string;
}

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

interface LspPosition {
  line: number;
  character: number;
}

// ---------------------------------------------------------------------------
// Parabun → TypeScript transform (inlined from ts-plugin/transform.ts)
// ---------------------------------------------------------------------------

const PARABUN_SYNTAX_RE =
  /\bmemo\s|\bpure\s|\bfun\b|\bsignal\s+[A-Za-z_$]|\beffect\s*\{|\beffect\s+[A-Za-z_$]|\bprop\s+[A-Za-z_$]|\bderived\s+[A-Za-z_$]|\barena\s*\{|\b(?:parallel|para)\s*\{|\b(?:parallel|para)\s+(?:let|const)\b|\bwhen(?:\s+not)?\s+[!A-Za-z_$]|\bschema\s+[A-Za-z_$]|\bschema\s*\{|\bmatch\s+[A-Za-z_$(]|::\s*[A-Z]|\bis\s+(?:not\s+)?[A-Z]|\.\.=|\.\.!|\.\.&|\|>|~>|(?<![\-=<])->|(?:\|\||&&|\?\??|=>|:)\s*throw\s/;

function containsParabunSyntax(text: string): boolean {
  return PARABUN_SYNTAX_RE.test(text);
}

function transformParabunToTS(source: string): string {
  if (!containsParabunSyntax(source)) return source;
  // Multi-line transforms run before per-line work because `schema X { ... }`
  // and `match e { ... }` span multiple lines.
  source = transformModelDeclBlock(source);
  source = transformSchemaEqualsBlock(source);
  source = transformInlineSchemaExpr(source);
  source = transformThrowExpr(source);
  source = transformMatchBlock(source);
  // String-aware `is`-pattern rewrite at source level (skips matches
  // inside string / template / comment content).
  source = transformIsTypeGuardSource(source);
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    lines[i] = transformLine(lines[i]);
  }
  let result = lines.join("\n");
  result = transformMultilinePipeline(result);
  // Prepend typed `__paraIs_<T>` helpers so TS narrows `if (x is T) { ... }`.
  result = injectIsHelpers(result);
  // Prepend the typed `__paraFromSchema` ambient declaration so
  // `schema X = body` and `schema { ... }` results carry `.parse` /
  // `.is` / `.schema` / field-accessors for tsc.
  result = injectSchemaHelper(result);
  return result;
}

function transformLine(line: string): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("/*")) return line;
  line = expandFun(line);
  line = stripMemo(line);
  line = stripPure(line);
  line = stripValidationMarker(line);
  // `is`-guard rewrite happens at source level (string-aware) before
  // line-splitting, so the per-line pass is skipped to avoid a second
  // rewrite firing inside string content the source pass left alone.
  line = transformModelFromLine(line);
  line = transformSignal(line);
  line = transformEffect(line);
  line = transformProp(line);
  line = transformDerivedDecl(line);
  line = transformArena(line);
  line = transformParallel(line);
  line = transformWhenBlock(line);
  line = transformCatchFinally(line);
  line = transformRbind(line);
  line = transformCallBind(line);
  line = transformPipeline(line);
  return line;
}

// `(req:: User)` → `(req:  User)` — second `:` becomes a space, column-preserving.
function stripValidationMarker(line: string): string {
  return line.replace(/(:):/g, "$1 ");
}

// `expr is Type` / `expr is not Type` → `__paraIs_Type(expr)` /
// `!__paraIs_Type(expr)`. Helpers prepended by `injectIsHelpers` so TS
// narrows `expr` inside `if (...) { ... }` bodies via the `v is T` predicate.
function transformIsTypeGuard(line: string): string {
  line = line.replace(
    /\b([\w$.\[\]()]+)\s+is\s+not\s+([A-Z][\w$]*)\b/g,
    (_m, lhs, type) => `!__paraIs_${type}(${lhs})`,
  );
  line = line.replace(/\b([\w$.\[\]()]+)\s+is\s+([A-Z][\w$]*)\b/g, (_m, lhs, type) => `__paraIs_${type}(${lhs})`);
  return line;
}

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
// (where `<expr>` is NOT an open-brace literal — `transformSchemaEqualsBlock`
// already handled `schema X = { ... }` at whole-source scope). Both
// wrap the rhs in `__paraFromSchema(() => (<expr>))` so tsc sees the
// typed result with `.parse` / `.is` / `.schema` resolved.
function transformModelFromLine(line: string): string {
  // `from` form
  line = line.replace(
    /\b(export\s+)?schema\s+([A-Za-z_$][\w$]*)\s+from\s+(.+?)(\s*;?\s*)$/,
    (_m, exportKw, name, expr, trailing) =>
      `${exportKw ?? ""}const ${name} = __paraFromSchema(() => (${expr}))${trailing}${schemaTypeAlias(exportKw, name)}`,
  );
  // Single-line `=` form, only when the rhs is not an object-literal
  // opening (`transformSchemaEqualsBlock` handled those).
  line = line.replace(
    /\b(export\s+)?schema\s+([A-Za-z_$][\w$]*)\s*=\s*(?!\{)(.+?)(\s*;?\s*)$/,
    (_m, exportKw, name, expr, trailing) =>
      `${exportKw ?? ""}const ${name} = __paraFromSchema(() => (${expr}))${trailing}${schemaTypeAlias(exportKw, name)}`,
  );
  return line;
}

// Emit a TS type alias so a `schema X` declaration is usable in BOTH
// value AND type position: `satisfies PostgresTableModel<X>` works
// without `typeof X`. The alias resolves to `(typeof X)["schema"]`
// — the UNWRAPPED JSON Schema body literal — rather than the full
// `__paraFromSchema` helper return (`{schema, parse, is} & S`).
// Measured on lyku's sharedDrafts.pts: unwrapped form makes tsc
// ~2x faster cold (18.8s → 9.7s) and 1.5-2.2x faster on warm edits
// (1.0-1.7s → 0.55-0.88s), because the helper's `{...} & S`
// intersection forces tsc to walk both sides for every
// `T['properties']` / `keyof T` lookup in heavy generics like
// `PostgresTableModel<S>`. tsc namespaces values and types
// separately so `const X = ...; type X = ...;` coexists. Keep the
// emit semicolon-prefixed + same-line so generated text doesn't
// shift source-line indices that diagnostics use to map back to
// the original .pts file.
function schemaTypeAlias(exportKw: string | undefined, name: string): string {
  return `;${exportKw ?? ""}type ${name} = (typeof ${name})["schema"]`;
}

// `[export ]schema NAME = { ...body... }[ as const][ satisfies T];` →
// `[export ]const NAME = __paraFromSchema(() => ({ ...body... }))[ as const][ satisfies T];`.
// Multi-line and brace-balanced. Strings / comments respected.
function transformSchemaEqualsBlock(source: string): string {
  const re = /\b(export\s+)?schema\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g;
  const out: string[] = [];
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const exportKw = m[1] ?? "";
    const name = m[2];
    const openIdx = m.index + m[0].length - 1;
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

// Prepend an ambient declaration of `__paraFromSchema` to the source
// when any of the schema transforms emitted a call. The return type is
// the JSON Schema literal `S` plus runtime decoration — `.parse` /
// `.is` / `.schema` / field-accessors all resolve at the call site
// without per-file `.d.ts` shims. Wide `S` (no `<const>` type
// parameter) so we don't compound tsc's literal-inference memory
// pressure across hundreds of open endpoint files; narrow types come
// back from the offline `gen-dts-rewrite` pipeline (Phase 1 brand
// codegen sketched in PROPOSALS.md).
// `<trigger> throw E` → `<trigger> (() => { throw E; })()`. Mirrors the
// Zig parser's runtime handling of throw-as-expression. Triggers:
// `||` / `&&` / `??` / `?` (ternary) / `:` / `=>`. `?.` excluded.
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
  const helper =
    `declare function __paraFromSchema<S>(s: () => S): { ` +
    `readonly parse: (v: unknown) => { tag: "Ok"; value: unknown } | { tag: "Err"; error: string }; ` +
    `readonly is: (v: unknown) => boolean; ` +
    `readonly schema: S ` +
    `} & S;`;
  return helper + "\n" + source;
}

// Inline `schema { ... }` expression → `__paraFromSchema(() => ({ ... }))`.
// Wrapping in the typed helper (declared by `injectSchemaHelper`) means
// tsc sees the expression's type as `SchemaShape & body` — `.parse` /
// `.is` / `.schema` / field-accessors resolve at the call site without
// per-file `.d.ts` shims. Brace-balanced; strings/comments skipped so a
// `}` inside a literal can't close the body early.
function transformInlineSchemaExpr(source: string): string {
  const out: string[] = [];
  let i = 0;
  const re = /\bschema\s*\{/g;
  let match: RegExpExecArray | null;
  let lastEnd = 0;
  while ((match = re.exec(source)) !== null) {
    // Skip if inside a comment / string — quick & dirty: walk from the
    // start of the line and check whether the match offset is inside a
    // recognized comment/string region. Cheaper than a full scanner and
    // good enough for the LSP rewrite.
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

// Quick check for "is offset N inside a single/double/backtick string
// or a //- or /*-comment" — by walking from the start of the source.
// Linear in offset, but the LSP only invokes this per regex match so
// total work is bounded by the source length.
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

// `schema X { ... }` (multi-line) → `const X: { parse, schema } = { ... }`.
// We don't try to mirror the field shape — the LSP just needs the binding
// to exist so go-to-def, hover, and member completions on `X.parse` /
// `X.schema` work. The runtime owns the actual codegen. Also emits a
// `type X = { ... }` alias so `if (v is X)` can narrow via the typed
// `__paraIs_X` predicate prepended by `injectIsHelpers`.
// Hybrid rewrite: open `schema NAME {` becomes `type NAME = {`, close `}`
// is augmented with the const decl on the same line. For body lines,
// only TYPE FRAGMENTS that are Para-specific (refinements `int(0..150)`,
// array+bounds `[str](1..=10)`, lowercase aliases `int`/`str`/`bool`/`float`)
// are rewritten to plain TS. Plain TS field types (`number`/`string`/etc.,
// capitalized model refs) pass through verbatim — preserving hover
// positions inside the body for the common pg-models case.
function transformModelDeclBlock(source: string): string {
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

// Per-line rewrite: only changes a line when its TYPE fragment is
// Para-specific. Plain TS types pass through unchanged (preserves
// hover positions for that line).
function rewriteParaFieldLines(body: string): string {
  return body
    .split("\n")
    .map(line => {
      const m = line.match(/^(\s*)([A-Za-z_$][\w$]*)(\??)\s*:\s*(.+?)(\?)?(\s*[,;]?\s*)$/);
      if (!m) return line;
      const [, leadWs, name, prefixOpt, raw, postfixOpt, trail] = m;
      const trimmed = raw.trim();
      const optional = prefixOpt === "?" || postfixOpt === "?";
      // Detect Para-specific syntax: parens (refinement / range), brackets
      // with parens (array+bounds), known Para alias names, or postfix `?`.
      const isParaSpecific =
        /\(/.test(trimmed) ||
        /^\[[A-Za-z_$][\w$]*\]/.test(trimmed) ||
        /^(int|str|bool|float|num|Email|UUID|Url|Date|DateTime|IpV4|IpV6|Slug)$/.test(trimmed) ||
        postfixOpt === "?";
      if (!isParaSpecific) return line;
      const tsType = paraTypeFragmentToTsLsp(trimmed);
      return `${leadWs}${name}${optional ? "?" : ""}: ${tsType}${trail}`;
    })
    .join("\n");
}

function parseModelFieldsForTypeLsp(body: string): { name: string; tsType: string; optional: boolean }[] {
  const out: { name: string; tsType: string; optional: boolean }[] = [];
  const stripped = body.replace(/\/\/[^\n]*/g, "");
  const fieldRe = /([A-Za-z_$][\w$]*)\s*:\s*([^,;\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = fieldRe.exec(stripped)) !== null) {
    let raw = m[2].trim();
    const optional = raw.endsWith("?");
    if (optional) raw = raw.slice(0, -1).trim();
    out.push({ name: m[1], tsType: paraTypeFragmentToTsLsp(raw), optional });
  }
  return out;
}

function paraTypeFragmentToTsLsp(raw: string): string {
  raw = raw.trim();
  if (/^\s*(?:"[^"]*"|\d+(?:\.\d+)?|true|false)/.test(raw)) return raw;
  const arrayMatch = raw.match(/^\[([A-Za-z_$][\w$]*)\](?:\([^)]*\))?$/);
  if (arrayMatch) return `${paraBaseTypeToTsLsp(arrayMatch[1])}[]`;
  const rangeMatch = raw.match(/^([A-Za-z_$][\w$]*)\([^)]*\)$/);
  if (rangeMatch) return paraBaseTypeToTsLsp(rangeMatch[1]);
  return paraBaseTypeToTsLsp(raw);
}

function paraBaseTypeToTsLsp(t: string): string {
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
      return t;
  }
}

// `match EXPR { ... }` → `((__m: any): any => null as any)(EXPR)` so TS sees
// a typed expression. String/comment content is masked first so `match`
// inside string literals (e.g. an English description containing the
// word) doesn't trigger a spurious IIFE rewrite. Match-body close is
// found by depth-balanced scan from the opening `{` — the older regex
// (`[\s\S]*?\n\s*\}`) couldn't terminate a single-line `match e { ... }`
// and swallowed the enclosing function's closing brace, which made
// downstream tsc parse past EOF.
function transformMatchBlock(source: string): string {
  const masked = maskStringsAndComments(source);
  const replacements: { start: number; end: number; replacement: string }[] = [];
  const re = /\bmatch\s+([^{]+?)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = findMatchingBrace(masked, openIdx);
    if (closeIdx < 0) continue;
    const subjStart = m.index + "match".length;
    const subjEnd = m.index + m[0].length - 1;
    const subjOrig = source.slice(subjStart, subjEnd).trim();
    replacements.push({
      start: m.index,
      end: closeIdx + 1,
      replacement: `((__m: any): any => null as any)(${subjOrig})`,
    });
    re.lastIndex = closeIdx + 1;
  }
  if (replacements.length === 0) return source;
  let out = "";
  let cursor = 0;
  for (const r of replacements) {
    out += source.slice(cursor, r.start);
    out += r.replacement;
    cursor = r.end;
  }
  out += source.slice(cursor);
  return out;
}

// Depth-balanced match for `{` at `openIdx` in already-masked source
// (strings/comments blanked so quoted braces don't perturb depth).
// Returns the index of the matching `}` or -1 if not found.
function findMatchingBrace(masked: string, openIdx: number): number {
  let depth = 1;
  for (let i = openIdx + 1; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Source-level `is`-pattern rewrite that skips matches inside string,
// template, or comment content. Replaces `expr is Type` with
// `__paraIs_Type(expr)` and `expr is not Type` with `!__paraIs_Type(expr)`.
function transformIsTypeGuardSource(source: string): string {
  const masked = maskStringsAndComments(source);
  const replacements: { start: number; end: number; replacement: string }[] = [];
  const negRe = /\b([\w$.\[\]()]+)\s+is\s+not\s+([A-Z][\w$]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = negRe.exec(masked)) !== null) {
    const lhs = source.slice(m.index, m.index + m[1].length);
    replacements.push({
      start: m.index,
      end: m.index + m[0].length,
      replacement: `!__paraIs_${m[2]}(${lhs})`,
    });
  }
  const blocked: [number, number][] = replacements.map(r => [r.start, r.end]);
  const overlaps = (s: number) => blocked.some(([a, b]) => s >= a && s < b);
  const re = /\b([\w$.\[\]()]+)\s+is\s+([A-Z][\w$]*)\b/g;
  while ((m = re.exec(masked)) !== null) {
    if (overlaps(m.index)) continue;
    const lhs = source.slice(m.index, m.index + m[1].length);
    replacements.push({
      start: m.index,
      end: m.index + m[0].length,
      replacement: `__paraIs_${m[2]}(${lhs})`,
    });
  }
  if (replacements.length === 0) return source;
  replacements.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const r of replacements) {
    out += source.slice(cursor, r.start);
    out += r.replacement;
    cursor = r.end;
  }
  out += source.slice(cursor);
  return out;
}

// Replace string-literal and comment content with same-length blanks so
// regex passes can't fire inside them. Newlines + quote chars preserved
// so position-anchored scans still work.
function maskStringsAndComments(source: string): string {
  let masked = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      masked += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      const span = source.slice(i, stop);
      masked += span.replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < source.length) {
        const c = source[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === quote) {
          j++;
          break;
        }
        j++;
      }
      let blanked = quote;
      for (let k = i + 1; k < j - 1; k++) blanked += source[k] === "\n" ? "\n" : " ";
      blanked += source[j - 1] === quote ? quote : " ";
      masked += blanked;
      i = j;
      continue;
    }
    masked += ch;
    i++;
  }
  return masked;
}

// `A ~> B` → `A = B` (column-preserving: both `~>` and `= ` are 2 chars).
// TS then sees an assignment between two references, which is enough for
// identifier resolution, hover, and go-to-def. The direction is reversed
// compared to the real desugar (`B = A`), but TS doesn't care about that
// for symbol lookup, and we avoid rewriting A/B positions in a regex pass.
function transformRbind(line: string): string {
  return line.replace(/~>/g, "= ");
}

// `A -> fn` → `A , fn` (column-preserving: both `->` and `, ` are 2 chars).
// TS sees a comma expression between two references — enough for identifier
// resolution, hover, and go-to-def on both sides. Negative lookbehind keeps
// `-->` (post-decrement followed by `>`), `=>` (arrow), and `<-` from
// matching.
function transformCallBind(line: string): string {
  return line.replace(/(?<![\-=<])->/g, ", ");
}

// `signal NAME = RHS` → `let    NAME = RHS`. The `signal` keyword is replaced
// with `let   ` (3 chars + 3 spaces = 6, matching `signal`'s 6 chars) so every
// column after the keyword stays at its original position — hover, go-to-def,
// and diagnostic ranges all still map 1:1. `let` rather than `const` because
// Parabun rewrites `NAME = x` / `NAME++` to `.set()` calls at parse time, so
// those mutations must not trip TS's const-reassignment check.
function transformSignal(line: string): string {
  return line.replace(/\b(signal)\b(?=\s+[A-Za-z_$][\w$]*\s*[=,;:!])/g, "let   ");
}

// `effect { body }` → `      { body }` — six spaces replace `effect`, leaving
// a bare block statement that TypeScript accepts. Column positions inside
// the body are unchanged. Only triggers when `effect` is immediately before
// `{` (same line) — other uses of `effect` as an identifier are untouched.
// Blank `effect` (6 → six spaces, column-preserving) in BOTH forms:
// block `effect {` and single-statement `effect EXPR;`. Same
// disambiguation as the parser/grammar — `effect(` `effect.` `effect[`
// `effect=` `effect:` `effect;` keep `effect` as a plain identifier.
function transformEffect(line: string): string {
  return line.replace(/\b(effect)\b(?=\s*\{|\s+[A-Za-z_$])/g, "      ");
}

// `prop NAME …` → `let  NAME …` — `prop` (4) ↔ `let ` (4), column-preserving.
// One `prop` may declare several comma-separated declarators
// (`prop a: T = '', b = 3`); `let` accepts that declarator list verbatim,
// so the fast-pass parser is satisfied without re-implementing the merge
// (the real `$props()` fold is owned by para-preprocess / pui-transform).
function transformProp(line: string): string {
  return line.replace(/\b(prop)\b(?=\s+[A-Za-z_$])/g, "let ");
}

// Single-line `derived NAME = EXPR` → `let     NAME = EXPR` — `derived` (7)
// ↔ `let    ` (7), mirroring transformSignal. The lookahead's `[=,;:!]`
// excludes the block form `derived NAME { … }` (brace, not in the class),
// which the fast-pass parser still can't parse — tracked as drift debt
// alongside the structural unification (see LYK ticket).
function transformDerivedDecl(line: string): string {
  return line.replace(/\b(derived)\b(?=\s+[A-Za-z_$][\w$]*\s*[=,;:!])/g, "let    ");
}

// `arena { body }` → `     { body }` — five spaces replace `arena`, same
// column-preserving trick as transformEffect.
function transformArena(line: string): string {
  return line.replace(/\b(arena)\b(?=\s*\{)/g, "     ");
}

// `parallel { … }` / `parallel let|const NAME …` (and `para` shorthand) →
// blank out the keyword (replacing each char with a space) so TypeScript sees
// a bare object literal or a normal `let|const` declaration. Column positions
// on the rest of the line stay stable for hover / go-to-def.
function transformParallel(line: string): string {
  // Statement form: keep `let|const` so TS still sees a declaration.
  line = line.replace(/\b(parallel|para)(\s+)(?=let|const)/g, (_m, kw, space) => " ".repeat(kw.length) + space);
  // Expression form: hand TS a bare `{ … }` — fine in expression position.
  line = line.replace(/\b(parallel|para)\b(?=\s*\{)/g, (_m, kw) => " ".repeat(kw.length));
  return line;
}

// `when EXPR { body }` → `if  (EXPR) { body }`
// `when not EXPR { body }` → `if      (!(EXPR)) { body }`
// `when not { body }` (bare paired form) → `else     { body }`
//
// Column-preserving rewrites that give TS a normal `if`/`else` shape so the
// embedded TypeScript checker doesn't choke on the surface syntax. The paired
// `when not { … }` lands as `else { … }` so it attaches to the preceding
// transformed `if` — readers still get sensible hover / TS diagnostics. The
// actual desugar is owned by the parser (→ require("@lyku/para-signals").when(...)
// with the predicate negated for the `not` form); this transform is a TS-side
// shim only.
function transformWhenBlock(line: string): string {
  // Bare paired form first — `when not` followed directly by `{` (no
  // predicate). 8 chars `when not` ↔ 8 chars `else    `, brace column held.
  line = line.replace(/\bwhen\s+not(\s*\{)/g, (_m, brace) => `else    ${brace}`);
  // Negated form with predicate.
  line = line.replace(/\bwhen\s+not\s+(.+?)(\s*\{)/g, (_m, expr, brace) => `if      (!(${expr}))${brace}`);
  // Plain form with predicate.
  line = line.replace(/\bwhen\s+(.+?)(\s*\{)/g, (_m, expr, brace) => `if  (${expr})${brace}`);
  return line;
}

function expandFun(line: string): string {
  return line.replace(/(?<!\.)(\bfun)\b(?=\s*[a-zA-Z_$*(<])/g, "function");
}

function stripPure(line: string): string {
  return line.replace(
    /\bpure(\s+)(?=function\b|async\s+function\b|<[\w\s,=]+>\s*\(|\(|\w+\s*=>)/g,
    (_m, space) => "    " + space,
  );
}

// Statement form: `memo name(` → `function name(` and `memo async name(` →
// `async function name(`. TS needs a real `function` keyword to parse the
// declaration. This shifts the declaration line's columns right by 4 — hover
// on the body (different lines) is unaffected.
//
// Arrow/expression form: `memo (...) =>`, `memo x =>`, `memo async ...`, and
// `memo <T>(...)` — `memo` is replaced by 4 spaces so TS just sees the bare
// arrow. Column-preserving, so hover/go-to-def lands on the right span.
function stripMemo(line: string): string {
  line = line.replace(
    /\bmemo(\s+)async(\s+)(?=[A-Za-z_$][\w$]*\s*(?:<|\())/g,
    (_m, s1, s2) => `async${s1}function${s2}`,
  );
  // Negative lookahead on `async` keeps `memo async (k) =>` out of the
  // stmt-form path (where it would get rewritten as `function async (...)`);
  // the arrow-form pass below handles it.
  line = line.replace(/\bmemo(\s+)(?!async\b)(?=[A-Za-z_$][\w$]*\s*(?:<|\())/g, (_m, s) => `function${s}`);
  line = line.replace(
    /\bmemo(\s+)(?=\(|[A-Za-z_$][\w$]*\s*=>|async\s+(?:\(|[A-Za-z_$][\w$]*\s*=>)|<[\w\s,=]+>\s*\()/g,
    (_m, s) => `    ${s}`,
  );
  return line;
}

function transformCatchFinally(line: string): string {
  line = line.replace(/\s*\.\.&\s*(.+?)(?=\s*;|\s*$)/g, (_m, handler) => `.finally(${handler.trim()})`);
  line = line.replace(/\s*\.\.!\s*(.+?)(?=\.finally\(|\s*;|\s*$)/g, (_m, handler) => `.catch(${handler.trim()})`);
  return line;
}

function transformPipeline(line: string): string {
  if (!line.includes("|>")) return line;
  return line.replace(
    /((?:=|return|=>)\s*)(.+?\|>.+?)(?=\s*;|\s*$)/g,
    (_m, prefix, pipeline) => prefix + collapsePipeline(pipeline),
  );
}

function collapsePipeline(expr: string): string {
  const parts = splitPipeline(expr);
  if (parts.length <= 1) return expr;
  let result = parts[0].trim();
  for (let i = 1; i < parts.length; i++) {
    result = `${parts[i].trim()}(${result})`;
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
      i++;
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

// ---------------------------------------------------------------------------
// Transpiler instances (for Parabun-specific parse diagnostics)
// ---------------------------------------------------------------------------

const transpilers = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
  js: new Bun.Transpiler({ loader: "jsx" }),
};

function loaderForUri(uri: string): "ts" | "tsx" | "js" {
  if (isComponentUri(uri)) {
    const lang = svelteLangs.get(uri);
    if (lang === "pjs") return "js";
    return "ts";
  }
  if (uri.endsWith(".pts") || uri.endsWith(".ts")) return "ts";
  if (uri.endsWith(".ptsx") || uri.endsWith(".tsx")) return "tsx";
  return "js";
}

// ---------------------------------------------------------------------------
// Document store
// ---------------------------------------------------------------------------

const documents = new Map<string, string>();
const docVersions = new Map<string, number>();

// ---------------------------------------------------------------------------
// Svelte embedded-script translation
// ---------------------------------------------------------------------------
//
// When a .svelte file is opened we extract `<script lang="pts|parabun|pjs|
// ptsx|pjsx">` regions and replace everything else (HTML/template/CSS) with
// blank-but-line-preserving padding — characters become spaces, newlines stay.
// The resulting synthetic source has the same line/column shape as the
// original .svelte, so diagnostics generated against it land on the correct
// file positions with zero coordinate math.
//
// `svelteLangs` tracks the dominant flavor so loaderForUri / toTsPath can
// pick TS vs TSX. The TS service sees the synthetic source under a virtual
// `<file>.svelte.ts` (or .tsx) path.

// JSX flavors (ptsx/pjsx) are intentionally omitted — Svelte's template
// language IS its JSX-equivalent; the `<script>` block holds logic, not
// markup, so a JSX-flavored script in a .svelte file would be confusing
// even if technically parseable. React-flavored parabun goes in .ptsx/.pjsx
// files, not embedded in .svelte.
type SvelteScriptLang = "pts" | "pjs";
const svelteLangs = new Map<string, SvelteScriptLang>();
// Original .svelte/.pui source text, kept alongside the synthetic version
// in `documents` so template-level diagnostics (unclosed tags, malformed
// attributes) can scan the as-authored markup rather than the blank-padded
// synthetic that the parabun parser sees.
const svelteRawTexts = new Map<string, string>();

// `.svelte` and `.pui` are both claimed. The difference is the script-lang
// filter inside: `.svelte` requires an explicit parabun-flavored lang
// attribute (pts/parabun/pjs); `.pui` treats the file extension itself as
// the parabun marker, so bare `<script>` and `<script lang="ts">` blocks also
// engage. See `extractParabunScripts`.
function isComponentUri(uri: string): boolean {
  return uri.endsWith(".svelte") || uri.endsWith(".pui");
}

function isPuiUri(uri: string): boolean {
  return uri.endsWith(".pui");
}

const PARABUN_SCRIPT_LANGS = new Set<string>(["pts", "parabun", "pjs"]);
// Plain-language attributes that engage the parabun pipeline only inside
// `.pui` files. `<script>` with no lang or `<script lang="ts">` in a
// `.pui` is parabun by virtue of the file extension.
const PUI_IMPLICIT_LANGS = new Set<string>(["", "ts", "typescript", "js", "javascript"]);

function normalizeSvelteLang(raw: string): SvelteScriptLang {
  const l = raw.toLowerCase();
  if (l === "pjs" || l === "js" || l === "javascript") return "pjs";
  return "pts";
}

interface SvelteScriptBlock {
  start: number;
  end: number;
  lang: SvelteScriptLang;
}

/**
 * Build a quick lookup of `<!-- ... -->` comment ranges so we can skip
 * `<script>` tags that appear inside markup comments (template documentation,
 * commented-out blocks, etc.).
 */
function htmlCommentRanges(svelteText: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let i = 0;
  while (i < svelteText.length) {
    const start = svelteText.indexOf("<!--", i);
    if (start === -1) break;
    const end = svelteText.indexOf("-->", start + 4);
    if (end === -1) {
      out.push([start, svelteText.length]);
      break;
    }
    out.push([start, end + 3]);
    i = end + 3;
  }
  return out;
}

function isInsideRanges(pos: number, ranges: Array<[number, number]>): boolean {
  for (const [s, e] of ranges) if (pos >= s && pos < e) return true;
  return false;
}

function extractParabunScripts(svelteText: string, isPui: boolean): SvelteScriptBlock[] {
  const blocks: SvelteScriptBlock[] = [];
  const comments = htmlCommentRanges(svelteText);
  const re = /<script\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svelteText)) !== null) {
    if (isInsideRanges(m.index, comments)) continue;
    const attrs = m[1] ?? "";
    const langMatch = attrs.match(/\blang\s*=\s*(?:"([^"]*)"|'([^']*)'|([\w-]+))/);
    const langAttr = (langMatch?.[1] ?? langMatch?.[2] ?? langMatch?.[3] ?? "").toLowerCase();
    const accepted = PARABUN_SCRIPT_LANGS.has(langAttr) || (isPui && PUI_IMPLICIT_LANGS.has(langAttr));
    if (!accepted) continue;
    const contentStart = m.index + m[0].length;
    // Svelte disallows `</script>` inside script content, so the simple
    // terminator scan is safe.
    const closeIdx = svelteText.indexOf("</script>", contentStart);
    if (closeIdx === -1) continue;
    blocks.push({
      start: contentStart,
      end: closeIdx,
      lang: normalizeSvelteLang(langAttr),
    });
  }
  return blocks;
}

// Length-preserving blank of everything OUTSIDE parabun <script> bodies
// (markup, style, non-parabun scripts) — newlines kept so line/column
// offsets into the result equal those into the original. Used by the
// fast undefined-identifier scan for `.pui` so it only sees real script
// code. If there is no parabun script, the whole thing blanks.
function maskOutsideParabunScripts(content: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  const blocks = extractParabunScripts(content, true);
  if (blocks.length === 0) return blank(content);
  let out = "";
  let pos = 0;
  for (const b of blocks) {
    out += blank(content.slice(pos, b.start));
    out += content.slice(b.start, b.end);
    pos = b.end;
  }
  out += blank(content.slice(pos));
  return out;
}

function synthesizeFromSvelte(
  svelteText: string,
  isPui: boolean,
): { source: string; lang: SvelteScriptLang } | undefined {
  const blocks = extractParabunScripts(svelteText, isPui);
  if (blocks.length === 0) return undefined;
  const lang = blocks[0]!.lang;

  const out: string[] = new Array(svelteText.length);
  let bIdx = 0;
  for (let i = 0; i < svelteText.length; i++) {
    while (bIdx < blocks.length && i >= blocks[bIdx]!.end) bIdx++;
    const b = blocks[bIdx];
    const inside = b !== undefined && i >= b.start && i < b.end;
    const ch = svelteText[i]!;
    if (inside) out[i] = ch;
    else out[i] = ch === "\n" || ch === "\r" ? ch : " ";
  }
  return { source: out.join(""), lang };
}

/**
 * Store an opened/changed document. For .svelte and .pui URIs, extracts
 * parabun script blocks into a line-preserving synthetic source; for other
 * URIs the text is stored verbatim. Returns the stored content, or
 * `undefined` if the file is a .svelte/.pui without any parabun script
 * blocks (and therefore not analyzed).
 */
function ingestDocumentText(uri: string, text: string): string | undefined {
  if (isComponentUri(uri)) {
    const isPui = isPuiUri(uri);
    // Keep raw markup so template-well-formedness checks have something to
    // scan, even when no parabun script blocks engage.
    svelteRawTexts.set(uri, text);
    const syn = synthesizeFromSvelte(text, isPui);
    if (syn) {
      documents.set(uri, syn.source);
      svelteLangs.set(uri, syn.lang);
      return syn.source;
    }
    // No closed parabun-flavored blocks. We still claim the URI if:
    //   - It's `.pui` (extension is the marker; emit template-level
    //     diagnostics even when there's no script content).
    //   - It's `.svelte` with an *unclosed* parabun-flavored `<script>` —
    //     so the user sees a "missing </script>" diagnostic from the
    //     fast pass rather than silent failure.
    const wellFormednessIssues = findTemplateWellFormednessIssues(text, isPui);
    if (isPui || wellFormednessIssues.length > 0) {
      documents.set(uri, "");
      svelteLangs.delete(uri);
      return "";
    }
    documents.delete(uri);
    svelteLangs.delete(uri);
    svelteRawTexts.delete(uri);
    return undefined;
  }
  documents.set(uri, text);
  return text;
}

/**
 * Detect unclosed parabun-flavored `<script>` tags in the raw .svelte /
 * .pui source. v1 only catches missing `</script>`; balanced attribute
 * quotes, matched `{expression}` braces, and unknown `{#weird}` directives
 * are explicit follow-up scope (see LYK-840 DoD).
 */
function findTemplateWellFormednessIssues(rawText: string, isPui: boolean): LspDiagnostic[] {
  const diagnostics: LspDiagnostic[] = [];
  const comments = htmlCommentRanges(rawText);
  const re = /<script\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rawText)) !== null) {
    if (isInsideRanges(m.index, comments)) continue;
    const attrs = m[1] ?? "";
    const langMatch = attrs.match(/\blang\s*=\s*(?:"([^"]*)"|'([^']*)'|([\w-]+))/);
    const langAttr = (langMatch?.[1] ?? langMatch?.[2] ?? langMatch?.[3] ?? "").toLowerCase();
    const isParabunFlavored = PARABUN_SCRIPT_LANGS.has(langAttr) || (isPui && PUI_IMPLICIT_LANGS.has(langAttr));
    if (!isParabunFlavored) continue;
    const closeIdx = rawText.indexOf("</script>", m.index + m[0].length);
    if (closeIdx === -1) {
      const startPos = offsetToPosition(rawText, m.index);
      const endPos = offsetToPosition(rawText, m.index + m[0].length);
      diagnostics.push({
        range: { start: startPos, end: endPos },
        severity: 1,
        source: "parabun",
        message: "Unclosed <script> tag: missing </script>",
      });
    }
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Style block extraction + CSS validation
// ---------------------------------------------------------------------------
//
// `<style lang="...">` blocks inside `.svelte` and `.pui` files get
// dispatched to vscode-css-languageservice (the same library Svelte's LSP
// and VSCode's HTML extension use). Each block's content is run through
// the matching service (CSS/SCSS/Less) and diagnostics are offset from the
// block-local coordinates back to file-global ones.

type StyleLang = "css" | "scss" | "less" | "sass";

interface StyleBlock {
  start: number;
  end: number;
  lang: StyleLang;
}

function extractStyleBlocks(svelteText: string): StyleBlock[] {
  const blocks: StyleBlock[] = [];
  const comments = htmlCommentRanges(svelteText);
  const re = /<style\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svelteText)) !== null) {
    if (isInsideRanges(m.index, comments)) continue;
    const attrs = m[1] ?? "";
    const langMatch = attrs.match(/\blang\s*=\s*(?:"([^"]*)"|'([^']*)'|([\w-]+))/);
    const langRaw = (langMatch?.[1] ?? langMatch?.[2] ?? langMatch?.[3] ?? "css").toLowerCase();
    // css/scss/less validated by vscode-css-languageservice; sass (indented)
    // routed through dart-sass since the css service can't parse indented
    // syntax. postcss and stylus would need separate parsers — skip them
    // rather than misclassify as CSS and emit spurious diagnostics.
    let lang: StyleLang;
    if (langRaw === "scss") lang = "scss";
    else if (langRaw === "less") lang = "less";
    else if (langRaw === "sass") lang = "sass";
    else if (langRaw === "css" || langRaw === "" || langRaw === "postcss") lang = "css";
    else continue;
    const contentStart = m.index + m[0].length;
    const closeIdx = svelteText.indexOf("</style>", contentStart);
    if (closeIdx === -1) continue;
    blocks.push({ start: contentStart, end: closeIdx, lang });
  }
  return blocks;
}

// Lazy-cached singleton services. `vscode-css-languageservice` services
// are stateless across documents — same instance can validate any number
// of style blocks.
let cssLsp: any | undefined;
let cssService: any | undefined;
let scssService: any | undefined;
let lessService: any | undefined;
let textDocumentCtor: any | undefined;

let sassModule: any | undefined;

// LYK-880 Slice B: `.pui` → typed-TSX + sourcemap mapper, bundled to a
// single self-contained module (svelte2tsx + svelte + @lyku/para-preprocess
// + trace-mapping inlined) and required like cssLsp. Per-uri+version cached
// since svelte2tsx is not cheap.
let puiTransformMod: { puiTransform: (raw: string, filename: string) => any } | null | undefined;
const puiCache = new Map<string, { version: string; t: any }>();

function getPuiTransform(uri: string, raw: string): any | undefined {
  if (puiTransformMod === undefined) {
    try {
      puiTransformMod = require("parabun-pui-transform");
    } catch (e: any) {
      logMessage(2, `[parabun-lsp] parabun-pui-transform unavailable: ${e?.message ?? e}`);
      puiTransformMod = null;
    }
  }
  if (!puiTransformMod) return undefined;
  const version = String(docVersions.get(uri) ?? 0);
  const hit = puiCache.get(uri);
  if (hit && hit.version === version) return hit.t;
  try {
    const t = puiTransformMod.puiTransform(raw, uriToPath(uri));
    puiCache.set(uri, { version, t });
    return t;
  } catch (e: any) {
    logMessage(2, `[parabun-lsp] puiTransform failed for ${uri}: ${e?.message ?? e}`);
    return undefined;
  }
}

// LYK-880 Slice B Inc 3: resolve an LSP (line,character) in a source doc to
// the TS-service { fileName, offset } to query, abstracting the .pui
// (svelte2tsx + sourcemap) vs .pts/.svelte (line-heuristic) split. `pui`
// is set when the doc is a .pui so callers can map result spans back via
// pui.toOriginal.
function resolveTsQuery(
  uri: string,
  content: string,
  line: number,
  character: number,
): { fileName: string; offset: number; pui?: any } {
  const fileName = toTsPath(uriToPath(uri));
  if (isPuiUri(uri)) {
    const raw = svelteRawTexts.get(uri);
    const t = raw !== undefined ? getPuiTransform(uri, raw) : undefined;
    if (t) {
      const g = t.toGenerated(line, character) ?? { line, character: 0 };
      return { fileName, offset: positionToOffset(t.code, g.line, g.character), pui: t };
    }
  }
  const transformed = transformParabunToTS(content);
  const mp = mapPositionToTransformed(content, transformed, line, character);
  return { fileName, offset: positionToOffset(transformed, mp.line, mp.character) };
}

function getCssService(lang: "css" | "scss" | "less"): any | undefined {
  if (cssLsp === undefined) {
    try {
      cssLsp = require("vscode-css-languageservice");
      textDocumentCtor = require("vscode-languageserver-textdocument").TextDocument;
    } catch (e: any) {
      logMessage(2, `[parabun-lsp] vscode-css-languageservice not available: ${e?.message ?? e}`);
      cssLsp = null;
      return undefined;
    }
  }
  if (!cssLsp) return undefined;
  if (lang === "scss") return (scssService ??= cssLsp.getSCSSLanguageService());
  if (lang === "less") return (lessService ??= cssLsp.getLESSLanguageService());
  return (cssService ??= cssLsp.getCSSLanguageService());
}

function getSassModule(): any | undefined {
  if (sassModule === undefined) {
    try {
      sassModule = require("sass");
    } catch (e: any) {
      logMessage(2, `[parabun-lsp] sass (dart-sass) not available: ${e?.message ?? e}`);
      sassModule = null;
    }
  }
  return sassModule || undefined;
}

/**
 * Validate an indented-sass block via dart-sass. Strip `@use` / `@import` /
 * `@forward` first (replace with spaces, line-preserving) so isolated style
 * blocks don't blow up trying to resolve workspace stylesheets. Sass throws
 * on the first error rather than collecting all, so we emit one diagnostic
 * per parse attempt — acceptable v1.
 */
function validateSass(
  content: string,
): Array<{ line: number; col: number; endLine: number; endCol: number; message: string }> {
  const sass = getSassModule();
  if (!sass) return [];
  const stripped = content.replace(
    /^(\s*)(@(?:use|import|forward)\b[^\n]*)$/gm,
    (_full, ws, stmt) => ws + " ".repeat(stmt.length),
  );
  try {
    sass.compileString(stripped, { syntax: "indented", quietDeps: true });
    return [];
  } catch (e: any) {
    if (e?.span) {
      return [
        {
          line: e.span.start?.line ?? 0,
          col: e.span.start?.column ?? 0,
          endLine: e.span.end?.line ?? e.span.start?.line ?? 0,
          endCol: e.span.end?.column ?? (e.span.start?.column ?? 0) + 1,
          message: e.sassMessage ?? e.message ?? String(e),
        },
      ];
    }
    return [];
  }
}

function computeStyleDiagnostics(uri: string): LspDiagnostic[] {
  if (!isComponentUri(uri)) return [];
  const raw = svelteRawTexts.get(uri);
  if (!raw) return [];
  const blocks = extractStyleBlocks(raw);
  if (blocks.length === 0) return [];

  const diagnostics: LspDiagnostic[] = [];
  for (const block of blocks) {
    const content = raw.slice(block.start, block.end);
    const blockStartPos = offsetToPosition(raw, block.start);

    // dart-sass for indented syntax.
    if (block.lang === "sass") {
      for (const d of validateSass(content)) {
        const startLine = blockStartPos.line + d.line;
        const startChar = d.line === 0 ? blockStartPos.character + d.col : d.col;
        const endLine = blockStartPos.line + d.endLine;
        const endChar = d.endLine === 0 ? blockStartPos.character + d.endCol : d.endCol;
        diagnostics.push({
          range: {
            start: { line: startLine, character: startChar },
            end: { line: endLine, character: endChar },
          },
          severity: 1,
          source: "css(sass)",
          message: d.message,
        });
      }
      continue;
    }

    // css/scss/less via vscode-css-languageservice.
    const service = getCssService(block.lang);
    if (!service || !textDocumentCtor) continue;

    const doc = textDocumentCtor.create(`memory://${block.lang}.${block.lang}`, block.lang, 1, content);
    let stylesheet: any;
    try {
      stylesheet = service.parseStylesheet(doc);
    } catch (e: any) {
      logMessage(2, `[parabun-lsp] css parse failed: ${e?.message ?? e}`);
      continue;
    }
    const cssDiags: any[] = service.doValidation(doc, stylesheet) ?? [];

    for (const d of cssDiags) {
      const startLine = blockStartPos.line + d.range.start.line;
      const startChar =
        d.range.start.line === 0 ? blockStartPos.character + d.range.start.character : d.range.start.character;
      const endLine = blockStartPos.line + d.range.end.line;
      const endChar = d.range.end.line === 0 ? blockStartPos.character + d.range.end.character : d.range.end.character;
      diagnostics.push({
        range: {
          start: { line: startLine, character: startChar },
          end: { line: endLine, character: endChar },
        },
        severity: d.severity ?? 1,
        source: `css(${block.lang})`,
        message: d.message,
      });
    }
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// TypeScript language service
// ---------------------------------------------------------------------------

let ts: typeof import("typescript") | undefined;
let tsService: import("typescript").LanguageService | undefined;
let workspaceRoot = "";

function uriToPath(uri: string): string {
  if (uri.startsWith("file://")) {
    return decodeURIComponent(uri.slice(7));
  }
  return uri;
}

function pathToUri(filePath: string): string {
  // Must be the exact inverse of uriToPath (decodeURIComponent) for the
  // chars VS Code percent-encodes, so document-map lookups round-trip.
  // `encodeURI` leaves the RFC-3986 sub-delims (`! $ & ' ( ) * + , ; = :
  // ? @`) and `#` literal, but VS Code (vscode-uri) percent-encodes them
  // all. Any of these in a path broke the roundtrip: docs were keyed
  // under the client's `%XX…` URI while getScriptSnapshot looked them up
  // via the literal form → miss → the projected file never entered the TS
  // program → every hover/definition/diagnostic failed "Could not find
  // source file". This bit SvelteKit route files hard: `+page`/`+layout`/
  // `+server` (`+`→`%2B`) and dynamic/named segments like `@[username]`
  // (`@`→`%40`). Encode the full sub-delim set so the output is byte-
  // identical to vscode-uri. No client-facing URI changes
  // (publishDiagnostics still uses the original URI).
  return (
    "file://" +
    encodeURI(filePath).replace(/[#$&+,:;=?@!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase())
  );
}

/** Get document content: prefer open document, fall back to disk */
function getDocContent(uri: string): string | undefined {
  const content = documents.get(uri);
  if (content !== undefined) return content;
  try {
    const filePath = uriToPath(uri);
    const text = require("fs").readFileSync(filePath, "utf8") as string;
    // Cache it so subsequent requests within the same session work
    documents.set(uri, text);
    docVersions.set(uri, 1);
    return text;
  } catch {
    return undefined;
  }
}

// TypeScript rejects files with unknown extensions. Present .pts/.ptsx
// files as .ts/.tsx so the language service will process them. .svelte and
// .pui files with parabun script blocks become `<file>.svelte.ts` (or
// .pui.ts) so the TS service treats them as a normal source file while
// we keep the original URI for client communication.
function toTsPath(filePath: string): string {
  if (filePath.endsWith(".pui")) {
    // .pui goes through puiTransform → svelte2tsx, which emits TSX
    // (svelteHTML.createElement(...)); present it as .tsx so the TS
    // service parses JSX. (.svelte keeps its existing .ts/.js path.)
    return filePath + ".tsx";
  }
  if (filePath.endsWith(".svelte")) {
    const lang = svelteLangs.get(pathToUri(filePath));
    if (lang === "pjs") return filePath + ".js";
    return filePath + ".ts";
  }
  if (filePath.endsWith(".pts")) return filePath.slice(0, -4) + ".ts";
  if (filePath.endsWith(".ptsx")) return filePath.slice(0, -5) + ".tsx";
  if (filePath.endsWith(".pjs")) return filePath.slice(0, -4) + ".js";
  if (filePath.endsWith(".pjsx")) return filePath.slice(0, -5) + ".jsx";
  return filePath;
}

function fromTsPath(tsPath: string): string {
  // Svelte/pui virtual paths: `<file>.svelte.<ext>` / `<file>.pui.<ext>`
  // → original. Match before generic .ts/.tsx rules so foo.svelte.ts /
  // foo.pui.ts are recognized as component files rather than stand-alones.
  const componentMatch = tsPath.match(/^(.*\.(?:svelte|pui))\.(tsx|ts|js)$/);
  if (componentMatch) {
    const componentPath = componentMatch[1]!;
    // Map back when the component is OPEN *or* exists on disk. The
    // on-disk case is essential for CLOSED imported `.pui`/`.svelte`:
    // resolveModuleNameLiterals resolves `./X.pui` → `X.pui.tsx`, and
    // getScriptSnapshot must see it as a component (isPuiUri) to serve
    // the svelte2tsx projection. Open-only here meant a closed import
    // fell through, isPuiUri was false, snapshot undefined → TS2307
    // and importers lost real $props() (verified: .pui7-probe).
    // `<x>.pui.tsx` is never a real user file, so disk-check is safe.
    if (documents.has(pathToUri(componentPath)) || require("fs").existsSync(componentPath)) {
      return componentPath;
    }
  }
  const fs = require("fs");
  // Check if the original .pts/.ptsx/.pjs/.pjsx exists for this virtual path
  const extMap: [string, string][] = [
    [".ts", ".pts"],
    [".tsx", ".ptsx"],
    [".js", ".pjs"],
    [".jsx", ".pjsx"],
  ];
  for (const [tsExt, pbExt] of extMap) {
    if (tsPath.endsWith(tsExt) && !tsPath.endsWith(".d.ts")) {
      const pbPath = tsPath.slice(0, -tsExt.length) + pbExt;
      if (documents.has(pathToUri(pbPath))) return pbPath;
      try {
        if (fs.statSync(pbPath).isFile()) return pbPath;
      } catch {}
    }
  }
  return tsPath;
}

function initTypeScriptService() {
  if (!workspaceRoot) return;

  // Search order:
  //   1. workspace root — pick up the user's pinned typescript so .pts
  //      files in their project see the same lib & strictness they
  //      configured for tsc.
  //   2. directory containing this LSP script — when the VS Code
  //      extension bundles a typescript copy, it lives here. Without
  //      this fallback, users whose workspace has no typescript dep
  //      saw "type features disabled" and zero diagnostics.
  //   3. plain `require("typescript")` — global / parent-of-cwd
  //      resolutions, last-resort.
  const nodePath = require("path");
  const lspDir = nodePath.dirname(__filename);
  for (const root of [workspaceRoot, lspDir]) {
    try {
      const tsPath = require.resolve("typescript", { paths: [root] });
      ts = require(tsPath);
      break;
    } catch {}
  }
  if (!ts) {
    try {
      ts = require("typescript");
    } catch {
      logMessage(
        2,
        "[parabun-lsp] TypeScript not found — type features disabled. Install typescript in your workspace.",
      );
      return;
    }
  }

  logMessage(3, `[parabun-lsp] TypeScript ${ts!.version} loaded`);

  const DEFAULT_OPTS: import("typescript").CompilerOptions = {
    target: ts!.ScriptTarget.ESNext,
    module: ts!.ModuleKind.ESNext,
    moduleResolution: ts!.ModuleResolutionKind.Bundler,
    strict: true,
    esModuleInterop: true,
    jsx: ts!.JsxEmit.ReactJSX,
    noEmit: true,
    skipLibCheck: true,
    allowJs: true,
  };

  // Per-file project resolution. The previous code resolved ONE tsconfig
  // from the workspace root — wrong in a monorepo: a `.pui`/.svelte in
  // apps/webui needs apps/webui/tsconfig.json (extends
  // .svelte-kit/tsconfig.json → $app/$lib/$env/$types paths, the @lyku/*
  // paths, svelte-shims, vite/client). It also discarded the tsconfig's
  // resolved `fileNames`, so even the right config wouldn't pull the
  // SvelteKit/Svelte ambient .d.ts (.svelte-kit/ambient.d.ts, $types,
  // src/app.d.ts) into the program. Both are fixed here: resolve the
  // tsconfig NEAREST each file, parse with the tsconfig's OWN dir as
  // basePath (so include/paths/baseUrl resolve correctly), and surface
  // its ambient fileNames to the program. Cached per tsconfig path.
  type Project = { options: import("typescript").CompilerOptions; ambients: string[] };
  const projectCache = new Map<string, Project>();
  // svelte2tsx emits TSX that references Svelte/JSX globals
  // (__sveltets_*, the `svelteHTML` JSX namespace, `Component`, etc.).
  // SvelteKit projects pull these transitively via .svelte-kit/tsconfig;
  // a plain Vite+Svelte project (no SvelteKit) does NOT, so the projected
  // `.pui` TSX would be riddled with phantom "Cannot find name" errors.
  // Add svelte2tsx's own shims as ambient roots for EVERY project (the
  // v4 variants cover Svelte 5 / runes). svelte-language-server does the
  // same; the declarations are guarded so SvelteKit projects that also
  // see them don't double-declare. Resolved once.
  const svelteShims: string[] = (() => {
    const out: string[] = [];
    for (const f of ["svelte2tsx/svelte-shims-v4.d.ts", "svelte2tsx/svelte-jsx-v4.d.ts"]) {
      try {
        out.push(require.resolve(f));
      } catch (e: any) {
        logMessage(2, `[parabun-lsp] svelte2tsx shim ${f} unresolved: ${e?.message ?? e}`);
      }
    }
    return out;
  })();
  function resolveProject(fromDir: string): Project {
    const cfg = ts!.findConfigFile(fromDir, ts!.sys.fileExists) ?? "";
    const hit = projectCache.get(cfg);
    if (hit) return hit;
    let project: Project = { options: { ...DEFAULT_OPTS }, ambients: [...svelteShims] };
    if (cfg) {
      const f = ts!.readConfigFile(cfg, ts!.sys.readFile);
      if (!f.error) {
        // 5th arg (configFileName) is REQUIRED so `extends` resolves —
        // apps/webui/tsconfig.json extends ./.svelte-kit/tsconfig.json,
        // which is where $app/$lib/$env/$types paths live.
        const parsed = ts!.parseJsonConfigFileContent(f.config, ts!.sys, nodePath.dirname(cfg), undefined, cfg);
        // Only the ambient/type .d.ts|.ts files matter as program roots;
        // .svelte/.pui are served via the projection snapshot path.
        const ambients = parsed.fileNames.filter(
          fn =>
            /\.(d\.ts|ts|tsx|js|jsx)$/.test(fn) &&
            !/\.(svelte|pui)\.[jt]sx?$/.test(fn) &&
            !fn.endsWith(".svelte") &&
            !fn.endsWith(".pui"),
        );
        project = {
          // Force `jsx` on regardless of the user's tsconfig: every
          // `.pui`/.svelte snapshot is svelte2tsx-projected TSX, and an
          // imported `./X.pui` resolves to `X.pui.tsx`. A plain Svelte
          // project's tsconfig has no `jsx`, so the cross-module .tsx
          // import otherwise dies with TS6142 ("'--jsx' is not set") and
          // prop-inference silently falls back to loose (verified:
          // .pui7-probe). Matches DEFAULT_OPTS (the proven open-doc path).
          options: { ...parsed.options, jsx: ts!.JsxEmit.Preserve, noEmit: true, skipLibCheck: true },
          ambients: [...svelteShims, ...ambients],
        };
        logMessage(3, `[parabun-lsp] project ${cfg}: ${ambients.length} ambient root(s)`);
      }
    }
    projectCache.set(cfg, project);
    return project;
  }
  // The "active" project = the project of an open component (.pui/.svelte)
  // doc if any (that's the SvelteKit app needing $app/etc.), else the
  // first open doc, else the workspace root.
  function activeProject(): Project {
    const docs = [...documents.keys()];
    const pick = docs.find(u => isComponentUri(u)) ?? docs[0];
    return resolveProject(pick ? nodePath.dirname(uriToPath(pick)) : workspaceRoot);
  }

  const host: import("typescript").LanguageServiceHost = {
    getScriptFileNames() {
      // Open docs (.pts/.ptsx presented as .ts/.tsx) PLUS the active
      // project's ambient roots (.svelte-kit/ambient.d.ts, $types,
      // src/app.d.ts, svelte-shims, vite/client) so $app/$lib/$env,
      // *.svelte and CSS-module modules actually resolve.
      const open = [...documents.keys()].map(uri => toTsPath(uriToPath(uri)));
      return [...new Set([...open, ...activeProject().ambients])];
    },
    getScriptVersion(fileName) {
      // Map back to original URI for version lookup
      const realPath = fromTsPath(fileName);
      const uri = pathToUri(realPath);
      const v = docVersions.get(uri);
      return v !== undefined ? String(v) : "0";
    },
    getScriptSnapshot(fileName) {
      if (/Table\.pui|__probe-consumer/.test(fileName))
        if (/[\\/]@lyku[\\/]para-preprocess[\\/]pui\.d\.ts$/.test(fileName)) {
          // Neutralize the `@lyku/para-preprocess/pui` wildcard ambient
          // (`declare module "*.pui"`) INSIDE the LSP's own program. That
          // shim exists for non-LSP consumers (plain tsc / svelte-check),
          // but a wildcard ambient shadows host-resolved per-file modules in
          // the checker — so with it loaded, `import X from './X.pui'`
          // resolves to the loose `Component<Record<string,any>>` instead of
          // the real svelte2tsx-projected $props() (verified: .pui7-probe).
          // The LSP owns real per-file `.pui` types via
          // resolveModuleNameLiterals → projected `.pui.tsx`; it must ignore
          // the wildcard, exactly as svelte-language-server does NOT load a
          // `*.svelte` wildcard in its own program. Serve an empty module so
          // the `/// <reference types="@lyku/para-preprocess/pui" />` still
          // resolves but contributes no `declare module "*.pui"`.
          return ts!.ScriptSnapshot.fromString("export {};\n");
        }
      // Check if this is a virtual .ts path for an open .pts document
      const realPath = fromTsPath(fileName);
      const uri = pathToUri(realPath);
      // `.pui` (Slice B): serve full svelte2tsx output so the TS service
      // sees real component/prop/template types — not the blank-padded
      // script-only synthetic. Raw markup lives in svelteRawTexts.
      if (isPuiUri(uri)) {
        // Open docs keep raw in svelteRawTexts; a CLOSED `.pui` reached
        // here only via an `import X from './X.pui'` (resolved by
        // resolveModuleNameLiterals) — read+project it from disk too, or
        // the importer falls back to the loose `*.pui` ambient and loses
        // real $props() types.
        let raw = svelteRawTexts.get(uri);
        if (raw === undefined && ts!.sys.fileExists(realPath)) {
          raw = ts!.sys.readFile(realPath);
        }
        if (raw !== undefined) {
          const t = getPuiTransform(uri, raw);
          if (t) return ts!.ScriptSnapshot.fromString(t.code);
        } else {
        }
      }
      const content = documents.get(uri);
      if (content !== undefined) {
        return ts!.ScriptSnapshot.fromString(transformParabunToTS(content));
      }
      // Try direct path on disk
      if (ts!.sys.fileExists(realPath)) {
        const text = ts!.sys.readFile(realPath)!;
        const isParabun = /\.p(?:ts|tsx|js|jsx)$/.test(realPath);
        return ts!.ScriptSnapshot.fromString(isParabun ? transformParabunToTS(text) : text);
      }
      // Try the fileName as-is (for lib files, node_modules, etc.)
      if (realPath !== fileName && ts!.sys.fileExists(fileName)) {
        return ts!.ScriptSnapshot.fromString(ts!.sys.readFile(fileName)!);
      }
      // Fall back to .pts/.ptsx/.pjs/.pjsx on disk when TS asks for .ts/.tsx/.js/.jsx
      const pbFallbacks: [string, string][] = [
        [".ts", ".pts"],
        [".tsx", ".ptsx"],
        [".js", ".pjs"],
        [".jsx", ".pjsx"],
      ];
      for (const [tsExt, pbExt] of pbFallbacks) {
        if (fileName.endsWith(tsExt)) {
          const pbPath = fileName.slice(0, -tsExt.length) + pbExt;
          if (ts!.sys.fileExists(pbPath)) {
            return ts!.ScriptSnapshot.fromString(transformParabunToTS(ts!.sys.readFile(pbPath)!));
          }
        }
      }
      return undefined;
    },
    getCompilationSettings: () => activeProject().options,
    getDefaultLibFileName: opts => ts!.getDefaultLibFilePath(opts),
    getCurrentDirectory: () => workspaceRoot,
    fileExists(path) {
      if (ts!.sys.fileExists(path)) return true;
      // Virtual component paths: `<x>.pui.tsx` / `<x>.svelte.{ts,tsx,js}`
      // are served by getScriptSnapshot (projection) but have no real
      // file. resolveModuleNameLiterals resolves `./X.pui` to
      // `X.pui.tsx`; TS then validates it via fileExists — which MUST
      // say true or the import dies TS2307 even though resolution
      // succeeded (verified: .pui7-probe). Recognize them via the
      // existing fromTsPath inverse.
      if (/\.(pui|svelte)\.[jt]sx?$/.test(path) && ts!.sys.fileExists(fromTsPath(path))) {
        return true;
      }
      const pbMap: [string, string][] = [
        [".ts", ".pts"],
        [".tsx", ".ptsx"],
        [".js", ".pjs"],
        [".jsx", ".pjsx"],
      ];
      for (const [tsExt, pbExt] of pbMap) {
        if (path.endsWith(tsExt) && ts!.sys.fileExists(path.slice(0, -tsExt.length) + pbExt)) return true;
      }
      return false;
    },
    readFile: path => ts!.sys.readFile(path),
    readDirectory: (...args: any[]) => (ts!.sys.readDirectory as any)(...args),
    getDirectories: path => ts!.sys.getDirectories(path),
    resolveModuleNameLiterals(moduleLiterals, containingFile, _redirectedRef, options) {
      const parabunSys: import("typescript").System = {
        ...ts!.sys,
        fileExists(path: string): boolean {
          if (ts!.sys.fileExists(path)) return true;
          const pbMap: [string, string][] = [
            [".ts", ".pts"],
            [".tsx", ".ptsx"],
            [".js", ".pjs"],
            [".jsx", ".pjsx"],
          ];
          for (const [tsExt, pbExt] of pbMap) {
            if (path.endsWith(tsExt) && ts!.sys.fileExists(path.slice(0, -tsExt.length) + pbExt)) return true;
          }
          return false;
        },
      };
      return moduleLiterals.map(literal => {
        const name = literal.text;
        // `import X from './X.pui'` — a RELATIVE `.pui` is unambiguously
        // the sibling file, never a module. It MUST resolve to the
        // projected virtual `.pui.tsx` (served by getScriptSnapshot via
        // svelte2tsx) so importers get the REAL $props() types. Do this
        // BEFORE consulting standard resolution: the program carries a
        // wildcard `declare module "*.pui"` ambient (shipped by
        // @lyku/para-preprocess/pui), and ts.resolveModuleName resolves
        // the relative specifier to THAT ambient — a truthy resolvedModule
        // — so a `!res.resolvedModule` guard never fires and the loose
        // `Component<Record<string,any>>` wins (verified: .pui7-probe).
        // The concrete sibling file must beat the wildcard. Relative only;
        // bare/aliased `.pui` falls through to paths/baseUrl.
        if (name.startsWith(".") && name.endsWith(".pui")) {
          const abs = nodePath.resolve(nodePath.dirname(fromTsPath(containingFile)), name).replace(/\\/g, "/");
          if (ts!.sys.fileExists(abs)) {
            return {
              resolvedModule: {
                resolvedFileName: toTsPath(abs),
                extension: ts!.Extension.Tsx,
                isExternalLibraryImport: false,
              },
              failedLookupLocations: [],
            } as ReturnType<typeof ts.resolveModuleName>;
          }
        }
        return ts!.resolveModuleName(name, containingFile, options, parabunSys);
      });
    },
  };

  tsService = ts!.createLanguageService(host, ts!.createDocumentRegistry());
  logMessage(3, "[parabun-lsp] TypeScript language service initialized");
}

// ---------------------------------------------------------------------------
// Position utilities
// ---------------------------------------------------------------------------

function offsetToPosition(content: string, offset: number): LspPosition {
  let line = 0;
  let character = 0;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") {
      line++;
      character = 0;
    } else {
      character++;
    }
  }
  return { line, character };
}

function positionToOffset(content: string, line: number, character: number): number {
  let currentLine = 0;
  let offset = 0;
  while (offset < content.length && currentLine < line) {
    if (content[offset] === "\n") currentLine++;
    offset++;
  }
  return offset + character;
}

function mapPositionToTransformed(
  original: string,
  transformed: string,
  line: number,
  character: number,
): { line: number; character: number } {
  const origLines = original.split("\n");
  const transLines = transformed.split("\n");

  if (origLines.length === transLines.length) {
    if (line >= origLines.length) return { line, character };
    const origLine = origLines[line];
    const transLine = transLines[line];
    if (origLine === transLine) return { line, character };
    return { line, character: mapCharInLine(origLine, transLine, character) };
  }

  const origOffset = positionToOffset(original, line, character);
  const ratio = transformed.length > 0 ? origOffset / original.length : 0;
  const transOffset = Math.min(Math.round(ratio * transformed.length), transformed.length);
  return offsetToPosition(transformed, transOffset);
}

function mapCharInLine(origLine: string, transLine: string, col: number): number {
  if (col >= origLine.length) return Math.min(col, transLine.length);

  let wStart = col;
  let wEnd = col;
  while (wStart > 0 && /\w/.test(origLine[wStart - 1])) wStart--;
  while (wEnd < origLine.length && /\w/.test(origLine[wEnd])) wEnd++;
  const word = origLine.slice(wStart, wEnd);

  if (!word) return Math.min(col, transLine.length);

  const searchStart = Math.max(0, wStart - 20);
  const idx = transLine.indexOf(word, searchStart);
  if (idx !== -1) return idx + (col - wStart);

  return Math.min(col, transLine.length);
}

function mapPositionFromTransformed(
  original: string,
  transformed: string,
  line: number,
  character: number,
): LspPosition {
  const origLines = original.split("\n");
  const transLines = transformed.split("\n");

  if (origLines.length === transLines.length && line < transLines.length) {
    const origLine = origLines[line];
    const transLine = transLines[line];
    if (origLine === transLine) return { line, character };
    return {
      line,
      character: mapCharInLine(transLine, origLine, character),
    };
  }

  const transOffset = positionToOffset(transformed, line, character);
  const ratio = transformed.length > 0 ? transOffset / transformed.length : 0;
  const origOffset = Math.min(Math.round(ratio * original.length), original.length);
  return offsetToPosition(original, origOffset);
}

// ---------------------------------------------------------------------------
// Validation — combined Bun transpiler + TypeScript diagnostics
// ---------------------------------------------------------------------------

// Debounce + staleness guard. A full validate (transpile + tsc
// semantic + tsc syntactic) takes ~9s on a cold first run and ~200ms
// warm. Per-keystroke validation would back-pressure the queue: VS
// Code sends a didChange per keystroke, and because the JSON-RPC
// loop is single-threaded each validate blocks the next. The user
// would see diagnostics flap warn→unwarn long after they had stopped
// typing because validates for OLD document versions kept arriving.
//
// Fix: coalesce didChange events per-URI via a setTimeout window
// (cancelling the prior timer on each edit) so only the latest
// content gets validated. Inside validate, capture the document
// version at entry and recheck before publishing — if the user typed
// again while tsc was working, we skip the publish so stale
// diagnostics for an old version don't overwrite the latest editor
// state.
// Fast pass (parabun-syntax) fires after a short idle window — long
// enough to coalesce a typing burst, short enough that error feedback
// feels live. Slow pass (tsc semantic) waits longer because the
// per-edit tsc cost on @lyku-sized workspaces is 0.5-1 s warm; firing
// it every 250 ms while typing burns CPU for no benefit. The slow pass
// runs in a subprocess so the LSP main loop stays responsive
// regardless of how long tsc takes — hover, completions, parabun
// diagnostics all keep working during the validate.
const FAST_DEBOUNCE_MS = 250;
const SLOW_DEBOUNCE_MS = 1500;
const fastTimers = new Map<string, ReturnType<typeof setTimeout>>();
const slowTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleValidate(uri: string) {
  const prevFast = fastTimers.get(uri);
  if (prevFast !== undefined) clearTimeout(prevFast);
  const fast = setTimeout(() => {
    fastTimers.delete(uri);
    const content = documents.get(uri);
    if (content === undefined) return;
    runFastValidate(uri, content);
  }, FAST_DEBOUNCE_MS);
  fastTimers.set(uri, fast);

  const prevSlow = slowTimers.get(uri);
  if (prevSlow !== undefined) clearTimeout(prevSlow);
  const slow = setTimeout(() => {
    slowTimers.delete(uri);
    const content = documents.get(uri);
    if (content === undefined) return;
    const version = docVersions.get(uri);
    if (version === undefined) return;
    requestTscDiagnostics(uri, content, version);
  }, SLOW_DEBOUNCE_MS);
  slowTimers.set(uri, slow);
}

// Fast pass — Bun transpiler parse errors + all parabun-specific regex
// validators. Runs in the main LSP process, synchronously, on every
// debounced didChange. Publishes a `fast-only` diagnostic set
// immediately. The slow pass (tsc) arrives later via the helper
// subprocess and republishes a merged set.
//
// `lastFastDiagnostics` is kept per URI so that when the helper's tsc
// diagnostics arrive we can republish [fast + tsc] without re-running
// the fast pass (cheap, but no need).
const lastFastDiagnostics = new Map<string, LspDiagnostic[]>();

function runFastValidate(uri: string, content: string): void {
  const startedAtVersion = docVersions.get(uri);
  const fastDiagnostics = computeFastDiagnostics(uri, content);

  if (docVersions.get(uri) !== startedAtVersion) return;
  lastFastDiagnostics.set(uri, fastDiagnostics);
  publishDiagnostics(uri, fastDiagnostics);
}

// ---------------------------------------------------------------------------
// tsc helper subprocess. Long-lived companion that owns the TypeScript
// LanguageService so the main LSP stays responsive. Spawned lazily on
// first request and respawned if it dies. Communicates via
// newline-delimited JSON over stdio.
// ---------------------------------------------------------------------------

let tscHelper: ReturnType<typeof import("child_process").spawn> | undefined;
let tscHelperBuf = "";
const helperOpenDocs = new Set<string>();

function ensureTscHelper(): void {
  if (tscHelper && !tscHelper.killed && tscHelper.exitCode === null) return;
  const { spawn } = require("child_process") as typeof import("child_process");
  const helperArgs = ["run", __filename, "--tsc-helper"];
  tscHelper = spawn(process.execPath, helperArgs, {
    cwd: workspaceRoot,
    env: { ...process.env, BUN_DEBUG_QUIET_LOGS: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  tscHelperBuf = "";
  helperOpenDocs.clear();
  tscHelper.stdout!.setEncoding("utf8");
  tscHelper.stdout!.on("data", (chunk: string) => {
    tscHelperBuf += chunk;
    let nl: number;
    while ((nl = tscHelperBuf.indexOf("\n")) !== -1) {
      const line = tscHelperBuf.slice(0, nl);
      tscHelperBuf = tscHelperBuf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      handleHelperReply(msg);
    }
  });
  tscHelper.stderr!.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    if (text.trim()) logMessage(2, `[parabun-lsp tsc-helper stderr] ${text.trim()}`);
  });
  tscHelper.on("exit", (code, signal) => {
    logMessage(2, `[parabun-lsp tsc-helper exited code=${code} signal=${signal}]`);
    tscHelper = undefined;
  });
  // Resync every currently-open document so the helper can serve
  // diagnostics for files the user already had open before its first
  // spawn / after a respawn.
  for (const [uri, content] of documents) {
    const version = docVersions.get(uri) ?? 1;
    sendToHelper({ type: "open", uri, content, version, lang: svelteLangs.get(uri), raw: svelteRawTexts.get(uri) });
    helperOpenDocs.add(uri);
  }
}

function sendToHelper(msg: object): void {
  ensureTscHelper();
  try {
    tscHelper!.stdin!.write(JSON.stringify(msg) + "\n");
  } catch (e: any) {
    logMessage(2, `[parabun-lsp tsc-helper write failed: ${e?.message ?? e}]`);
  }
}

function handleHelperReply(msg: any): void {
  if (msg.type === "ready") return;
  if (msg.type === "log") {
    logMessage(msg.level ?? 3, msg.message ?? "");
    return;
  }
  if (msg.type !== "diagnostics") return;

  const { uri, version, diagnostics } = msg as {
    uri: string;
    version: number;
    diagnostics: LspDiagnostic[];
  };
  // Staleness guard — discard tsc results for any version that's no
  // longer the latest content. The fast pass already published for
  // the current version; ignoring stale tsc just means we wait for
  // the next debounced slow pass to fire on the latest content.
  if (docVersions.get(uri) !== version) return;
  const fast = lastFastDiagnostics.get(uri) ?? [];
  publishDiagnostics(uri, [...fast, ...diagnostics]);
}

function requestTscDiagnostics(uri: string, content: string, version: number): void {
  ensureTscHelper();
  const lang = svelteLangs.get(uri);
  // The helper subprocess type-checks `.pui` via the svelte2tsx
  // projection, which needs the RAW .pui text (svelteRawTexts) — the
  // `content` we send is the blank-padded synthetic. Without `raw` the
  // helper's computeTsDiagnostics short-circuits to [] for every .pui
  // (LYK-912: all .pui type errors were invisible).
  const raw = svelteRawTexts.get(uri);
  if (!helperOpenDocs.has(uri)) {
    sendToHelper({ type: "open", uri, content, version, lang, raw });
    helperOpenDocs.add(uri);
  } else {
    sendToHelper({ type: "update", uri, content, version, lang, raw });
  }
  sendToHelper({ type: "validate", uri, version });
}

function computeFastDiagnostics(uri: string, content: string): LspDiagnostic[] {
  const diagnostics: LspDiagnostic[] = [];

  // Bun transpiler diagnostics (Parabun parse errors). The Bun
  // AggregateError attaches each individual parse failure to `e.errors`
  // — we iterate that and emit one diagnostic per error with the
  // attached `position` so squiggles land on the offending tokens
  // instead of all bunched at line 0.
  // For `.pui`, parse the SINGLE-SOURCE projection (pui-transform /
  // svelte2tsx — the exact lowering the slow tsc pass uses) instead of
  // the legacy transformParabunToTS shim. That shim is a hand-maintained
  // parallel keyword-lowerer that drifts (it lacked mount/prop/derived;
  // block-`derived NAME { … }` still can't be column-shimmed) — LYK-911.
  // Map parse-error positions back to the raw .pui via the sourcemap,
  // mirroring computeTsDiagnostics' `.pui` block. Fall back to the legacy
  // path only when the projection is unavailable (e.g. svelte2tsx throws
  // mid-edit) so fast feedback is never lost entirely.
  const loader = loaderForUri(uri);
  let parseSource: string;
  let parseTranspiler = transpilers[loader];
  let toOrig: ((l: number, c: number) => { line: number; character: number } | null) | null = null;
  if (isPuiUri(uri)) {
    const raw = svelteRawTexts.get(uri);
    const t = raw !== undefined ? getPuiTransform(uri, raw) : undefined;
    if (t) {
      parseSource = t.code;
      parseTranspiler = transpilers.tsx; // svelte2tsx output is TSX
      toOrig = (l, c) => t.toOriginal(l, c);
    } else {
      parseSource = transformParabunToTS(content);
    }
  } else {
    parseSource = transformParabunToTS(content);
  }
  try {
    parseTranspiler.transformSync(parseSource);
  } catch (e: any) {
    const errs: any[] = Array.isArray(e?.errors) && e.errors.length > 0 ? e.errors : [e];
    for (const err of errs) {
      const pos = err?.position;
      const message: string = err?.message ?? String(err);
      const level: string = err?.level ?? "error";
      let line = pos ? pos.line - 1 : 0;
      let col = pos ? pos.column - 1 : 0;
      const len = pos?.length ?? 1;
      if (toOrig && pos) {
        const o = toOrig(line, col);
        if (!o) continue; // generated-only svelte2tsx scaffolding — not user code
        line = o.line;
        col = o.character;
      }
      diagnostics.push({
        range: {
          start: { line, character: col },
          end: { line, character: col + len },
        },
        severity: level === "warning" ? 2 : 1,
        source: "parabun",
        message,
      });
    }
  }

  diagnostics.push(...findPureEligibleHints(content));
  diagnostics.push(...findMemoHints(uri, content));
  diagnostics.push(...findPureViolations(uri, content));
  diagnostics.push(...findUnknownValidationTypeDiagnostics(content));
  diagnostics.push(...findModelBodyDiagnostics(content));
  diagnostics.push(...findUnknownIdentifierDiagnostics(content, uri));

  // Template-level well-formedness — scan the original .svelte/.pui
  // markup (kept in svelteRawTexts) rather than the blank-padded synthetic
  // the parabun parser sees.
  if (isComponentUri(uri)) {
    const raw = svelteRawTexts.get(uri);
    if (raw !== undefined) {
      diagnostics.push(...findTemplateWellFormednessIssues(raw, isPuiUri(uri)));
    }
    // CSS/SCSS/Less diagnostics for `<style>` blocks via vscode-css-languageservice.
    diagnostics.push(...computeStyleDiagnostics(uri));
  }

  return diagnostics;
}

// svelte2tsx / pui-lowering projection scaffolding that must never reach
// the user as a `.pui` diagnostic. These identifiers/modules are emitted
// by the projection, not authored by the user, and are ambient in a
// correctly-typed workspace. Matching by message is consistent with the
// pre-existing `__sig_`/`__v` filter; it targets only unambiguous
// projection symbols so genuine user errors still surface.
const PUI_SCAFFOLD_DIAG =
  /Cannot find name '(svelteHTML|__sveltets_[\w$]*|\$(?:props|state|derived|effect|bindable|inspect|host)|__parabunRange[\w$]*|__paraDec)'|Cannot find type definition file for 'svelte'|Cannot find module '@lyku\/para-(?:ui|signals|preprocess)'/;

function computeTsDiagnostics(uri: string, content: string): LspDiagnostic[] {
  const diagnostics: LspDiagnostic[] = [];
  if (!(tsService && ts)) return diagnostics;

  const fileName = toTsPath(uriToPath(uri));

  // `.pui` (Slice B): diagnostics are over svelte2tsx output; map each
  // back to the raw .pui via the sourcemap. Generated positions with no
  // original mapping are svelte2tsx scaffolding (not user code) — drop
  // them rather than squiggle at (0,0).
  if (isPuiUri(uri)) {
    const raw = svelteRawTexts.get(uri);
    const t = raw !== undefined ? getPuiTransform(uri, raw) : undefined;
    if (!t) return diagnostics;
    try {
      const all = [...tsService.getSyntacticDiagnostics(fileName), ...tsService.getSemanticDiagnostics(fileName)];
      for (const diag of all) {
        if (diag.start === undefined || diag.length === undefined) continue;
        const dm = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
        // Drop projection scaffolding — never user code. Three classes:
        //  • bridge-lowering internals (`__sig_*`, `__v`);
        //  • svelte2tsx machinery (`svelteHTML`, `__sveltets_*`, the
        //    `///<reference types="svelte" />`);
        //  • lowering-injected runtime imports / svelte rune globals
        //    (`@lyku/para-*`, `$props`/`$state`/`$derived`/…), which are
        //    ambient in a correctly-typed workspace and non-actionable in
        //    a `.pui` regardless. Genuine user errors (wrong types, real
        //    missing user identifiers/modules) are not in this set.
        if (PUI_SCAFFOLD_DIAG.test(dm) || /\b__sig_[A-Za-z_$]|\b__v\b/.test(dm)) continue;
        const gs = offsetToPosition(t.code, diag.start);
        const ge = offsetToPosition(t.code, diag.start + diag.length);
        const os = t.toOriginal(gs.line, gs.character);
        const oe = t.toOriginal(ge.line, ge.character);
        if (!os) continue; // generated-only scaffolding
        const end = oe ?? { line: os.line, character: os.character + 1 };
        diagnostics.push({
          range: { start: os, end },
          severity:
            diag.category === ts.DiagnosticCategory.Error ? 1 : diag.category === ts.DiagnosticCategory.Warning ? 2 : 3,
          source: "ts",
          message: `TS${diag.code}: ${dm}`,
        });
      }
    } catch (e: any) {
      logMessage(2, `[parabun-lsp] .pui TS diagnostics error: ${e?.message ?? e}`);
    }
    return diagnostics;
  }

  const transformed = transformParabunToTS(content);

  try {
    const semanticDiags = tsService.getSemanticDiagnostics(fileName);
    const syntacticDiags = tsService.getSyntacticDiagnostics(fileName);

    for (const diag of [...syntacticDiags, ...semanticDiags]) {
      if (diag.start === undefined || diag.length === undefined) continue;

      const startPos = offsetToPosition(transformed, diag.start);
      const endPos = offsetToPosition(transformed, diag.start + diag.length);

      const origStart = mapPositionFromTransformed(content, transformed, startPos.line, startPos.character);
      const origEnd = mapPositionFromTransformed(content, transformed, endPos.line, endPos.character);

      const message = ts.flattenDiagnosticMessageText(diag.messageText, "\n");

      diagnostics.push({
        range: { start: origStart, end: origEnd },
        severity:
          diag.category === ts.DiagnosticCategory.Error ? 1 : diag.category === ts.DiagnosticCategory.Warning ? 2 : 3,
        source: "ts",
        message: `TS${diag.code}: ${message}`,
      });
    }
  } catch (e: any) {
    logMessage(2, `[parabun-lsp] TS diagnostics error: ${e?.message ?? e}`);
  }

  return diagnostics;
}

const PURE_HINT_CODE = "parabun-pure-eligible";
const MEMO_SUGGEST_CODE = "parabun-memo-eligible";
const MEMO_UNNECESSARY_CODE = "parabun-memo-unnecessary";

// Signals that correlate with "memo likely pays off":
//   - recursion (self-call)
//   - loop or array-method chain in body
//   - calls another declared-pure function
//   - takes exactly one argument (high cache-reuse, cheap key)
// Threshold of ≥2 keeps straight-line arithmetic one-liners (arcradius,
// clamp, lerp) out of the hint zone while still flagging obvious wins
// (fib, tree-walk, hash-by-key lookups).
const MEMO_SUGGEST_MIN_PRO_SIGNALS = 2;

interface MemoBodyAnalysis {
  pro: number;
  arity0: boolean;
  bodyTrivial: boolean;
}

function analyzeForMemo(fnName: string, params: string[], rawBody: string, allPureFns: Set<string>): MemoBodyAnalysis {
  const body = maskCommentsAndStrings(rawBody);
  const hasRecursion = fnName ? new RegExp(`\\b${fnName}\\s*\\(`).test(body) : false;
  const hasLoop = /\b(?:for|while)\b|\.(?:map|filter|reduce|forEach|some|every|flatMap|find|findIndex)\s*\(/.test(body);

  let callsAnotherPureFn = false;
  const callRe = /\b(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(body)) !== null) {
    const name = m[1];
    if (name === fnName) continue;
    if (allPureFns.has(name)) {
      callsAnotherPureFn = true;
      break;
    }
  }

  const arity1 = params.length === 1;
  const arity0 = params.length === 0;

  // Body is "trivial" when it does none of the work-suggesting things — no
  // loop, no self-recursion, and no call to another declared-pure function.
  // The work is then O(1) arithmetic, so memo overhead tends to exceed it
  // even for multi-line bodies (e.g. `arcradius` with 4 args and a handful
  // of Math.sin/cos calls). Line count is an unreliable proxy for work.
  const bodyTrivial = !hasLoop && !hasRecursion && !callsAnotherPureFn;

  let pro = 0;
  if (hasRecursion) pro++;
  if (hasLoop) pro++;
  if (callsAnotherPureFn) pro++;
  if (arity1) pro++;

  return { pro, arity0, bodyTrivial };
}

function findMemoHints(uri: string, content: string): LspDiagnostic[] {
  const hints: LspDiagnostic[] = [];
  const lines = content.split("\n");
  const allPureFns = getAllPureFns(uri, content);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // `pure function name(` / `pure async function name(` / with `fun`.
    const pureMatch = line.match(/^(\s*(?:export\s+)?)(pure)(\s+(?:async\s+)?fun(?:ction)?\s+)(\w+)/);
    // `memo name(` / `memo async name(`.
    const memoMatch = !pureMatch ? line.match(/^(\s*(?:export\s+)?)(memo)(\s+(?:async\s+)?)(\w+)(?=\s*[(<])/) : null;

    if (!pureMatch && !memoMatch) continue;

    const sig = extractFunctionSignatureAndBody(lines, i);
    if (!sig) continue;

    const match = pureMatch ?? memoMatch!;
    const name = match[4];
    const kwStart = match[1].length;
    const kwEnd = kwStart + match[2].length;
    const { pro, arity0, bodyTrivial } = analyzeForMemo(name, sig.params, sig.body, allPureFns);

    if (pureMatch && pro >= MEMO_SUGGEST_MIN_PRO_SIGNALS) {
      hints.push({
        range: {
          start: { line: i, character: kwStart },
          end: { line: i, character: kwEnd },
        },
        severity: 4,
        source: "parabun",
        message: `Could be \`memo\` — body has ${pro} memo-friendly signals (recursion / loop / pure-fn call / single primitive arg)`,
        code: MEMO_SUGGEST_CODE,
      });
    } else if (memoMatch && pro < MEMO_SUGGEST_MIN_PRO_SIGNALS && (arity0 || bodyTrivial)) {
      const reason = arity0
        ? "0-arg memo — a plain `const` captures the value just as well"
        : "body is trivial — the memo map lookup likely costs more than the work";
      hints.push({
        range: {
          start: { line: i, character: kwStart },
          end: { line: i, character: kwEnd },
        },
        severity: 4,
        source: "parabun",
        message: `\`memo\` may not pay off here — ${reason}`,
        code: MEMO_UNNECESSARY_CODE,
      });
    }
  }

  return hints;
}

function findPureEligibleHints(content: string): LspDiagnostic[] {
  const hints: LspDiagnostic[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\bpure\s/.test(line)) continue;

    const fnMatch = line.match(/^(\s*(?:export\s+)?(?:async\s+)?)(fun(?:ction)?)\b/);
    if (!fnMatch || fnMatch.index === undefined) continue;

    const sigAndBody = extractFunctionSignatureAndBody(lines, i);
    if (sigAndBody === null) continue;

    if (bodyHasSideEffects(sigAndBody.params, sigAndBody.body)) continue;

    const kwStart = fnMatch[1].length;
    const kwEnd = kwStart + fnMatch[2].length;
    hints.push({
      range: {
        start: { line: i, character: kwStart },
        end: { line: i, character: kwEnd },
      },
      severity: 4,
      source: "parabun",
      message: "Function could be marked pure",
      code: PURE_HINT_CODE,
    });
  }

  return hints;
}

/** Replace line comments, block comments, and '/"-quoted string contents
 * with spaces so later regex scans don't false-positive on the word "this",
 * "arguments", or an identifier that looks like an assignment inside a
 * comment or string. Newlines are preserved; column offsets are unchanged;
 * template literals are left intact so their ${...} interpolations still
 * get scanned. */
function maskCommentsAndStrings(src: string): string {
  const out: string[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      out.push("  ");
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out.push(src[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < n) {
        out.push("  ");
        i += 2;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      out.push(quote);
      i++;
      while (i < n && src[i] !== quote && src[i] !== "\n") {
        if (src[i] === "\\" && i + 1 < n) {
          out.push("  ");
          i += 2;
          continue;
        }
        out.push(" ");
        i++;
      }
      if (i < n && src[i] === quote) {
        out.push(quote);
        i++;
      }
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join("");
}

function extractFunctionSignatureAndBody(lines: string[], fnLine: number): { params: string[]; body: string } | null {
  let braceDepth = 0;
  let started = false;
  const bodyParts: string[] = [];

  // Extract param names from the signature line(s)
  const sigText = lines.slice(fnLine, Math.min(fnLine + 5, lines.length)).join(" ");
  const paramMatch = sigText.match(/\(([^)]*)\)/);
  const params: string[] = [];
  if (paramMatch) {
    for (const p of paramMatch[1].split(",")) {
      const name = p
        .replace(/[:=].*/s, "")
        .replace(/\.\.\./g, "")
        .trim();
      if (name && /^\w+$/.test(name)) params.push(name);
    }
  }

  for (let i = fnLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") {
        if (!started) started = true;
        braceDepth++;
      } else if (ch === "}") {
        braceDepth--;
        if (started && braceDepth === 0) {
          return { params, body: bodyParts.join("") };
        }
      }
      if (started && braceDepth >= 1) {
        bodyParts.push(ch);
      }
    }
    if (started) bodyParts.push("\n");
  }

  return null;
}

function bodyHasSideEffects(params: string[], rawBody: string): boolean {
  const body = maskCommentsAndStrings(rawBody);
  if (/\bthis\b/.test(body) || /\barguments\b/.test(body)) return true;
  // `await` is async I/O — the awaited callee is doing the side effect, but
  // the awaiting function is observably impure regardless.
  if (/\bawait\b/.test(body)) return true;

  const locals = collectLocals(params, body);
  const paramSet = new Set<string>(params);

  const assignRe = /\b(\w+)\s*(?:=[^=>]|[+\-*/%&|^]={1,2}|\+\+|--)/g;
  let m: RegExpExecArray | null;
  while ((m = assignRe.exec(body)) !== null) {
    if (!locals.has(m[1]) && !JS_KEYWORDS.test(m[1])) return true;
  }

  const prefixRe = /(?:\+\+|--)(\w+)/g;
  while ((m = prefixRe.exec(body)) !== null) {
    if (!locals.has(m[1])) return true;
  }

  // Parameter property/index mutation
  const propAssignRe = /\b(\w+)(\.[a-zA-Z_$]\w*|\[[^\]]*\])\s*(?:=[^=>]|[+\-*/%&|^]={1,2})/g;
  while ((m = propAssignRe.exec(body)) !== null) {
    if (paramSet.has(m[1])) return true;
  }

  // Mutating method calls on parameters OR free variables. A `.set(...)` /
  // `.push(...)` etc. on anything that isn't a local declaration is
  // observably side-effectful even when the root identifier is captured
  // from an outer scope (`stores.users.set(...)`, `cache.delete(...)`).
  const mutMethodRe =
    /\b(\w+)(?:\.[a-zA-Z_$]\w*)*\.(push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin|set|delete|clear|add)\s*\(/g;
  while ((m = mutMethodRe.exec(body)) !== null) {
    const root = m[1];
    if (locals.has(root)) continue; // local container — its scope is the function
    return true;
  }

  // Calls on free variables not in the curated pure-safe-call set. Any
  // `console.error(...)`, `api.foo()`, etc. count as observable side effects
  // from the caller's perspective even if the callee is internally pure —
  // the suggestion-side hint is for *confidently* pure functions only, so we
  // err strict.
  const freeCallRe = /\b(\w+)\s*\(/g;
  while ((m = freeCallRe.exec(body)) !== null) {
    const name = m[1];
    if (locals.has(name)) continue;
    if (paramSet.has(name)) continue;
    if (JS_KEYWORDS.test(name)) continue;
    if (PURE_SAFE_CALLS.has(name)) continue;
    // A free identifier being called — be conservative and treat as a side
    // effect. False negatives (missing a hint where the function IS pure)
    // are vastly preferable to false positives like the one that prompted
    // this fix.
    return true;
  }

  // Member-call where the ROOT is a free non-safe identifier:
  // `api.listGroupsImIn()`, `console.error(...)`, `stores.users.get(...)`.
  // Reads and method invocations on captured/imported state are not safe to
  // assume pure.
  const memberCallRe = /\b(\w+)\.\w+(?:\.\w+)*\s*\(/g;
  while ((m = memberCallRe.exec(body)) !== null) {
    const root = m[1];
    if (locals.has(root)) continue;
    if (paramSet.has(root)) continue;
    if (JS_KEYWORDS.test(root)) continue;
    if (PURE_SAFE_CALLS.has(root)) continue;
    return true;
  }

  return false;
}

function pureDiag(line: number, col: number, len: number, severity: number, message: string): LspDiagnostic {
  return {
    range: { start: { line, character: col }, end: { line, character: col + len } },
    severity,
    source: "parabun",
    message,
  };
}

const PURE_SAFE_CALLS = new Set([
  "Math",
  "JSON",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "BigInt",
  "Symbol",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURI",
  "encodeURIComponent",
  "decodeURI",
  "decodeURIComponent",
  "structuredClone",
  "atob",
  "btoa",
  "Intl",
  "Reflect",
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "ArrayBuffer",
  "DataView",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "RegExp",
  "Promise",
]);

function findPureViolations(uri: string, content: string): LspDiagnostic[] {
  const diagnostics: LspDiagnostic[] = [];
  const lines = content.split("\n");

  // Collect all pure function names (same-file + imports)
  const allPureFns = getAllPureFns(uri, content);

  // Collect impure same-file function names
  const impureFns = new Set<string>();
  for (const line of lines) {
    if (/\bpure\s+(?:async\s+)?fun(?:ction)?\s+\w+/.test(line)) continue; // already in allPureFns
    if (/\bmemo\s+(?:async\s+)?\w+\s*[(<]/.test(line)) continue; // memo is pure
    const fnMatch = line.match(/(?:^|export\s+)(?:async\s+)?fun(?:ction)?\s+(\w+)/);
    if (fnMatch) impureFns.add(fnMatch[1]);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Enter purity-check for `pure function name(` or `memo name(` bodies.
    // `memo` implies pure and gets the same enforcement.
    const pureMatch = line.match(
      /^(\s*(?:export\s+)?)(pure\s+(?:async\s+)?fun(?:ction)?|memo\s+(?:async\s+)?(?=\w+\s*[(<]))\b/,
    );
    if (!pureMatch || pureMatch.index === undefined) continue;

    const sigAndBody = extractFunctionSignatureAndBody(lines, i);
    if (!sigAndBody) continue;

    const { params, body: rawBody } = sigAndBody;
    // Mask comments and string literals so regex scans don't false-positive
    // on the word `this` in a `// ...` comment (or inside `"..."`).
    const body = maskCommentsAndStrings(rawBody);
    const locals = collectLocals(params, body);

    // Find the body start line (first { after the function line)
    let bodyStartLine = i;
    for (let j = i; j < lines.length; j++) {
      if (lines[j].includes("{")) {
        bodyStartLine = j;
        break;
      }
    }

    const paramSet = new Set<string>(params);
    const bodyLines = body.split("\n");
    for (let b = 0; b < bodyLines.length; b++) {
      const bline = bodyLines[b];
      const lineIdx = bodyStartLine + b;
      let m: RegExpExecArray | null;

      // --- Level 1: this / arguments ---

      const thisRe = /\bthis\b/g;
      while ((m = thisRe.exec(bline)) !== null) {
        diagnostics.push(pureDiag(lineIdx, m.index, 4, 1, 'Cannot use "this" inside a pure function'));
      }

      const argsRe = /\barguments\b/g;
      while ((m = argsRe.exec(bline)) !== null) {
        diagnostics.push(pureDiag(lineIdx, m.index, 9, 1, 'Cannot use "arguments" inside a pure function'));
      }

      // --- Level 1: assignment to non-local ---

      const assignRe = /\b(\w+)\s*(?:=[^=>]|[+\-*/%&|^]={1,2}|\+\+|--)/g;
      while ((m = assignRe.exec(bline)) !== null) {
        const name = m[1];
        if (!locals.has(name) && !JS_KEYWORDS.test(name)) {
          diagnostics.push(
            pureDiag(lineIdx, m.index, name.length, 1, `Cannot modify outer variable "${name}" inside a pure function`),
          );
        }
      }

      const prefixRe = /(\+\+|--)(\w+)/g;
      while ((m = prefixRe.exec(bline)) !== null) {
        const name = m[2];
        if (!locals.has(name) && !JS_KEYWORDS.test(name)) {
          diagnostics.push(
            pureDiag(
              lineIdx,
              m.index + m[1].length,
              name.length,
              1,
              `Cannot modify outer variable "${name}" inside a pure function`,
            ),
          );
        }
      }

      // --- Level 2: parameter property/index mutation ---

      const propAssignRe = /\b(\w+)(\.[a-zA-Z_$]\w*|\[[^\]]*\])\s*(?:=[^=>]|[+\-*/%&|^]={1,2})/g;
      while ((m = propAssignRe.exec(bline)) !== null) {
        if (paramSet.has(m[1])) {
          diagnostics.push(
            pureDiag(
              lineIdx,
              m.index,
              m[0].trimEnd().length - 1,
              1,
              `Cannot mutate parameter "${m[1]}" inside a pure function`,
            ),
          );
        }
      }

      const mutMethodRe =
        /\b(\w+)(?:\.[a-zA-Z_$]\w*)*\.(push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin|set|delete|clear|add)\s*\(/g;
      while ((m = mutMethodRe.exec(bline)) !== null) {
        const root = m[1];
        if (paramSet.has(root)) {
          diagnostics.push(
            pureDiag(
              lineIdx,
              m.index,
              m[0].length - 1,
              1,
              `Cannot call mutating method ".${m[2]}()" on parameter "${root}" inside a pure function`,
            ),
          );
        }
      }

      // --- Level 3 hints: non-deterministic / I/O (warning, not error) ---

      const nonDetRe = /\b(Math\.random|Date\.now|performance\.now|crypto\.randomUUID|crypto\.getRandomValues)\s*\(/g;
      while ((m = nonDetRe.exec(bline)) !== null) {
        diagnostics.push(
          pureDiag(
            lineIdx,
            m.index,
            m[1].length,
            2,
            `"${m[1]}()" is non-deterministic — breaks referential transparency in pure function`,
          ),
        );
      }

      const ioRe =
        /\b(console)\s*\.\s*(log|warn|error|info|debug|trace|dir|table|time|timeEnd|assert|count|group|groupEnd)\s*\(/g;
      while ((m = ioRe.exec(bline)) !== null) {
        const call = `${m[1]}.${m[2]}`;
        diagnostics.push(
          pureDiag(
            lineIdx,
            m.index,
            call.length,
            2,
            `"${call}()" performs I/O — breaks referential transparency in pure function`,
          ),
        );
      }

      const fetchRe = /\b(fetch)\s*\(/g;
      while ((m = fetchRe.exec(bline)) !== null) {
        diagnostics.push(
          pureDiag(lineIdx, m.index, 5, 2, `"fetch()" performs I/O — breaks referential transparency in pure function`),
        );
      }

      const newDateRe = /\bnew\s+(Date)\s*\(/g;
      while ((m = newDateRe.exec(bline)) !== null) {
        diagnostics.push(
          pureDiag(
            lineIdx,
            m.index,
            m[0].length - 1,
            2,
            `"new Date()" is non-deterministic — breaks referential transparency in pure function`,
          ),
        );
      }

      // --- Calls to known-impure same-file functions ---

      const callRe = /\b(\w+)\s*\(/g;
      while ((m = callRe.exec(bline)) !== null) {
        const name = m[1];
        if (impureFns.has(name) && !allPureFns.has(name) && !locals.has(name) && !JS_KEYWORDS.test(name)) {
          diagnostics.push(
            pureDiag(lineIdx, m.index, name.length, 1, `Calling non-pure function "${name}()" inside a pure function`),
          );
        }
      }
    }
  }

  return diagnostics;
}

const JS_KEYWORDS =
  /^(?:const|let|var|return|if|else|for|while|switch|case|break|continue|throw|new|typeof|void|delete|in|of|do|try|catch|finally|import|export|default|class|function|fun|async|await|yield|true|false|null|undefined)$/;

function collectLocals(params: string[], body: string): Set<string> {
  const locals = new Set<string>(params);
  let m: RegExpExecArray | null;
  const declRe = /\b(?:const|let|var)\s+(?:(\w+)|[{[]).*?(?:=|;|\n)/g;
  while ((m = declRe.exec(body)) !== null) {
    if (m[1]) locals.add(m[1]);
  }
  const fnDeclRe = /\b(?:function|fun|class)\s+(\w+)/g;
  while ((m = fnDeclRe.exec(body)) !== null) {
    if (m[1]) locals.add(m[1]);
  }
  const forRe = /\bfor\s*\(\s*(?:const|let|var)\s+(?:(\w+)|[\[{])/g;
  while ((m = forRe.exec(body)) !== null) {
    if (m[1]) locals.add(m[1]);
  }
  const typeDeclRe = /\b(?:type|interface)\s+(\w+)/g;
  while ((m = typeDeclRe.exec(body)) !== null) {
    if (m[1]) locals.add(m[1]);
  }
  return locals;
}

// ---------------------------------------------------------------------------
// Cross-file pure function resolution
// ---------------------------------------------------------------------------

// Cache of pure function names per file path (absolute)
const pureFnCache = new Map<string, { mtime: number; fns: Set<string> }>();

function scanFileForPureFns(filePath: string): Set<string> {
  try {
    const stat = Bun.file(filePath);
    const mtime = stat.lastModified;
    const cached = pureFnCache.get(filePath);
    if (cached && cached.mtime === mtime) return cached.fns;

    const text = require("fs").readFileSync(filePath, "utf8") as string;
    const fns = collectPureFnNames(text);
    pureFnCache.set(filePath, { mtime, fns });
    return fns;
  } catch {
    return new Set();
  }
}

function collectPureFnNames(content: string): Set<string> {
  const fns = new Set<string>();

  // Named declaration: pure function foo / pure async fun foo / export pure function foo
  const declRe = /\bpure\s+(?:async\s+)?fun(?:ction)?\s+(\w+)/g;
  for (const m of content.matchAll(declRe)) fns.add(m[1]);

  // `memo` declarator: memo foo(...) / memo async foo(...) / export memo foo(...).
  // `memo` implies pure, so its names belong in the pure-fn set.
  const memoRe = /\bmemo\s+(?:async\s+)?(\w+)(?=\s*(?:<|\())/g;
  for (const m of content.matchAll(memoRe)) fns.add(m[1]);

  // Expression form: const foo = pure (...) / const foo = pure <T>(...)
  // Also tolerates a multi-line generic-parameter block between `=` and `pure`
  // (e.g. `const foo = <T, U extends ...> pure (...) => ...`), which breaks
  // a per-line regex. The `<[^=]*?>` is deliberately non-greedy and excludes
  // `=` so a subsequent `const bar = ...` on a later line can't be consumed
  // as if it were the closing angle bracket's content. Angle-bracket generics
  // in type bounds (e.g. `Extract<keyof T, ...>`) are allowed via `[\s\S]`.
  const exprRe = /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:<[\s\S]*?>\s*)?pure[\s<(]/g;
  for (const m of content.matchAll(exprRe)) fns.add(m[1]);

  return fns;
}

function resolveImportPath(importSpec: string, fromUri: string): string | null {
  const fromPath = uriToPath(fromUri);
  const dir = fromPath.replace(/\/[^/]+$/, "");

  if (!importSpec.startsWith(".")) return null; // skip bare specifiers

  const base = dir + "/" + importSpec;
  const candidates = [
    base + ".pts",
    base + ".ptsx",
    base + ".pjs",
    base + ".pjsx",
    base + ".ts",
    base + ".tsx",
    base + ".js",
    base + ".jsx",
    base,
    base + "/index.pts",
    base + "/index.ts",
    base + "/index.js",
  ];

  const fs = require("fs");
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {}
  }
  return null;
}

/** Resolve all imported pure function names for a given file */
function getImportedPureFns(uri: string, content: string): Set<string> {
  const result = new Set<string>();
  const importRe = /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(content)) !== null) {
    const specifiers = m[1];
    const modulePath = m[2];
    const resolved = resolveImportPath(modulePath, uri);
    if (!resolved) continue;

    const pureFns = scanFileForPureFns(resolved);
    if (pureFns.size === 0) continue;

    for (const spec of specifiers.split(",")) {
      const name = spec.replace(/\s+as\s+\w+/, "").trim();
      const alias = spec.includes(" as ") ? spec.replace(/.*\s+as\s+/, "").trim() : name;
      if (pureFns.has(name)) result.add(alias);
    }
  }
  return result;
}

/** Get all pure function names visible in a file (same-file + imports) */
function getAllPureFns(uri: string, content: string): Set<string> {
  const local = collectPureFnNames(content);
  const imported = getImportedPureFns(uri, content);
  for (const name of imported) local.add(name);
  return local;
}

// ---------------------------------------------------------------------------
// Hover — TypeScript type info + Parabun operator docs
// ---------------------------------------------------------------------------

function getHoverResult(
  uri: string,
  content: string,
  line: number,
  character: number,
): { contents: { kind: string; value: string }; range?: LspRange } | null {
  // Parabun-specific hover first
  const parabunHover = getParabunHover(content, line, character);
  if (parabunHover) {
    return { contents: { kind: "markdown", value: parabunHover } };
  }

  // TypeScript hover
  if (tsService && ts) {
    const { fileName, offset } = resolveTsQuery(uri, content, line, character);

    try {
      const info = tsService.getQuickInfoAtPosition(fileName, offset);
      if (info) {
        let display = ts.displayPartsToString(info.displayParts);
        // .pui: `signal x = …` lowers to a backing `__sig_x`. Until the
        // lowering is column-mapped (LYK-880 Inc 4a), a hover can land on
        // `__sig_x`; present it under the user's name so it doesn't leak
        // the bridge internal.
        if (isPuiUri(uri)) display = display.replace(/\b__sig_([A-Za-z_$][\w$]*)/g, "$1");
        const docs = ts.displayPartsToString(info.documentation ?? []);
        const tags = (info.tags ?? [])
          .map(tag => {
            const tagText = typeof tag.text === "string" ? tag.text : (tag.text ?? []).map(p => p.text).join("");
            return `*@${tag.name}* ${tagText}`;
          })
          .join("\n\n");

        let value = "```typescript\n" + display + "\n```";
        if (docs) value += "\n\n" + docs;
        if (tags) value += "\n\n" + tags;

        return { contents: { kind: "markdown", value } };
      }
    } catch (e: any) {
      logMessage(2, `[parabun-lsp] TS hover error: ${e?.message ?? e}`);
    }
  }

  return null;
}

// Slice 0 of the reactive-graph hover: a static, single-file, *syntactic*
// scan of which reactive constructs read a given signal/derived. Honest
// limits — source-level, so it misses dynamic / conditional / cross-file
// dependencies and can include shadowed names; the true reactive graph is
// a runtime property. Surfaced as plain text in the signal hover; visuals
// (SVG-in-hover / webview) are deliberately a later slice.
function stripLineCommentForScan(s: string): string {
  const i = s.indexOf("//");
  if (i < 0) return s;
  if (i > 0 && s[i - 1] === ":") return s; // crude `://` URL guard
  return s.slice(0, i);
}

type ReactiveDependent = { kind: "derived" | "effect" | "when" | "binding"; label: string; line: number };

export function staticReactiveDependents(content: string, name: string): ReactiveDependent[] {
  const lines = content.split("\n");
  // `$` is not a \w char; this boundary keeps `foo` from matching `foo$bar`.
  const ref = new RegExp(`(?<![\\w$])${name}(?![\\w$])`);
  const derivedDecl = /\b(?:export\s+)?derived\s+([A-Za-z_$][\w$]*)\s*[:=]/;
  const whenRe = /\bwhen\b(\s+not\b)?\s*([^\n{]*?)\s*\{/;
  const out: ReactiveDependent[] = [];
  const seen = new Set<string>();
  const add = (kind: ReactiveDependent["kind"], label: string, line: number) => {
    const k = kind + ":" + line;
    if (!seen.has(k)) {
      seen.add(k);
      out.push({ kind, label, line });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const t = stripLineCommentForScan(lines[i]);
    const dm = derivedDecl.exec(t);
    if (dm && dm[1] !== name && ref.test(t.slice(dm.index + dm[0].length))) {
      add("derived", `derived ${dm[1]}`, i); // single-line RHS only (approx)
    }
    const wm = whenRe.exec(t);
    if (wm && ref.test(wm[2] ?? "")) {
      add("when", `when${wm[1] ? " not" : ""} ${(wm[2] || "").trim()}`.trim(), i);
    }
    if ((/~>/.test(t) || /(?<![-=<])->/.test(t)) && ref.test(t)) {
      add("binding", "reactive binding (~> / ->)", i);
    }
  }

  // effect { … } — brace-matched so a multi-line body counts.
  const effRe = /\beffect\s*\{/g;
  let em: RegExpExecArray | null;
  while ((em = effRe.exec(content)) !== null) {
    const open = content.indexOf("{", em.index);
    if (open < 0) break;
    let depth = 0;
    let end = content.length;
    for (let p = open; p < content.length; p++) {
      const c = content[p];
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        end = p;
        break;
      }
    }
    if (ref.test(content.slice(open + 1, end))) {
      add("effect", "effect { … }", content.slice(0, em.index).split("\n").length - 1);
    }
  }

  out.sort((a, b) => a.line - b.line);
  return out;
}

export function getParabunHover(content: string, line: number, character: number): string | null {
  const lines = content.split("\n");
  if (line >= lines.length) return null;
  const lineText = lines[line];
  const wordAt = getWordAt(lineText, character);

  // Hover on a model identifier (anywhere it appears) → show field summary.
  if (wordAt && /^[A-Za-z_$][\w$]*$/.test(wordAt)) {
    const reg = extractModelRegistry(content);
    const info = reg.get(wordAt);
    if (info) {
      const out: string[] = [`### \`schema ${info.name}\``, ""];
      if (info.origin === "from") {
        out.push(
          "Ingested from a JSON Schema (`schema X from <expr>` or `schema X = <expr>`) — schema literal preserved on the binding.",
          "",
        );
      } else if (info.origin === "import") {
        out.push("Imported binding (assumed to be a Para schema). Field shape resolved cross-file.", "");
      } else if (info.fields.length > 0) {
        out.push("Fields:", "", "```typescript");
        for (const f of info.fields) {
          out.push(`  ${f.name}${f.optional ? "?" : ""}: ${f.typeName}`);
        }
        out.push("```", "");
      }
      out.push(
        "**Members:**",
        "- `parse(v)` → Result<T, str> — runtime validator",
        "- `schema` → JSON Schema 2020-12 object",
      );
      return out.join("\n");
    }
  }

  // Hover on a field name inside a `schema X { ... }` body → show type.
  if (wordAt && /^[a-z_$][\w$]*$/.test(wordAt)) {
    const reg = extractModelRegistry(content);
    // Find which model body (if any) contains this offset.
    const offset = positionToOffset(content, line, character);
    const declRe = /\b(?:export\s+)?schema\s+([A-Za-z_$][\w$]*)\s*\{([\s\S]*?)\n\s*\}/g;
    let match: RegExpExecArray | null;
    while ((match = declRe.exec(content)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (offset < start || offset > end) continue;
      const info = reg.get(match[1]);
      if (!info) continue;
      const field = info.fields.find(f => f.name === wordAt);
      if (field) {
        return [
          `### \`${field.name}\` — field of \`${info.name}\``,
          "",
          "```typescript",
          `${field.name}${field.optional ? "?" : ""}: ${field.typeName}`,
          "```",
          field.optional ? "\n_Optional — gated by present-check at runtime._" : "",
        ]
          .filter(Boolean)
          .join("\n");
      }
    }
  }

  if (wordAt === "fun") {
    return [
      "### `fun` — shorthand for `function`",
      "",
      "Parabun shorthand. `fun` desugars to `function` at parse time.",
      "",
      "```typescript",
      "fun add(a: number, b: number) { return a + b; }",
      "export fun greet(name: string) { return `hi ${name}`; }",
      "pure fun double(x: number) { return x * 2; }",
      "```",
    ].join("\n");
  }

  if (wordAt === "pure") {
    return [
      "### `pure` — function purity modifier",
      "",
      "Marks a function as **pure**. The transpiler enforces:",
      "- No `this` access",
      "- No mutation of outer-scope variables",
      "- Enables automatic inlining at `|>` call sites",
      "",
      "```typescript",
      "pure fun add(a: number, b: number) {",
      "  return a + b;",
      "}",
      "```",
    ].join("\n");
  }

  if (wordAt === "memo") {
    return [
      "### `memo` — memoized pure function declarator",
      "",
      "`memo name(params) { body }` declares a memoized pure function. `memo`",
      "is a first-class declarator: it implies both **pure** (no outer mutation,",
      "no `this`) and **function**, so no extra keyword is needed.",
      "",
      "Cache shape is picked from arity:",
      "- **0 args** — singleton, first result reused forever.",
      "- **1 arg** — `Map` keyed by the argument (object identity, no stringify).",
      "- **≥2 args / rest** — nested `Map` chain, one level per argument.",
      "",
      "Async calls dedupe concurrent in-flight invocations (later callers get",
      "the first call's promise); rejected promises evict.",
      "",
      "```typescript",
      "memo fib(n: number): number {",
      "  return n < 2 ? n : fib(n - 1) + fib(n - 2);",
      "}",
      "memo async load(key: string) { return await db.get(key); }",
      "export memo normalize(s: string) { return s.trim().toLowerCase(); }",
      "```",
    ].join("\n");
  }

  if (wordAt === "signal" && isSignalDeclarationAt(lineText, character)) {
    return [
      "### `signal` — reactive binding",
      "",
      "`signal NAME = RHS` declares a reactive signal. Bare reads of `NAME`",
      "rewrite to `NAME.get()`, assignments to `NAME.set(...)`. If `RHS` references",
      "another in-scope signal, the declaration auto-promotes to",
      "`derived(() => RHS)` (read-only).",
      "",
      "`signal` always implies `const` — there's no `signal let`/`var`. Use",
      "`// @parabun-strict-signals` to opt out of auto-derive file-wide.",
      "",
      "```typescript",
      "signal count = 0;",
      "signal doubled = count * 2;   // auto-derived",
      "effect { console.log(count, doubled); }",
      "count++;                      // triggers effect",
      "```",
      "",
      "Allow-list: `.get`, `.set`, `.peek`, `.subscribe`, `.update` stay as",
      "real `Signal` methods. Every other `NAME.foo` rewrites as `NAME.get().foo`.",
    ].join("\n");
  }

  // Hover on a signal / derived NAME → list its static reactive dependents.
  // (The `signal` keyword itself is handled by the block above.)
  if (wordAt && /^[A-Za-z_$][\w$]*$/.test(wordAt)) {
    const declM = new RegExp(`\\b(signal|derived)\\s+${wordAt}(?![\\w$])`).exec(content);
    if (declM) {
      const deps = staticReactiveDependents(content, wordAt);
      const head = declM[1] === "derived" ? "derived (read-only)" : "signal";
      const md: string[] = [`### \`${wordAt}\` — reactive ${head}`, ""];
      if (deps.length === 0) {
        md.push("_No static single-file dependents found._");
      } else {
        md.push("**Reactive dependents** _(static, single-file approximation):_", "");
        for (const d of deps) md.push(`- ${d.label} — line ${d.line + 1}`);
        md.push(
          "",
          "_Syntactic, single-file: misses dynamic / conditional / cross-file deps; may include shadowed names. The true graph is a runtime property._",
        );
      }
      return md.join("\n");
    }
  }

  if (wordAt === "schema") {
    return [
      "### `schema NAME = <body>` — data shape declaration",
      "",
      "Declares a runtime-validated JSON Schema. Emits:",
      "",
      "- `NAME.parse(v) → Result<NAME, str>` — fast inline validator",
      "- `NAME.schema` — the underlying JSON Schema 2020-12 object",
      "- field navigation accessors — `User.id.type`, `User.profile.bio.maxLength`, etc.",
      "",
      "Body is JSON Schema 2020-12 (Para extends `type` with `bigint`, `varchar`,",
      "`text`, `char`, `timestamptz`, `snowflake`, `numeric`, `jsonb`, `enum`).",
      "",
      "Forms:",
      "- `schema X = { ... }` — JSON Schema literal",
      "- `schema X from <expr>` — ingest an existing schema value (file import,",
      "  remote fetch, lockstep pg-models output)",
      "- `schema X { id: int, name: str(1..50) }` — Para-DSL with refinement types",
      "- `schema { ... }` (expression) — inline literal at value position",
      "",
      "```typescript",
      "schema User = {",
      "  type: 'object',",
      "  properties: { id: { type: 'bigint' }, email: { type: 'string', format: 'email' } },",
      "  required: ['id', 'email'],",
      "};",
      "",
      "const ok = User.parse(input);  // { tag: 'Ok', value: ... } | { tag: 'Err', error: ... }",
      "// Composing inline at a value slot:",
      "const ep = { request: schema { type: 'bigint' }, response: User };",
      "```",
    ].join("\n");
  }

  if (wordAt === "match") {
    return [
      "### `match EXPR { arm => result, ... }` — pattern matching expression",
      "",
      "Lowers to a switch (when arms are all literal-only or all Result/Option",
      "constructors) or a ternary chain (otherwise). Returns the result of the",
      "matching arm. The subject is evaluated once.",
      "",
      "Patterns:",
      '- Literals: `200 => "ok"`, OR alternatives via `1 | 2 | 3 => ...`',
      "- Wildcard: `_ => fallback`",
      "- Identifier bind: `n => n + 1` (n bound to subject)",
      "- Result/Option ctors: `Ok(user) => user.id`, `Err(e) => e`, `Some(x)`, `None`",
      "",
      "```typescript",
      "const msg = match status {",
      "  200 => 'ok',",
      "  400 | 404 => 'client error',",
      "  _ => 'unknown'",
      "};",
      "```",
    ].join("\n");
  }

  if (wordAt === "from" && /\bschema\s+[A-Za-z_$][\w$]*\s+from\b/.test(lineText)) {
    return [
      "### `schema X from <expr>` — ingest existing JSON Schema",
      "",
      "Lowers to `const X = __paraFromSchema(<expr>)`. Returns the same",
      "`{ parse, schema }` interface as native `schema X = { ... }` declarations.",
      "Works with any expression that evaluates to a JSON Schema 2020-12 object",
      "— file imports, locally-built schemas, lockstep pg-models output, etc.",
      "",
      "Runtime walker handles JSON Schema 2020-12 plus lockstep aliases",
      "(`bigint`, `varchar`, `text`, `char`, `timestamptz`, `snowflake`,",
      "`numeric`, `jsonb`, `enum`).",
      "",
      "```typescript",
      "import userSchema from './pg-models/user.json';",
      "schema User from userSchema;",
      "User.parse({ id: 1, email: 'a@b.c' });",
      "```",
    ].join("\n");
  }

  if (wordAt === "effect" && isEffectBlockAt(lineText, character)) {
    return [
      "### `effect { ... }` — reactive effect block",
      "",
      "Runs the body once immediately, tracks every signal `.get()` inside",
      "as a dependency, and re-runs when any dep changes. Returning a function",
      "from the body registers it as a cleanup — it fires before the next run",
      "and on dispose.",
      "",
      "`return` / `break` / `continue` are arrow-local (the body lifts into an",
      "arrow). `await` is rejected — the flush loop is synchronous.",
      "",
      "```typescript",
      "signal count = 0;",
      "effect {",
      "  console.log(count);",
      "  return () => console.log('cleanup', count);",
      "}",
      "```",
    ].join("\n");
  }

  const around = lineText.slice(Math.max(0, character - 3), character + 3);

  if (wordAt === "is" && /\bis\s+(?:not\s+)?[A-Z]/.test(lineText)) {
    return [
      "### `is` — runtime type-guard",
      "",
      "`expr is Type` returns true when `expr` validates as `Type`. Lowers to",
      '`(Type.parse(expr).tag === "Ok")` — never throws, just a boolean.',
      "Negate with `is not Type`.",
      "",
      "Triggers only when the right-hand side is a Capitalized identifier, so",
      "variables named `is` (`is + 1`, `is === foo`) keep their normal meaning.",
      "",
      "Composes with `if`, `when`, ternary, `&&`/`||`, and any other boolean",
      "context. For boundary enforcement (throw on bad shape) use `(arg:: Type)` instead.",
      "",
      "```typescript",
      "if (req is User) handleUser(req);",
      "const isUser = req is User;",
      "match input {",
      "  // _ is Type pattern coming in a follow-up",
      "}",
      "```",
    ].join("\n");
  }

  if (around.includes("::")) {
    return [
      "### `::` — per-arg validation marker",
      "",
      "Opts a function parameter into runtime validation. `(req:: User)` injects",
      "`User.parse(req)` at function entry, throwing on Err. Plain `(req: User)`",
      "stays as a TS-only annotation with no runtime overhead.",
      "",
      "Type must be a Para `model`-declared identifier in scope; JS builtins",
      "(`String`, `Number`, `Buffer`, `Promise`, etc.) are skipped to avoid",
      "phantom `.parse()` calls.",
      "",
      "```typescript",
      "function handler(req:: User, ctx) {",
      "  return req.email;  // req validated at entry — guaranteed shape",
      "}",
      "```",
    ].join("\n");
  }

  if (around.includes("..=")) {
    return [
      "### `..=` — inclusive range",
      "",
      "`a..=b` is the inclusive integer range from `a` to `b`. `a..b` is exclusive.",
      "Empty / inverted ranges produce `[]` (no throw).",
      "",
      "```typescript",
      "for (const i of 0..=5) work(i);   // 0,1,2,3,4,5",
      "const evens = 0..=20 |> filter(i => i % 2 === 0);",
      "```",
    ].join("\n");
  }
  if (around.includes("..!")) {
    return [
      "### `..!` — catch operator",
      "",
      "Attaches an error handler to a promise expression.",
      "",
      "```typescript",
      "fetchUser(id) ..! (err) => fallback",
      "// → fetchUser(id).catch((err) => fallback)",
      "```",
    ].join("\n");
  }
  if (around.includes("..&")) {
    return [
      "### `..&` — finally operator",
      "",
      "Attaches a cleanup handler that runs regardless of outcome.",
      "",
      "```typescript",
      "fetchUser(id) ..& () => cleanup()",
      "// → fetchUser(id).finally(() => cleanup())",
      "```",
    ].join("\n");
  }
  if (around.includes("..>")) {
    return [
      "### `..>` — then operator",
      "",
      "Attaches a fulfillment handler to a promise expression.",
      "",
      "```typescript",
      "fetch(url) ..> parse",
      "// → fetch(url).then(parse)",
      "```",
    ].join("\n");
  }
  if (/\b(parallel|para)\b/.test(around)) {
    return [
      "### `parallel` — fan-out promise composition",
      "",
      "Two forms — both run their RHSes in parallel via `Promise.all` while",
      "preserving the surface-syntax names (no positional-array footgun).",
      "`para` is an interchangeable shorthand — both keywords lower identically.",
      "",
      "**Expression form:**",
      "",
      "```typescript",
      "const { user, posts } = await parallel {",
      "  user: fetchUser(id),",
      "  posts: fetchPosts(id),",
      "};",
      "// → Promise.all([fetchUser(id), fetchPosts(id)])",
      "//      .then(([__pb0, __pb1]) => ({ user: __pb0, posts: __pb1 }));",
      "```",
      "",
      "**Statement form:**",
      "",
      "```typescript",
      "parallel let user = fetchUser(id), posts = fetchPosts(id);",
      "// → const [user, posts] = await Promise.all([fetchUser(id), fetchPosts(id)]);",
      "```",
      "",
      "`Promise.all` semantics — fail-fast on first rejection. Per-decl",
      "`..!` in the statement form gives independent fallbacks.",
    ].join("\n");
  }
  if (around.includes("~>")) {
    return [
      "### `~>` — reactive binding operator",
      "",
      "`A ~> B` creates a reactive binding: whenever the signals read by `A`",
      "change, `B` gets re-assigned with `A`'s new value. `B` must be",
      "assignable — an identifier or property access.",
      "",
      "Desugars to `require('@lyku/para-signals').effect(() => { B = A; })` —",
      "evaluating `A` in a tracked context and returning the disposer, so",
      "you can capture it: `const stop = src ~> dst;`.",
      "",
      "```typescript",
      "signal count = 0;",
      "count ~> elem.innerHTML;           // UI mirrors count",
      "count |> Math.abs ~> obj.absValue; // composes with |>",
      "const stop = count ~> other;       // capture disposer",
      "```",
    ].join("\n");
  }
  if (/(?<![\-=<])->/.test(around)) {
    return [
      "### `->` — reactive call-binding operator",
      "",
      "`A -> fn` creates a reactive call-binding: whenever the signals read",
      "by `A` change, `fn` is re-invoked with `A`'s new value. `fn` must be",
      "a callable target — an identifier, property access, or indexed",
      "function.",
      "",
      "Desugars to `require('@lyku/para-signals').effect(() => { fn(A); })` — the",
      "call-sink complement to `~>`. Same precedence, same disposer return,",
      "same optional `when COND` guard.",
      "",
      "```typescript",
      "signal count = 0;",
      "count -> log;                      // log(count) on every change",
      "`v=${count}` -> process.stdout.write; // template + signal sink",
      "count -> log when enabled;         // guarded call",
      "```",
    ].join("\n");
  }
  if (around.includes("|>")) {
    return [
      "### `|>` — pipeline operator",
      "",
      "Pipes a value through a function. Chains read left-to-right.",
      "",
      "```typescript",
      "data |> transform |> validate |> save",
      "// → save(validate(transform(data)))",
      "```",
    ].join("\n");
  }
  if (/\bwhen\b/.test(around) && /\{/.test(around)) {
    return [
      "### `when` — edge-triggered block (rising / falling)",
      "",
      "`when EXPR { BODY }` fires `BODY` once each time `EXPR` transitions",
      "false→true. `when not EXPR { BODY }` fires on the true→false edge.",
      "Reads inside `EXPR` are auto-tracked — every signal becomes a dep.",
      "",
      "**Paired form:** a bare `when not { BODY }` immediately following a",
      "`when EXPR { … }` block (no predicate after `not`) pairs with it as",
      "the inverse-edge handler, sharing the same predicate.",
      "",
      "Distinct from the suffix `when` clause used by `~>` / `->`: position",
      "disambiguates. Suffix `when` is an every-truthy guard; the block form",
      "is edge-triggered.",
      "",
      "Desugars to `require('@lyku/para-signals').when(() => EXPR, () => { BODY })`",
      "— the `not` form negates the predicate (`() => !(EXPR)`), and the paired",
      "form emits two such calls.",
      "",
      "```typescript",
      "when motion.detected.get() && bot.state.get() === 'idle' {",
      "  bot.say('Welcome back!');",
      "}",
      "",
      "// Paired form: bare `when not { … }` reuses the predicate above",
      "when connected { showOnlineBanner(); }",
      "when not       { showOfflineBanner(); }",
      "```",
    ].join("\n");
  }

  return null;
}

function getWordAt(line: string, col: number): string {
  let start = col;
  let end = col;
  while (start > 0 && /\w/.test(line[start - 1])) start--;
  while (end < line.length && /\w/.test(line[end])) end++;
  return line.slice(start, end);
}

// True when the cursor is sitting on the `signal` keyword of a `signal NAME =`
// declaration (as opposed to a plain identifier named `signal` imported from
// `@lyku/para-signals`). Gates the hover so `const x = signal(0)` — which is also
// valid — doesn't trigger the keyword tooltip.
function isSignalDeclarationAt(line: string, col: number): boolean {
  const word = findWordBounds(line, col);
  if (!word || line.slice(word.start, word.end) !== "signal") return false;
  return /^\s+[A-Za-z_$][\w$]*\s*[=,;:!]/.test(line.slice(word.end));
}

function isEffectBlockAt(line: string, col: number): boolean {
  const word = findWordBounds(line, col);
  if (!word || line.slice(word.start, word.end) !== "effect") return false;
  return /^\s*\{/.test(line.slice(word.end));
}

function findWordBounds(line: string, col: number): { start: number; end: number } | null {
  if (col > line.length) return null;
  let start = col;
  let end = col;
  while (start > 0 && /\w/.test(line[start - 1])) start--;
  while (end < line.length && /\w/.test(line[end])) end++;
  if (start === end) return null;
  return { start, end };
}

// ---------------------------------------------------------------------------
// Go-to-definition
// ---------------------------------------------------------------------------

function getDefinition(uri: string, content: string, line: number, character: number): any[] | null {
  if (!tsService || !ts) return null;

  const { fileName, offset } = resolveTsQuery(uri, content, line, character);

  try {
    const defs = tsService.getDefinitionAtPosition(fileName, offset);
    if (!defs || defs.length === 0) return null;

    return defs.map(def => {
      const realTargetPath = fromTsPath(def.fileName);
      const targetUri = pathToUri(realTargetPath);
      const targetContent = documents.get(targetUri);
      let startPos: LspPosition;
      let endPos: LspPosition;

      // Read the original source — prefer open document, fall back to disk
      const origContent =
        targetContent ??
        (() => {
          try {
            return require("fs").readFileSync(realTargetPath, "utf8") as string;
          } catch {
            return "";
          }
        })();
      const isParabun = /\.p(?:ts|tsx|js|jsx)$/.test(realTargetPath);

      if (realTargetPath.endsWith(".pui") && origContent) {
        // Target is a .pui: def.textSpan is in svelte2tsx output; map
        // back through that file's puiTransform sourcemap.
        const tt = getPuiTransform(targetUri, origContent);
        if (tt) {
          const s = offsetToPosition(tt.code, def.textSpan.start);
          const e = offsetToPosition(tt.code, def.textSpan.start + def.textSpan.length);
          startPos = tt.toOriginal(s.line, s.character) ?? { line: 0, character: 0 };
          endPos = tt.toOriginal(e.line, e.character) ?? startPos;
        } else {
          startPos = offsetToPosition(origContent, def.textSpan.start);
          endPos = offsetToPosition(origContent, def.textSpan.start + def.textSpan.length);
        }
      } else if (isParabun && origContent) {
        const targetTransformed = transformParabunToTS(origContent);
        const tStart = offsetToPosition(targetTransformed, def.textSpan.start);
        const tEnd = offsetToPosition(targetTransformed, def.textSpan.start + def.textSpan.length);
        startPos = mapPositionFromTransformed(origContent, targetTransformed, tStart.line, tStart.character);
        endPos = mapPositionFromTransformed(origContent, targetTransformed, tEnd.line, tEnd.character);
      } else {
        startPos = offsetToPosition(origContent, def.textSpan.start);
        endPos = offsetToPosition(origContent, def.textSpan.start + def.textSpan.length);
      }

      return {
        targetUri,
        targetRange: { start: startPos, end: endPos },
        targetSelectionRange: { start: startPos, end: endPos },
      };
    });
  } catch (e: any) {
    logMessage(2, `[parabun-lsp] TS definition error: ${e?.message ?? e}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Para schema registry — symbol-aware completions + diagnostics
// ---------------------------------------------------------------------------
//
// Scans the source for `schema X { ... }` / `schema X from <expr>` / imported
// models, and tracks them in a per-document registry. Used by completion to
// suggest `.parse` / `.schema` after a model identifier, and by diagnostics
// to flag `(req:: Foo)` when Foo isn't in scope.

interface ParaModelField {
  name: string;
  typeName: string; // raw type-name token (Email/UUID/User/int/...)
  optional: boolean;
}

interface ParaModelInfo {
  name: string;
  origin: "decl" | "from" | "import";
  fields: ParaModelField[]; // empty for from/import — opaque externally
}

// Recognized builtin refinement / format types (capitalized) — completions
// should offer these alongside user-defined models. Matches what the parser
// supports today.
const PARA_BUILTIN_TYPES = ["Email", "UUID", "Url", "Date", "DateTime", "IpV4", "IpV6", "Slug"];

// Lowercase primitives accepted in field-type positions inside `schema { ... }`.
const PARA_PRIMITIVE_TYPES = ["int", "str", "string", "bool", "boolean", "float", "num", "number"];

// JS/TS builtin type names skipped from `::` validation (mirrors parseFn.zig).
const JS_BUILTIN_TYPE_NAMES = new Set([
  "String",
  "Number",
  "Boolean",
  "Object",
  "Array",
  "Function",
  "Date",
  "RegExp",
  "Error",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "Symbol",
  "BigInt",
  "Buffer",
  "ArrayBuffer",
  "Uint8Array",
  "Int8Array",
  "Uint16Array",
  "Int16Array",
  "Uint32Array",
  "Int32Array",
  "Float32Array",
  "Float64Array",
  "DataView",
  "Iterator",
  "AsyncIterator",
  "Generator",
  "AsyncGenerator",
  "JSON",
  "Math",
  "Reflect",
  "Proxy",
]);

function extractModelRegistry(content: string): Map<string, ParaModelInfo> {
  const reg = new Map<string, ParaModelInfo>();

  // model X { fields }   — capture body to parse fields
  const declRe = /\b(?:export\s+)?schema\s+([A-Za-z_$][\w$]*)\s*\{([\s\S]*?)\n\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(content)) !== null) {
    reg.set(m[1], { name: m[1], origin: "decl", fields: parseFieldsBlock(m[2]) });
  }

  // model X from <expr> — opaque field list
  const fromRe = /\b(?:export\s+)?schema\s+([A-Za-z_$][\w$]*)\s+from\b/g;
  while ((m = fromRe.exec(content)) !== null) {
    if (!reg.has(m[1])) reg.set(m[1], { name: m[1], origin: "from", fields: [] });
  }

  // model X = <expr> — lockstep-style ingestion. Same opaque-field
  // treatment as `from`. Excludes the `schema X { ... }` form (which
  // has no `=`) since that's caught by declRe above.
  const eqRe = /\b(?:export\s+)?schema\s+([A-Za-z_$][\w$]*)\s*=/g;
  while ((m = eqRe.exec(content)) !== null) {
    if (!reg.has(m[1])) reg.set(m[1], { name: m[1], origin: "from", fields: [] });
  }

  // import { X, Y as Z } from "..." — anything imported as a capitalized
  // name MIGHT be a model. Add as opaque so `(req:: X)` doesn't false-flag.
  // Also catches `import default, { X } from "..."` patterns.
  const importRe = /\bimport\b[^{}]*\{([^}]+)\}\s*from\b/g;
  while ((m = importRe.exec(content)) !== null) {
    for (const part of m[1].split(",")) {
      const seg = part.trim();
      if (!seg) continue;
      // `Foo` or `Foo as Bar` — pick the local binding name (after `as`).
      const asMatch = seg.match(/(?:[A-Za-z_$][\w$]*\s+as\s+)?([A-Z][\w$]*)\s*$/);
      if (asMatch && !reg.has(asMatch[1])) {
        reg.set(asMatch[1], { name: asMatch[1], origin: "import", fields: [] });
      }
    }
  }

  return reg;
}

function parseFieldsBlock(body: string): ParaModelField[] {
  const fields: ParaModelField[] = [];
  // Strip line comments for cleaner parsing.
  const stripped = body.replace(/\/\/[^\n]*/g, "");
  // Each field: `name: type` (with optional `(...)` range / `[T]` array /
  // `?` optional / `"a" | "b"` literal-union). We capture name + raw type
  // segment up to `,` / `;` / newline.
  const fieldRe = /([A-Za-z_$][\w$]*)\s*:\s*([^,;\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = fieldRe.exec(stripped)) !== null) {
    const name = m[1];
    let typeFrag = m[2].trim();
    const optional = typeFrag.endsWith("?");
    if (optional) typeFrag = typeFrag.slice(0, -1).trim();
    // Strip range `(0..150)` / array brackets / literal-union — keep the
    // base type name for hover/completion purposes.
    typeFrag = typeFrag.replace(/\([^)]*\)/g, "").trim();
    typeFrag = typeFrag.replace(/^\[|\](.*)/g, "").trim();
    const baseMatch = typeFrag.match(/^([A-Za-z_$][\w$]*)/);
    const typeName = baseMatch ? baseMatch[1] : typeFrag;
    fields.push({ name, typeName, optional });
  }
  return fields;
}

// Lightweight "Cannot find name" detection that runs in the fast pass
// (no tsc, ~5 ms per file). Catches the most common kind of typo — a
// referenced identifier that isn't imported, declared anywhere in the
// file, or a known global. tsc would catch the same error eventually
// via TS2304/TS2552 but only after the cold semantic pass (10-40 s on
// @lyku-sized graphs). Surfacing this in the fast pass means the user
// sees `schsharedDraft` flagged within ~270 ms of typing it instead
// of waiting for the helper subprocess to cold-load.
//
// Conservative on purpose: false positives are worse than missed
// catches because every spurious squiggle erodes trust. The scanner
// SKIPS identifiers in any of these positions because resolving them
// correctly needs the full TS type-checker:
//   - After `.` (property access)
//   - Inside a type annotation (after `:` but not `::`)
//   - Inside `typeof X` / `keyof X` / `infer X` / `extends X` /
//     `implements X` / `new X` / `as X`
//   - In a JSX tag-name position
//   - Inside a string literal, template literal, regex, or comment
//   - On the LHS of a declaration
//   - As an object-literal property key
function findUnknownIdentifierDiagnostics(content: string, sourceUri: string): LspDiagnostic[] {
  const isPui = isPuiUri(sourceUri);
  if (!isPui && !/\.(pts|ptsx|pjs|pjsx)$/.test(uriToPath(sourceUri))) return [];

  // For `.pui` the fast typo/undefined detector must scan ONLY the
  // parabun <script> bodies — blank everything else (markup, other
  // script langs) length-preservingly so markup tag/attr names don't
  // false-positive and so offsets stay absolute into `content` (the
  // ranges below use offsetToPosition(content,…) directly). Without
  // this `.pui` got NO fast undefined-name detection — it bailed on the
  // extension and only the slow 10-40 s cold pass ran (unreliable on a
  // real layout), so typos like `mosudnt` / a retired `mount;` slipped
  // through entirely.
  const scanBase = isPui ? maskOutsideParabunScripts(content) : content;

  // Mask string/template/regex/comment content so identifier scanning
  // doesn't pick up words inside them. Length-preserving so all offsets
  // stay valid for line/column conversion downstream.
  const masked = maskStringsAndComments(scanBase);

  // Collect the in-scope name set: imports + top-level declarations +
  // function/method parameters + catch-bindings + common globals.
  const inScope = new Set<string>(KNOWN_GLOBAL_IDENTIFIERS);

  // 1. Imports.
  const importRe =
    /\bimport(?:\s+type)?\s+(?:(\*\s+as\s+[A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)(?:\s*,\s*\{([^}]*)\})?|\{([^}]*)\})\s+from\s+["'][^"']+["']/g;
  let im: RegExpExecArray | null;
  while ((im = importRe.exec(masked)) !== null) {
    if (im[1]) {
      const m2 = im[1].match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
      if (m2) inScope.add(m2[1]);
    }
    if (im[2]) inScope.add(im[2]);
    const namedList = im[3] ?? im[4];
    if (namedList) {
      for (const raw of namedList.split(",")) {
        const item = raw.trim().replace(/^type\s+/, "");
        if (!item) continue;
        const asMatch = item.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
        const local = asMatch ? asMatch[2] : item.match(/^([A-Za-z_$][\w$]*)/)?.[1];
        if (local) inScope.add(local);
      }
    }
  }

  // 2. Declarations: const/let/var/function/class/enum/type/interface.
  const declRe =
    /\b(?:export\s+(?:default\s+)?)?(?:const|let|var|function|async\s+function|class|enum|type|interface|namespace|module)\s+([A-Za-z_$][\w$]*)/g;
  let dm: RegExpExecArray | null;
  while ((dm = declRe.exec(masked)) !== null) inScope.add(dm[1]);

  // 3. Top-level destructuring: `const { a, b: c, d = 1 } = ...`.
  //    Bails on nested `{` because we don't have a real parser.
  const destructRe = /\b(?:const|let|var)\s+\{([^{}]*)\}\s*=/g;
  let dem: RegExpExecArray | null;
  while ((dem = destructRe.exec(masked)) !== null) {
    for (const raw of dem[1].split(",")) {
      const item = raw.trim();
      if (!item) continue;
      const colonMatch = item.match(/^[A-Za-z_$][\w$]*\s*:\s*([A-Za-z_$][\w$]*)/);
      const eqMatch = item.match(/^([A-Za-z_$][\w$]*)\s*=/);
      const bareMatch = item.match(/^([A-Za-z_$][\w$]*)$/);
      const name = colonMatch?.[1] ?? eqMatch?.[1] ?? bareMatch?.[1];
      if (name) inScope.add(name);
    }
  }
  // Array-form destructure: `const [a, b, ...rest] = ...`. Same
  // over-permissive shape as the param handler — extract every
  // identifier in the bracket body. Holes like `const [, x] = arr`
  // work because empty splits get skipped via the identifier match.
  const arrayDestructRe = /\b(?:const|let|var)\s+\[([^\[\]]*)\]\s*=/g;
  let adm: RegExpExecArray | null;
  while ((adm = arrayDestructRe.exec(masked)) !== null) {
    const idRe = /[A-Za-z_$][\w$]*/g;
    let im: RegExpExecArray | null;
    while ((im = idRe.exec(adm[1])) !== null) inScope.add(im[0]);
  }

  // 4. Function / arrow / method parameters. Earlier rev bailed out
  // when params contained `{` or `[` (destructuring), which silently
  // missed every name bound inside an array/object pattern — including
  // the common case `[, table]` / `{ a, b }` / `{ a: b }`. Real fix
  // would need an AST, but the over-permissive heuristic below clears
  // ~90% of the false-positive squiggles: when destructuring is
  // detected, just add every identifier in the param substring to
  // inScope. The cost is occasional over-permission (e.g. property
  // keys in `{ a: b }` get added even though `a` is the key not the
  // binding) — but inScope is an allowlist; over-broad permission
  // doesn't cause MISSED-name diagnostics, only restrictive checks do.
  // Reserved words / built-ins are filtered separately by the use-
  // scanner so adding `return` etc. is harmless.
  const paramRe =
    /(?:\bfunction\b|\bfun\b)\s*[A-Za-z_$][\w$]*?\s*\(([^()]*)\)|\b[A-Za-z_$][\w$]*\s*\(([^()]*)\)\s*\{|\(([^()]*)\)\s*=>/g;
  let pm: RegExpExecArray | null;
  while ((pm = paramRe.exec(masked)) !== null) {
    const params = pm[1] ?? pm[2] ?? pm[3];
    if (!params) continue;
    if (/[{[]/.test(params)) {
      // Destructuring path — extract every identifier.
      const idRe = /[A-Za-z_$][\w$]*/g;
      let im: RegExpExecArray | null;
      while ((im = idRe.exec(params)) !== null) inScope.add(im[0]);
      continue;
    }
    // Flat-param path — pre-existing per-binding strip.
    for (const raw of params.split(",")) {
      const stripped = raw
        .trim()
        .replace(/^\.\.\./, "")
        .replace(/=\s*[\s\S]*$/, "")
        .replace(/:\s*[\s\S]*$/, "")
        .replace(/\?/, "")
        .trim();
      const m2 = stripped.match(/^([A-Za-z_$][\w$]*)$/);
      if (m2) inScope.add(m2[1]);
    }
  }

  // 5. catch bindings.
  const catchRe = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g;
  let cm: RegExpExecArray | null;
  while ((cm = catchRe.exec(masked)) !== null) inScope.add(cm[1]);

  // Now scan identifier USES.
  const diags: LspDiagnostic[] = [];
  const useRe = /(?<![\w$.])([A-Za-z_$][\w$]*)(?![\w$])/g;
  let um: RegExpExecArray | null;
  while ((um = useRe.exec(masked)) !== null) {
    const name = um[1];
    if (inScope.has(name)) continue;
    if (RESERVED_WORDS.has(name)) continue;

    const start = um.index;
    const before = masked.slice(Math.max(0, start - 64), start);
    const after = masked.slice(start + name.length, start + name.length + 16);

    // Skip if this is a declaration site (regex order means newly-declared
    // names may not yet be added when first encountered).
    if (
      /\b(?:const|let|var|function|async\s+function|fun|class|enum|type|interface|namespace|module|import(?:\s+type)?)\s*(?:\{\s*)?$/.test(
        before,
      )
    )
      continue;
    // Object-literal property key (`name:`, but not `name::`).
    if (/^\s*:(?!:)/.test(after)) continue;
    // Object-shorthand method: `{ name() { ... } }`.
    if (/^\s*\(/.test(after) && /[,{]\s*$/.test(before)) continue;
    // NOTE: deliberately do NOT skip identifiers after `: ` — that
    // boundary is ambiguous between type-annotation position
    // (`const x: Type`) and object-literal value position
    // (`{ key: value }`). Skipping all `: ` swallowed the most useful
    // catch (`{ schema: schsharedDraft }`). Rely on the allowlist
    // (KNOWN_GLOBAL_IDENTIFIERS + COMMON_TYPE_NAMES) to avoid
    // false-positives on the type-annotation form.
    // `as Type` cast.
    if (/\bas\s+$/.test(before)) continue;
    // Generic arg position.
    if (/<\s*$/.test(before)) continue;
    // `typeof X` / `keyof X` / `infer X`.
    if (/\b(?:typeof|keyof|infer)\s+$/.test(before)) continue;
    // `extends X` / `implements X` / `new X`.
    if (/\b(?:extends|implements|new)\s+$/.test(before)) continue;
    // JSX tag (capitalized followed by `<` or `/>`).
    if (/^[A-Z]/.test(name) && /^\s*[</]/.test(after)) continue;

    const startPos = offsetToPosition(content, start);
    const endPos = offsetToPosition(content, start + name.length);
    diags.push({
      range: { start: startPos, end: endPos },
      severity: 1,
      source: "parabun",
      message: `Cannot find name '${name}'`,
      code: "parabun-unknown-identifier",
    });
  }

  return diags;
}

// Common globals — conservative list. A missed global = false positive
// squiggle (annoying); a wrongly-allowed identifier = missed real error.
const KNOWN_GLOBAL_IDENTIFIERS = new Set<string>([
  // ─── codegen:lsp-allowlist:begin ──────────────────────────────────
  // AUTO-GENERATED from src/language-surface.ts. Run `bun scripts/generate-lsp-allowlist.ts`
  // to regenerate. The CI gate at scripts/codegen/check-clean.ts fails
  // if the committed contents drift from the catalog. Do not hand-edit
  // — add new Para tokens to LSP_ALLOWLIST_TOKENS in language-surface.ts
  // instead.
  "_",
  "signal",
  "derived",
  "effect",
  "source",
  "when",
  "arena",
  "memo",
  "defer",
  "schema",
  "cyclic",
  "match",
  "pure",
  "Ok",
  "Err",
  "Some",
  "None",
  "para",
  "parallel",
  // ─── codegen:lsp-allowlist:end ────────────────────────────────────
  "globalThis",
  "window",
  "document",
  "console",
  "process",
  "Math",
  "JSON",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Date",
  "RegExp",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "Symbol",
  "BigInt",
  "Proxy",
  "Reflect",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "URIError",
  "EvalError",
  "Function",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "setImmediate",
  "clearImmediate",
  "queueMicrotask",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURI",
  "decodeURI",
  "encodeURIComponent",
  "decodeURIComponent",
  "NaN",
  "Infinity",
  "undefined",
  "Atomics",
  "Intl",
  "WebAssembly",
  "fetch",
  "Request",
  "Response",
  "Headers",
  "Blob",
  "File",
  "FormData",
  "URL",
  "URLSearchParams",
  "TextEncoder",
  "TextDecoder",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "AbortController",
  "AbortSignal",
  "crypto",
  "WebSocket",
  "Worker",
  "MessageChannel",
  "MessagePort",
  "BroadcastChannel",
  "Event",
  "EventTarget",
  "CustomEvent",
  "MessageEvent",
  "Bun",
  "require",
  "module",
  "exports",
  "__dirname",
  "__filename",
  "Buffer",
  "performance",
  "React",
  "Ok",
  "Err",
  "Some",
  "None",
  "this",
  "super",
  "arguments",
  // Common TS type names — included so type-position identifiers
  // don't false-positive (we deliberately don't skip `: T`
  // boundaries because they're ambiguous with object-literal
  // values).
  "string",
  "number",
  "boolean",
  "void",
  "any",
  "unknown",
  "never",
  "object",
  "bigint",
  "symbol",
  "Record",
  "Partial",
  "Required",
  "Readonly",
  "Pick",
  "Omit",
  "Exclude",
  "Extract",
  "NonNullable",
  "Parameters",
  "ReturnType",
  "InstanceType",
  "ConstructorParameters",
  "ThisType",
  "Awaited",
  "Capitalize",
  "Uncapitalize",
  "Uppercase",
  "Lowercase",
  "ReadonlyArray",
  "Iterable",
  "AsyncIterable",
  "IterableIterator",
  "Iterator",
  "ArrayLike",
  "PromiseLike",
]);

const RESERVED_WORDS = new Set<string>([
  "if",
  "else",
  "while",
  "for",
  "do",
  "return",
  "break",
  "continue",
  "switch",
  "case",
  "default",
  "throw",
  "try",
  "catch",
  "finally",
  "function",
  "fun",
  "class",
  "interface",
  "extends",
  "implements",
  "const",
  "let",
  "var",
  "import",
  "export",
  "from",
  "as",
  "type",
  "enum",
  "namespace",
  "module",
  "declare",
  "abstract",
  "static",
  "public",
  "private",
  "protected",
  "readonly",
  "async",
  "await",
  "yield",
  "of",
  "in",
  "instanceof",
  "typeof",
  "void",
  "delete",
  "new",
  "true",
  "false",
  "null",
  "is",
  "satisfies",
  "infer",
  "keyof",
  "unique",
  "out",
  "override",
  "schema",
  "signal",
  "derived",
  "effect",
  "when",
  "memo",
  "pure",
  "match",
  "arena",
  "parallel",
  "para",
]);

// Diagnostic: `(arg:: Type)` where Type isn't in the model registry.
function findUnknownValidationTypeDiagnostics(content: string): LspDiagnostic[] {
  const diags: LspDiagnostic[] = [];
  const reg = extractModelRegistry(content);
  // Match `argname:: TypeName` and capture the position of TypeName.
  // Skip JS builtins (matches parseFn skip list).
  const re = /([A-Za-z_$][\w$]*)\s*::\s*([A-Z][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const typeName = m[2];
    if (JS_BUILTIN_TYPE_NAMES.has(typeName)) continue;
    if (PARA_BUILTIN_TYPES.includes(typeName)) continue;
    if (reg.has(typeName)) continue;
    const start = m.index + m[1].length + (m[0].length - m[1].length - typeName.length);
    const end = m.index + m[0].length;
    diags.push({
      range: { start: offsetToPosition(content, start), end: offsetToPosition(content, end) },
      severity: 1,
      source: "parabun",
      message: `Unknown type '${typeName}' for \`::\` validation marker — declare a \`schema ${typeName} = { ... }\` or import one`,
      code: "parabun-unknown-validate-type",
    });
  }
  return diags;
}

// ---------------------------------------------------------------------------
// `schema X = { body }` / `schema { body }` JSON Schema body validation
// ---------------------------------------------------------------------------
//
// `schema` is the data-shape primitive. Top-level keys must come from
// the JSON Schema 2020-12 vocabulary (plus a small set of Para / lockstep
// DDL extensions). HTTP-endpoint shapes are no longer in scope for the
// `schema` primitive — those live in plain JS objects and are
// lockstep's concern, not Para's.

const SCHEMA_KEYWORDS = new Set([
  "type",
  "properties",
  "items",
  "enum",
  "const",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "$ref",
  "$id",
  "$defs",
  "$schema",
  "$comment",
  "$anchor",
  "$dynamicRef",
  "$dynamicAnchor",
  "$vocabulary",
  "definitions",
  "required",
  "additionalProperties",
  "minProperties",
  "maxProperties",
  "minItems",
  "maxItems",
  "uniqueItems",
  "prefixItems",
  "contains",
  "minContains",
  "maxContains",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "default",
  "examples",
  "description",
  "title",
  "propertyNames",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
  "if",
  "then",
  "else",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
  "deprecated",
  "readOnly",
  "writeOnly",
  // Para / lockstep DDL extensions — recognized on column-shape models
  // (pg-models) and treated as schema keywords for diagnostic purposes.
  "length",
  "unique",
  "primaryKey",
  "indexed",
  "references",
  "foreignKey",
  "autoIncrement",
  "generated",
  "collation",
  "nullable",
]);

interface ModelTopEntry {
  key: string;
  keyStart: number;
  keyEnd: number;
  valueStart: number;
  valueEnd: number;
  valueText: string;
}

// Walk a `schema X = { ... }` body (between `{` and `}`, exclusive) and
// return every top-level `key: value` pair. Tracks string/comment/brace
// state so nested `properties: { foo: ... }` keys aren't mistaken for
// top-level. `baseOffset` is where the body sits in the original document
// so emitted positions can be mapped back without an extra pass.
function walkModelTopEntries(body: string, baseOffset: number): ModelTopEntry[] {
  const entries: ModelTopEntry[] = [];
  let i = 0;
  let depth = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      i++;
      while (i < body.length && body[i] !== q) {
        if (body[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "/" && body[i + 1] === "/") {
      while (i < body.length && body[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && body[i + 1] === "*") {
      i += 2;
      while (i < body.length - 1 && !(body[i] === "*" && body[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") {
      depth++;
      i++;
      continue;
    }
    if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      i++;
      continue;
    }
    if (depth === 0 && /[A-Za-z_$]/.test(ch)) {
      const keyStart = i;
      while (i < body.length && /[\w$]/.test(body[i])) i++;
      const keyEnd = i;
      const key = body.slice(keyStart, keyEnd);
      let j = i;
      while (j < body.length && /\s/.test(body[j])) j++;
      // Shorthand `{ request, response }` — the identifier is both the
      // key and (an implicit reference to) the value. Treat the value
      // span as the identifier itself so type-checks see "identifier".
      if (body[j] === "," || body[j] === "}" || j === body.length) {
        entries.push({
          key,
          keyStart: baseOffset + keyStart,
          keyEnd: baseOffset + keyEnd,
          valueStart: baseOffset + keyStart,
          valueEnd: baseOffset + keyEnd,
          valueText: key,
        });
        i = j;
        continue;
      }
      if (body[j] !== ":") continue;
      let k = j + 1;
      while (k < body.length && /\s/.test(body[k])) k++;
      const valueStart = k;
      let valDepth = 0;
      while (k < body.length) {
        const vc = body[k];
        if (vc === '"' || vc === "'" || vc === "`") {
          const q = vc;
          k++;
          while (k < body.length && body[k] !== q) {
            if (body[k] === "\\") k++;
            k++;
          }
          k++;
          continue;
        }
        if (vc === "/" && body[k + 1] === "/") {
          while (k < body.length && body[k] !== "\n") k++;
          continue;
        }
        if (vc === "/" && body[k + 1] === "*") {
          k += 2;
          while (k < body.length - 1 && !(body[k] === "*" && body[k + 1] === "/")) k++;
          k += 2;
          continue;
        }
        if (vc === "{" || vc === "[" || vc === "(") valDepth++;
        else if (vc === "}" || vc === "]" || vc === ")") valDepth--;
        else if (valDepth === 0 && (vc === "," || vc === ";")) break;
        k++;
      }
      let valueEnd = k;
      while (valueEnd > valueStart && /\s/.test(body[valueEnd - 1])) valueEnd--;
      entries.push({
        key,
        keyStart: baseOffset + keyStart,
        keyEnd: baseOffset + keyEnd,
        valueStart: baseOffset + valueStart,
        valueEnd: baseOffset + valueEnd,
        valueText: body.slice(valueStart, valueEnd),
      });
      i = k;
      continue;
    }
    i++;
  }
  return entries;
}

function classifyModelValue(
  text: string,
): "boolean-true" | "boolean-false" | "number" | "string" | "array" | "object" | "identifier" | "unknown" {
  const t = text.trim();
  if (t === "true") return "boolean-true";
  if (t === "false") return "boolean-false";
  if (/^-?\d/.test(t)) return "number";
  if (/^["'`]/.test(t)) return "string";
  if (t.startsWith("[")) return "array";
  if (t.startsWith("{")) return "object";
  if (/^[A-Za-z_$]/.test(t)) return "identifier";
  return "unknown";
}

// Quick edit-distance for "did you mean…" — full Levenshtein but capped at
// distance 4 (cheap enough for these short keyword sets).
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length,
    n = b.length;
  if (Math.abs(m - n) > 4) return 99;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

function suggestKey(unknown: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  let bestDist = 4;
  for (const c of candidates) {
    const d = editDistance(unknown.toLowerCase(), c.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

function findModelBodyDiagnostics(content: string): LspDiagnostic[] {
  const diags: LspDiagnostic[] = [];
  const declRe = /\b(?:export\s+)?schema\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(content)) !== null) {
    const modelName = m[1];
    const openIdx = m.index + m[0].length - 1; // position of `{`
    // Walk to matching `}` with string/comment awareness.
    let i = openIdx + 1;
    let depth = 1;
    while (i < content.length && depth > 0) {
      const ch = content[i];
      if (ch === '"' || ch === "'" || ch === "`") {
        const q = ch;
        i++;
        while (i < content.length && content[i] !== q) {
          if (content[i] === "\\") i++;
          i++;
        }
        i++;
        continue;
      }
      if (ch === "/" && content[i + 1] === "/") {
        while (i < content.length && content[i] !== "\n") i++;
        continue;
      }
      if (ch === "/" && content[i + 1] === "*") {
        i += 2;
        while (i < content.length - 1 && !(content[i] === "*" && content[i + 1] === "/")) i++;
        i += 2;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    if (depth !== 0) continue;
    const closeIdx = i - 1;
    const body = content.slice(openIdx + 1, closeIdx);
    const entries = walkModelTopEntries(body, openIdx + 1);
    if (entries.length === 0) continue;

    const keysSeen = new Set(entries.map(e => e.key));
    // Lockstep records have `properties` without top-level `type` — leave
    // those alone since they're an established pattern that lockstep
    // generates from postgres column shapes.
    const looksLikeRecord = keysSeen.has("properties") && !keysSeen.has("type");
    if (looksLikeRecord) continue;
    for (const entry of entries) {
      if (SCHEMA_KEYWORDS.has(entry.key)) continue;
      const suggestion = suggestKey(entry.key, SCHEMA_KEYWORDS);
      const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
      diags.push({
        range: {
          start: offsetToPosition(content, entry.keyStart),
          end: offsetToPosition(content, entry.keyEnd),
        },
        severity: 1,
        source: "parabun",
        message: `'${entry.key}' is not a JSON Schema keyword on \`schema ${modelName}\`${hint}`,
        code: "parabun-unknown-schema-key",
      });
    }
  }
  return diags;
}

// Scan back from the cursor to detect "we're after a known model identifier
// followed by `.`" — used to inject `parse` / `schema` completions.
function detectModelMemberAccessContext(content: string, line: number, character: number): string | null {
  const offset = positionToOffset(content, line, character);
  // Walk backwards: skip whitespace, then identifier chars, then a `.`,
  // then identifier chars again. The second identifier is the model name.
  let i = offset - 1;
  while (i >= 0 && /[\w$]/.test(content[i])) i--;
  if (i < 0 || content[i] !== ".") return null;
  let nameEnd = i;
  let nameStart = i - 1;
  while (nameStart >= 0 && /[\w$]/.test(content[nameStart])) nameStart--;
  const ident = content.slice(nameStart + 1, nameEnd);
  if (!ident || !/^[A-Z]/.test(ident)) return null;
  return ident;
}

// Detect "we're after `arg:: ` (typing the type identifier)" — used to
// suggest known model names + builtin types.
function detectValidationMarkerContext(content: string, line: number, character: number): boolean {
  const offset = positionToOffset(content, line, character);
  // Walk back over the partially-typed identifier.
  let i = offset - 1;
  while (i >= 0 && /[\w$]/.test(content[i])) i--;
  // Skip whitespace.
  while (i >= 0 && /\s/.test(content[i])) i--;
  // Expect `::`.
  return i >= 1 && content[i] === ":" && content[i - 1] === ":";
}

// Detect "we're inside a `schema X { ... }` body, typing a field type
// (after `:` but before `,`/`;`/`}`)" — used to suggest builtin types
// + other models.
function detectModelFieldTypeContext(content: string, line: number, character: number): boolean {
  const offset = positionToOffset(content, line, character);
  // Look back to find the nearest `:` that's not preceded by another `:`.
  let i = offset - 1;
  while (i >= 0 && /[\w$\s\[\]\?]/.test(content[i])) i--;
  if (i < 0 || content[i] !== ":" || content[i - 1] === ":") return false;
  // Now walk back further, find a `{`. If we find `,` or `;` before `{`,
  // we're separating fields — still inside a model body.
  let depth = 0;
  for (let j = i - 1; j >= 0; j--) {
    const ch = content[j];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth === 0) {
        // Look for `schema NAME` on the line containing this `{`.
        const lineStart = content.lastIndexOf("\n", j) + 1;
        const head = content.slice(lineStart, j);
        return /\bmodel\s+[A-Za-z_$][\w$]*\s*$/.test(head);
      }
      depth--;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Completions — TypeScript + Parabun keywords
// ---------------------------------------------------------------------------

const parabunCompletions = [
  {
    label: "fun",
    kind: 14,
    detail: "Parabun: function (shorthand)",
    insertText: "fun ",
  },
  {
    label: "fun (declaration)",
    kind: 15,
    detail: "Parabun: function declaration",
    insertText: "fun ${1:name}(${2:params}) {\n\t${0}\n}",
    insertTextFormat: 2,
  },
  {
    label: "pure",
    kind: 14,
    detail: "Parabun: pure function modifier",
    insertText: "pure ",
  },
  {
    label: "pure fun",
    kind: 15,
    detail: "Parabun: pure function declaration",
    insertText: "pure fun ${1:name}(${2:params}) {\n\t${0}\n}",
    insertTextFormat: 2,
  },
  {
    label: "pure async fun",
    kind: 15,
    detail: "Parabun: pure async function declaration",
    insertText: "pure async fun ${1:name}(${2:params}) {\n\t${0}\n}",
    insertTextFormat: 2,
  },
  {
    label: "memo",
    kind: 15,
    detail: "Parabun: memoized pure function declaration",
    insertText: "memo ${1:name}(${2:params}) {\n\t${0}\n}",
    insertTextFormat: 2,
  },
  {
    label: "memo async",
    kind: 15,
    detail: "Parabun: memoized pure async function declaration",
    insertText: "memo async ${1:name}(${2:params}) {\n\t${0}\n}",
    insertTextFormat: 2,
  },
  {
    label: "defer",
    kind: 14,
    detail: "Parabun: schedule disposal on block exit",
    insertText: "defer ${0};",
    insertTextFormat: 2,
  },
  {
    label: "defer await",
    kind: 14,
    detail: "Parabun: schedule async disposal on block exit (async fn only)",
    insertText: "defer await ${0};",
    insertTextFormat: 2,
  },
  {
    label: "parallel { … }",
    kind: 14,
    detail: "Parabun: fan-out promise composition (expression form)",
    insertText: "parallel {\n  ${1:key}: ${2:expr},\n}",
    insertTextFormat: 2,
  },
  {
    label: "parallel let",
    kind: 14,
    detail: "Parabun: fan-out promise composition (statement form)",
    insertText: "parallel let ${1:name} = ${2:expr};",
    insertTextFormat: 2,
  },
  {
    label: "para { … }",
    kind: 14,
    detail: "Parabun: fan-out promise composition (expression form, shorthand for `parallel`)",
    insertText: "para {\n  ${1:key}: ${2:expr},\n}",
    insertTextFormat: 2,
  },
  {
    label: "para let",
    kind: 14,
    detail: "Parabun: fan-out promise composition (statement form, shorthand for `parallel`)",
    insertText: "para let ${1:name} = ${2:expr};",
    insertTextFormat: 2,
  },
  {
    label: "..=",
    kind: 24,
    detail: "Parabun: inclusive range (`a..=b` includes b)",
    insertText: "..= ",
  },
  {
    label: "..!",
    kind: 24,
    detail: "Parabun: catch operator",
    insertText: "..! ",
  },
  {
    label: "..&",
    kind: 24,
    detail: "Parabun: finally operator",
    insertText: "..& ",
  },
  {
    label: "..>",
    kind: 24,
    detail: "Parabun: then operator",
    insertText: "..> ",
  },
  {
    label: "|>",
    kind: 24,
    detail: "Parabun: pipeline operator",
    insertText: "|> ",
  },
];

function getCompletions(
  uri: string,
  content: string,
  line: number,
  character: number,
): { isIncomplete: boolean; items: any[] } {
  const items: any[] = [...parabunCompletions];

  // ── Para model-aware completions ──────────────────────────────────
  // 1. After `<ModelName>.` → suggest `parse` and `schema`.
  const memberAccess = detectModelMemberAccessContext(content, line, character);
  if (memberAccess) {
    const reg = extractModelRegistry(content);
    if (reg.has(memberAccess)) {
      items.push(
        {
          label: "parse",
          kind: 2, // method
          detail: "(v: any) → Result<T, str>",
          documentation:
            "Validate a value against this model's schema. Returns `{ tag: 'Ok', value }` or `{ tag: 'Err', error }`.",
          insertText: "parse(${1:value})",
          insertTextFormat: 2,
          sortText: "0parse",
        },
        {
          label: "schema",
          kind: 10, // property
          detail: "JSON Schema 2020-12 object",
          documentation:
            "JSON Schema object describing this model's shape — hand off to OpenAPI / MongoDB / external validators.",
          sortText: "0schema",
        },
      );
    }
  }

  // 2. After `arg:: ` → suggest known models + builtin refinement types.
  if (detectValidationMarkerContext(content, line, character)) {
    const reg = extractModelRegistry(content);
    for (const name of reg.keys()) {
      items.push({
        label: name,
        kind: 8, // interface
        detail: `Para schema${reg.get(name)!.origin === "from" ? " (ingested)" : reg.get(name)!.origin === "import" ? " (imported)" : ""}`,
        sortText: "0" + name,
      });
    }
    for (const t of PARA_BUILTIN_TYPES) {
      items.push({ label: t, kind: 7, detail: "Para builtin refinement", sortText: "1" + t });
    }
  }

  // 3. Inside `schema X { fieldname: <here>` → suggest builtin types + other models.
  if (detectModelFieldTypeContext(content, line, character)) {
    const reg = extractModelRegistry(content);
    for (const t of PARA_PRIMITIVE_TYPES) {
      items.push({ label: t, kind: 7, detail: "Para primitive", sortText: "0" + t });
    }
    for (const t of PARA_BUILTIN_TYPES) {
      items.push({ label: t, kind: 7, detail: "Para refinement", sortText: "1" + t });
    }
    for (const name of reg.keys()) {
      items.push({ label: name, kind: 8, detail: "Para schema (nested ref)", sortText: "2" + name });
    }
  }

  if (tsService && ts) {
    const { fileName, offset } = resolveTsQuery(uri, content, line, character);

    try {
      const completions = tsService.getCompletionsAtPosition(fileName, offset, undefined);
      if (completions) {
        for (const entry of completions.entries.slice(0, 100)) {
          items.push({
            label: entry.name,
            kind: tsCompletionKindToLsp(entry.kind),
            detail: entry.kind,
            sortText: entry.sortText,
            insertText: entry.insertText ?? entry.name,
          });
        }
      }
    } catch {
      // TS completions unavailable
    }
  }

  return { isIncomplete: false, items };
}

function tsCompletionKindToLsp(kind: string): number {
  const map: Record<string, number> = {
    keyword: 14,
    function: 3,
    method: 2,
    property: 10,
    variable: 6,
    class: 7,
    interface: 8,
    enum: 13,
    module: 9,
    type: 8,
    constant: 21,
    string: 15,
  };
  return map[kind] ?? 1;
}

// ---------------------------------------------------------------------------
// Code Actions
// ---------------------------------------------------------------------------

interface TextEdit {
  range: LspRange;
  newText: string;
}

interface CodeAction {
  title: string;
  kind: string;
  diagnostics?: LspDiagnostic[];
  edit?: { changes: Record<string, TextEdit[]> };
}

// Convert a TS `interface NAME { ... }` or `type NAME = { ... }` to one or
// more Para `schema NAME { ... }` declarations. Nested object types are
// auto-extracted to separate models named `<Parent><Field>` (capitalized);
// the outer field then references that synthetic model by name.
//
// Mapping notes:
//   `interface X { ... }`     → `schema X { ... }`
//   `type X = { ... }`         → `schema X { ... }`
//   `field?: T`                → `field: T?`            (Para uses postfix optional)
//   `field: T[]`               → `field: [T]`            (Para uses bracket array)
//   `field: Array<T>`          → `field: [T]`
//   `field: { ... }`           → `field: <Parent><Field>` + extracted nested model
//   `field: "a" | "b"`         → preserved verbatim
//   primitives passed through  (`number` / `string` / `boolean` accepted by Para).
function buildInterfaceToModelEdit(
  content: string,
  lines: string[],
  startLine: number,
  match: RegExpMatchArray,
): { range: LspRange; newText: string } | null {
  const indent = match[1] || "";
  const exportKw = match[2] || "";
  const name = match[4];

  // Find the line offset of `{` (after the optional `=` for type aliases).
  let openLine = startLine;
  let openCol = -1;
  for (let i = startLine; i < lines.length; i++) {
    const idx = lines[i].indexOf("{", i === startLine ? match[0].length : 0);
    if (idx !== -1) {
      openLine = i;
      openCol = idx;
      break;
    }
  }
  if (openCol === -1) return null;

  // Scan from after `{` to find matching `}`.
  let depth = 1;
  let endLine = openLine;
  let endCol = openCol + 1;
  outer: for (let i = openLine; i < lines.length; i++) {
    const startC = i === openLine ? openCol + 1 : 0;
    for (let c = startC; c < lines[i].length; c++) {
      const ch = lines[i][c];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          endLine = i;
          endCol = c + 1;
          break outer;
        }
      }
    }
  }
  if (depth !== 0) return null;

  const bodyStart = positionToOffset(content, openLine, openCol + 1);
  const bodyEnd = positionToOffset(content, endLine, endCol - 1);
  const body = content.slice(bodyStart, bodyEnd);

  const fields = parseInterfaceBody(body);
  if (!fields) return null;

  // Emit nested schemas first, outermost last (parent depends on children).
  const extracted: string[] = [];
  const mainBody = emitFieldsAndExtract(fields, name, extracted, indent);
  const allModels = [
    ...extracted.map(m => `${exportKw}schema ${m}`),
    `${indent}${exportKw}schema ${name} {${mainBody}${indent}}`,
  ].join("\n\n");

  // Drop our own indent prefix from the front of the combined output —
  // the edit range starts at column 0 of `startLine`, so the first
  // `${indent}` would double-indent. We re-add it on later lines via
  // `${indent}` but let the first line stand on its own.
  const newText = allModels.replace(/^\s+/, indent);

  return {
    range: {
      start: { line: startLine, character: 0 },
      end: { line: endLine, character: endCol },
    },
    newText,
  };
}

// Field decl tree.
type ConvField = { name: string; optional: boolean; type: ConvType };
type ConvType = { kind: "ref"; ref: string } | { kind: "object"; fields: ConvField[] };

// Parse a TS object-type body into a flat list of field decls. Nested
// `{ ... }` types become `ConvType.object`; primitives and other type
// references become `ConvType.ref` (the raw type text). Returns null
// on malformed input. Brace-depth aware so nested objects are captured
// as a single field rather than getting eaten by the field separator.
function parseInterfaceBody(body: string): ConvField[] | null {
  const fields: ConvField[] = [];
  let i = 0;
  const n = body.length;
  while (i < n) {
    // Skip whitespace + comments.
    while (i < n && /\s/.test(body[i])) i++;
    if (i >= n) break;
    if (body[i] === "/" && body[i + 1] === "/") {
      while (i < n && body[i] !== "\n") i++;
      continue;
    }
    if (body[i] === "/" && body[i + 1] === "*") {
      i += 2;
      while (i < n && !(body[i] === "*" && body[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // Read field name.
    const nameMatch = body.slice(i).match(/^([A-Za-z_$][\w$]*)/);
    if (!nameMatch) return null;
    const fname = nameMatch[1];
    i += fname.length;
    // Optional.
    while (i < n && /\s/.test(body[i])) i++;
    let optional = false;
    if (body[i] === "?") {
      optional = true;
      i++;
    }
    while (i < n && /\s/.test(body[i])) i++;
    if (body[i] !== ":") return null;
    i++;
    while (i < n && /\s/.test(body[i])) i++;
    // Read type — either a nested `{ ... }` or text up to `,` / `;` / newline at depth 0.
    let typeNode: ConvType;
    if (body[i] === "{") {
      // Nested object — capture body to matching close.
      let depth = 1;
      i++;
      const innerStart = i;
      while (i < n && depth > 0) {
        if (body[i] === "{") depth++;
        else if (body[i] === "}") depth--;
        if (depth > 0) i++;
      }
      const innerBody = body.slice(innerStart, i);
      i++; // consume closing `}`
      const inner = parseInterfaceBody(innerBody);
      if (!inner) return null;
      typeNode = { kind: "object", fields: inner };
    } else {
      // Read type text up to top-level `,` or `;` or newline.
      let depth = 0;
      const tStart = i;
      while (i < n) {
        const ch = body[i];
        if (depth === 0 && (ch === "," || ch === ";" || ch === "\n")) break;
        if (ch === "{" || ch === "[" || ch === "<" || ch === "(") depth++;
        else if (ch === "}" || ch === "]" || ch === ">" || ch === ")") depth--;
        i++;
      }
      const typeText = body.slice(tStart, i).trim();
      typeNode = { kind: "ref", ref: typeText };
    }
    fields.push({ name: fname, optional, type: typeNode });
    // Consume separator + whitespace.
    while (i < n && (/\s/.test(body[i]) || body[i] === "," || body[i] === ";")) i++;
  }
  return fields;
}

// Walk fields, extract nested objects into separate model decls (queued
// in `extracted`), and emit the body of the parent model with field-type
// references swapped to the synthetic names.
function emitFieldsAndExtract(fields: ConvField[], parentName: string, extracted: string[], indent: string): string {
  const lines: string[] = [""];
  const childIndent = `${indent}  `;
  for (const f of fields) {
    let typeRef: string;
    if (f.type.kind === "object") {
      const childName = `${parentName}${capitalize(f.name)}`;
      const childBody = emitFieldsAndExtract(f.type.fields, childName, extracted, indent);
      extracted.push(`${childName} {${childBody}${indent}}`);
      typeRef = childName;
    } else {
      typeRef = convertTsTypeToParaType(f.type.ref);
    }
    lines.push(`${childIndent}${f.name}: ${typeRef}${f.optional ? "?" : ""},`);
  }
  return lines.join("\n") + "\n";
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

function convertTsTypeToParaType(t: string): string {
  const arrayMatch = t.match(/^([A-Za-z_$][\w$]*)\[\]$/);
  if (arrayMatch) return `[${arrayMatch[1]}]`;
  const arrayGenMatch = t.match(/^Array<\s*([A-Za-z_$][\w$]*)\s*>$/);
  if (arrayGenMatch) return `[${arrayGenMatch[1]}]`;
  return t;
}

function getCodeActions(uri: string, content: string, range: LspRange, params?: any): CodeAction[] {
  const actions: CodeAction[] = [];
  const lines = content.split("\n");
  const startLine = range.start.line;
  const endLine = Math.min(range.end.line, lines.length - 1);

  for (let i = startLine; i <= endLine; i++) {
    const line = lines[i];

    const catchMatch = line.match(/\.catch\(([^)]+)\)/);
    if (catchMatch && catchMatch.index !== undefined) {
      const before = line.slice(0, catchMatch.index);
      const handler = catchMatch[1];
      const after = line.slice(catchMatch.index + catchMatch[0].length);
      actions.push({
        title: "Convert .catch() to ..! operator",
        kind: "refactor.rewrite",
        edit: {
          changes: {
            [uri]: [
              {
                range: {
                  start: { line: i, character: 0 },
                  end: { line: i, character: line.length },
                },
                newText: `${before} ..! ${handler}${after}`,
              },
            ],
          },
        },
      });
    }

    const finallyMatch = line.match(/\.finally\(([^)]+)\)/);
    if (finallyMatch && finallyMatch.index !== undefined) {
      const before = line.slice(0, finallyMatch.index);
      const handler = finallyMatch[1];
      const after = line.slice(finallyMatch.index + finallyMatch[0].length);
      actions.push({
        title: "Convert .finally() to ..& operator",
        kind: "refactor.rewrite",
        edit: {
          changes: {
            [uri]: [
              {
                range: {
                  start: { line: i, character: 0 },
                  end: { line: i, character: line.length },
                },
                newText: `${before} ..& ${handler}${after}`,
              },
            ],
          },
        },
      });
    }

    const thenMatch = line.match(/\.then\(([^)]+)\)/);
    if (thenMatch && thenMatch.index !== undefined) {
      const before = line.slice(0, thenMatch.index);
      const handler = thenMatch[1];
      const after = line.slice(thenMatch.index + thenMatch[0].length);
      actions.push({
        title: "Convert .then() to ..> operator",
        kind: "refactor.rewrite",
        edit: {
          changes: {
            [uri]: [
              {
                range: {
                  start: { line: i, character: 0 },
                  end: { line: i, character: line.length },
                },
                newText: `${before} ..> ${handler}${after}`,
              },
            ],
          },
        },
      });
    }

    // Convert TS interface / type alias to Para schema
    const interfaceMatch = line.match(/^(\s*)(export\s+)?(interface|type)\s+([A-Za-z_$][\w$]*)\b/);
    if (interfaceMatch && interfaceMatch.index !== undefined) {
      const conversion = buildInterfaceToModelEdit(content, lines, i, interfaceMatch);
      if (conversion) {
        actions.push({
          title: `Convert ${interfaceMatch[3]} ${interfaceMatch[4]} to Para schema`,
          kind: "refactor.rewrite",
          edit: {
            changes: {
              [uri]: [conversion],
            },
          },
        });
      }
    }

    const fnMatch = line.match(/^(\s*)(export\s+)?(async\s+)?fun(?:ction)?\b/);
    if (fnMatch && !line.match(/\bpure\s/) && fnMatch.index !== undefined) {
      const indent = fnMatch[1] || "";
      const exportKw = fnMatch[2] || "";
      const insertCol = indent.length + exportKw.length;
      const isQuickFix = params?.context?.diagnostics?.some((d: any) => d.code === PURE_HINT_CODE);
      actions.push({
        title: "Add pure modifier",
        kind: isQuickFix ? "quickfix" : "refactor.rewrite",
        diagnostics: isQuickFix ? params.context.diagnostics.filter((d: any) => d.code === PURE_HINT_CODE) : undefined,
        edit: {
          changes: {
            [uri]: [
              {
                range: {
                  start: { line: i, character: insertCol },
                  end: { line: i, character: insertCol },
                },
                newText: "pure ",
              },
            ],
          },
        },
      });
    }
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Semantic Tokens — pure keyword highlighting
// ---------------------------------------------------------------------------

const SEMANTIC_TOKEN_TYPES = ["function", "variable", "class"];
const SEMANTIC_TOKEN_MODIFIERS = ["declaration", "pure", "signal"];

// Component-tag pass for .svelte / .pui templates. Scans the raw markup for
// `<ComponentName>` and `</ComponentName>` occurrences (uppercase-leading tag
// names, the Svelte/React convention for component invocations) and emits
// `class` semantic tokens so themes render them as classes/types rather
// than the muted `support.class.component.svelte` TextMate fallback. Uses
// the line-preserving raw text from svelteRawTexts so coordinates match
// the client's view of the document.
function collectComponentTagTokens(
  uri: string,
): Array<{ line: number; col: number; len: number; type: number; modifiers: number }> {
  const tokens: Array<{ line: number; col: number; len: number; type: number; modifiers: number }> = [];
  if (!isComponentUri(uri)) return tokens;
  const raw = svelteRawTexts.get(uri);
  if (raw === undefined) return tokens;

  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Opening: <Component  (skip the `<`, take the identifier)
    const openRe = /<([A-Z]\w*)\b/g;
    let m: RegExpExecArray | null;
    while ((m = openRe.exec(line)) !== null) {
      tokens.push({ line: i, col: m.index + 1, len: m[1]!.length, type: 2, modifiers: 0 });
    }
    // Closing: </Component>  (skip the `</`)
    const closeRe = /<\/([A-Z]\w*)\b/g;
    while ((m = closeRe.exec(line)) !== null) {
      tokens.push({ line: i, col: m.index + 2, len: m[1]!.length, type: 2, modifiers: 0 });
    }
  }
  return tokens;
}

// Collect names declared with `signal NAME = ...` (including multi-declarator
// forms like `signal a = 1, b = 2`). Used to semantic-highlight signal-bound
// identifier references so readers can spot reactive reads/writes at a
// glance. Conservative: matches the declaration line only — doesn't follow
// re-exports, and doesn't handle `let x = signal(0)` (unsugared form —
// there's no parse-time marker the LSP can see from a regex).
function collectSignalNames(content: string): Set<string> {
  const names = new Set<string>();
  // `signal NAME` followed by `=`, `,`, `;`, `:` (TS annotation), `!` (TS
  // definite-assignment), or EOL. The leading context must be non-identifier
  // to avoid matching `mySignal foo` or `signals`.
  const declRe = /(?:^|[^A-Za-z0-9_$])signal\s+([A-Za-z_$][\w$]*)(?=\s*[=,;:!]|\s*$)/gm;
  for (const m of content.matchAll(declRe)) names.add(m[1]);

  // Multi-declarator tail: `signal a = 1, b = 2, c = 3`. Walk each `signal`
  // statement line and collect subsequent `, NAME =` bindings until the
  // trailing semicolon or newline. The initial-name regex above catches `a`;
  // this loop catches `b`, `c`.
  const stmtRe = /(?:^|[^A-Za-z0-9_$])signal\s+[A-Za-z_$][\w$]*\s*(?::[^=,;]*)?=(.*)$/gm;
  for (const m of content.matchAll(stmtRe)) {
    const tail = m[1];
    const tailRe = /,\s*([A-Za-z_$][\w$]*)(?=\s*[=,;:!]|\s*$)/g;
    for (const tm of tail.matchAll(tailRe)) names.add(tm[1]);
  }
  return names;
}

// Plain variables/params/functions/classes carry no parabun-specific marker, so
// the regex passes (pure/signal/component) leave them un-tokenized — they render
// white (TextMate can't classify a bare identifier reference). Source full tokens
// from the TS service over the svelte2tsx projection (it sees every binding) and
// map each span back to the raw .pui via the sourcemap — the same projection +
// toOriginal() pattern computeTsDiagnostics uses. Only `.pui` (svelte2tsx-backed);
// other parabun langs already get TS semantic highlighting from the TS server.
function collectTsSemanticTokens(
  uri: string,
): Array<{ line: number; col: number; len: number; type: number; modifiers: number }> {
  const out: Array<{ line: number; col: number; len: number; type: number; modifiers: number }> = [];
  if (!(tsService && ts) || !isPuiUri(uri)) return out;
  const raw = svelteRawTexts.get(uri);
  const t = raw !== undefined ? getPuiTransform(uri, raw) : undefined;
  if (!t) return out;
  try {
    const fileName = toTsPath(uriToPath(uri));
    const cls = tsService.getEncodedSemanticClassifications(
      fileName,
      { start: 0, length: t.code.length },
      ts.SemanticClassificationFormat.TwentyTwenty,
    );
    const spans = cls.spans; // flat triplets: [start, length, encodedClassification, ...]
    for (let k = 0; k + 2 < spans.length; k += 3) {
      const start = spans[k]!;
      const length = spans[k + 1]!;
      // TwentyTwenty encoding: tokenType = (encoded >> 8) - 1 (TS's classification
      // enum: 0 class, 6 parameter, 7 variable, 10 function, 11 member, …).
      const tsType = (spans[k + 2]! >> 8) - 1;
      let type: number;
      if (tsType === 7 || tsType === 6) type = 1; // variable / parameter → variable
      else if (tsType === 10 || tsType === 11) type = 0; // function / member → function
      else if (tsType === 0) type = 2; // class
      else continue; // type/interface/namespace/etc. — leave to TextMate
      const gs = offsetToPosition(t.code, start);
      const os = t.toOriginal(gs.line, gs.character);
      if (!os) continue; // projection-only scaffolding (no original mapping)
      out.push({ line: os.line, col: os.character, len: length, type, modifiers: 0 });
    }
  } catch (e: any) {
    logMessage(2, `[parabun-lsp] .pui semantic tokens error: ${e?.message ?? e}`);
  }
  return out;
}

function computeSemanticTokens(uri: string, content: string): number[] {
  // Collect every token as {line, col, len, type, modifiers}, then sort and
  // emit. Multiple passes (pure / signal) touch different regions but may
  // overlap per line in any order — LSP requires strictly-ascending output.
  type Token = { line: number; col: number; len: number; type: number; modifiers: number };
  const tokens: Token[] = [];
  const lines = content.split("\n");

  const pureFns = getAllPureFns(uri, content);
  const signalNames = collectSignalNames(content);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // pure keyword
    const pureRe = /\b(pure)\s*(?=function\b|fun\b|async\b|\(|<[\w\s,=]+>\s*\(|\w+\s*=>)/g;
    let m: RegExpExecArray | null;
    while ((m = pureRe.exec(line)) !== null) {
      tokens.push({ line: i, col: m.index, len: 4, type: 0, modifiers: 0b010 }); // function + pure
    }

    // Pure function call sites
    if (pureFns.size > 0) {
      const callRe = /\b(\w+)\s*(?:\(|<[\w\s,=<>[\]|&]+>\s*\()/g;
      while ((m = callRe.exec(line)) !== null) {
        if (pureFns.has(m[1]) && !JS_KEYWORDS.test(m[1])) {
          tokens.push({ line: i, col: m.index, len: m[1].length, type: 0, modifiers: 0b010 });
        }
      }
    }

    // Signal-bound identifier references. Every occurrence of a name declared
    // via `signal NAME = ...` — declaration site included — gets the "signal"
    // modifier. Covers reads, writes, method calls (`count.get()` still gets
    // highlighted on the `count` part). Strings/comments aren't stripped;
    // accept the occasional false-positive inside a string literal to keep
    // the impl regex-only, matching the `pure` pass's style.
    if (signalNames.size > 0) {
      const idRe = /[A-Za-z_$][\w$]*/g;
      while ((m = idRe.exec(line)) !== null) {
        const name = m[0];
        if (!signalNames.has(name)) continue;
        // Skip property-access position: `foo.count` — `count` there is a
        // property, not a reference to the outer signal binding.
        if (m.index > 0 && line[m.index - 1] === ".") continue;
        tokens.push({ line: i, col: m.index, len: name.length, type: 1, modifiers: 0b100 });
      }
    }
  }

  // Component-tag tokens for .svelte / .pui templates.
  tokens.push(...collectComponentTagTokens(uri));

  // Full TS-derived tokens (plain variables/params/functions/classes) for `.pui`,
  // so ordinary identifiers aren't left white.
  tokens.push(...collectTsSemanticTokens(uri));

  tokens.sort((a, b) => a.line - b.line || a.col - b.col);

  // Dedup exact-overlap tokens (same line+col+len) — keep the first, OR-
  // combine modifiers. Rare in practice but guards against double-emission.
  const data: number[] = [];
  let prevLine = 0;
  let prevChar = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (i > 0) {
      const prev = tokens[i - 1];
      if (prev.line === t.line && prev.col === t.col && prev.len === t.len && prev.type === t.type) {
        // Exact overlap (e.g. the signal pass and the TS pass both emit a
        // `variable` token for a signal binding) — OR-combine modifiers onto the
        // already-emitted token instead of dropping the signal/declaration bit.
        if (data.length > 0) data[data.length - 1] |= t.modifiers;
        continue;
      }
    }
    const deltaLine = t.line - prevLine;
    const deltaChar = deltaLine === 0 ? t.col - prevChar : t.col;
    data.push(deltaLine, deltaChar, t.len, t.type, t.modifiers);
    prevLine = t.line;
    prevChar = t.col;
  }

  return data;
}

// ---------------------------------------------------------------------------
// Request dispatch
// ---------------------------------------------------------------------------

function handleMessage(msg: any) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      workspaceRoot = params.rootUri ? uriToPath(params.rootUri) : (params.rootPath ?? "");
      initTypeScriptService();

      sendResponse(id, {
        capabilities: {
          textDocumentSync: { openClose: true, change: 1 },
          completionProvider: {
            triggerCharacters: [".", "|", '"', "'", "/"],
          },
          hoverProvider: true,
          definitionProvider: true,
          codeActionProvider: {
            codeActionKinds: ["refactor.rewrite", "quickfix"],
          },
          semanticTokensProvider: {
            legend: {
              tokenTypes: SEMANTIC_TOKEN_TYPES,
              tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
            },
            full: true,
          },
        },
        serverInfo: { name: "parabun-lsp", version: "0.2.0" },
      });
      break;

    case "initialized":
      break;

    case "shutdown":
      sendResponse(id, null);
      break;

    case "exit":
      process.exit(0);
      break;

    case "textDocument/didOpen": {
      const { uri, text, version, languageId } = params.textDocument;
      logMessage(3, `[parabun-lsp] didOpen: uri=${uri} lang=${languageId} len=${text?.length ?? 0}`);
      const stored = ingestDocumentText(uri, text);
      docVersions.set(uri, version ?? 1);
      if (stored === undefined) {
        // .svelte file with no parabun script blocks — nothing to analyze.
        publishDiagnostics(uri, []);
        break;
      }
      // Fast pass debounced as usual; ALSO dispatch a slow tsc request
      // immediately (no 1.5 s debounce) so the helper subprocess can
      // begin its cold load in parallel with the user reading the
      // file. Without this, the first slow pass waits for didChange
      // and the user-perceived "open file → see TS error" latency is
      // 1.5 s longer than necessary.
      scheduleValidate(uri);
      const initialVersion = docVersions.get(uri);
      if (initialVersion !== undefined) {
        requestTscDiagnostics(uri, stored, initialVersion);
      }
      break;
    }

    case "textDocument/didChange": {
      const uri = params.textDocument.uri;
      const content = params.contentChanges[0]?.text;
      if (content !== undefined) {
        const stored = ingestDocumentText(uri, content);
        docVersions.set(uri, (docVersions.get(uri) ?? 0) + 1);
        if (stored === undefined) {
          publishDiagnostics(uri, []);
          break;
        }
        scheduleValidate(uri);
      }
      break;
    }

    case "textDocument/didClose": {
      const uri = params.textDocument.uri;
      const f = fastTimers.get(uri);
      if (f !== undefined) {
        clearTimeout(f);
        fastTimers.delete(uri);
      }
      const s = slowTimers.get(uri);
      if (s !== undefined) {
        clearTimeout(s);
        slowTimers.delete(uri);
      }
      documents.delete(uri);
      docVersions.delete(uri);
      svelteLangs.delete(uri);
      svelteRawTexts.delete(uri);
      lastFastDiagnostics.delete(uri);
      if (tscHelper && helperOpenDocs.has(uri)) {
        sendToHelper({ type: "close", uri });
        helperOpenDocs.delete(uri);
      }
      publishDiagnostics(uri, []);
      break;
    }

    case "textDocument/completion": {
      const uri = params.textDocument.uri;
      const content = getDocContent(uri);
      if (content) {
        sendResponse(id, getCompletions(uri, content, params.position.line, params.position.character));
      } else {
        sendResponse(id, {
          isIncomplete: false,
          items: parabunCompletions,
        });
      }
      break;
    }

    case "textDocument/hover": {
      const uri = params.textDocument.uri;
      const content = getDocContent(uri);
      if (content) {
        const result = getHoverResult(uri, content, params.position.line, params.position.character);
        sendResponse(id, result);
      } else {
        logMessage(2, `[parabun-lsp] hover: could not read ${uri}`);
        sendResponse(id, null);
      }
      break;
    }

    case "textDocument/definition": {
      const uri = params.textDocument.uri;
      const content = getDocContent(uri);
      if (content) {
        sendResponse(id, getDefinition(uri, content, params.position.line, params.position.character));
      } else {
        sendResponse(id, null);
      }
      break;
    }

    case "textDocument/codeAction": {
      const uri = params.textDocument.uri;
      const content = getDocContent(uri);
      if (content) {
        sendResponse(id, getCodeActions(uri, content, params.range, params));
      } else {
        sendResponse(id, []);
      }
      break;
    }

    case "textDocument/semanticTokens/full":
    case "textDocument/semanticTokens/full/delta":
    case "textDocument/semanticTokens/range": {
      const uri = params.textDocument.uri;
      const content = getDocContent(uri);
      const data = content ? computeSemanticTokens(uri, content) : [];
      logMessage(3, `[parabun-lsp] ${method}: uri=${uri} tokens=${data.length / 5}`);
      sendResponse(id, { data });
      break;
    }

    case "parabun/pureFunctions": {
      const uri = params.textDocument.uri;
      const content = getDocContent(uri);
      if (content) {
        sendResponse(id, { names: [...getAllPureFns(uri, content)] });
      } else {
        sendResponse(id, { names: [] });
      }
      break;
    }

    default:
      if (id !== undefined) {
        sendResponse(id, null);
      }
      break;
  }
}

// ---------------------------------------------------------------------------
// stdin reader — Content-Length framed messages (main LSP only)
// ---------------------------------------------------------------------------

// PARABUN_LSP_NO_LISTEN lets the module be imported (unit tests) without
// taking over stdin / pinning the event loop. Production never sets it.
if (!HELPER_MODE && !process.env.PARABUN_LSP_NO_LISTEN) {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    inputBuffer += chunk;

    while (true) {
      const sepIdx = inputBuffer.indexOf(HEADER_SEP);
      if (sepIdx === -1) break;

      const header = inputBuffer.slice(0, sepIdx);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        inputBuffer = inputBuffer.slice(sepIdx + HEADER_SEP.length);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const bodyStart = sepIdx + HEADER_SEP.length;

      if (inputBuffer.length < bodyStart + contentLength) {
        break;
      }

      const body = inputBuffer.slice(bodyStart, bodyStart + contentLength);
      inputBuffer = inputBuffer.slice(bodyStart + contentLength);

      try {
        handleMessage(JSON.parse(body));
      } catch {
        // Ignore malformed JSON
      }
    }
  });

  process.stdin.resume();
} else if (HELPER_MODE) {
  runTscHelperMode();
}
// else: PARABUN_LSP_NO_LISTEN with !HELPER_MODE → import for tests; bootstrap nothing.

// ---------------------------------------------------------------------------
// tsc helper subprocess mode. Reads newline-delimited JSON messages from
// stdin (one message per line — no Content-Length framing because the
// payloads are bounded and we control both sides). Maintains its own
// `documents` / `docVersions` state synced from the main process, runs
// the same tsService setup as `initTypeScriptService`, and replies with
// `{ type: "diagnostics", uri, version, diagnostics }`. Crash-safe: any
// thrown error inside `validate` is caught and turned into an empty
// diagnostics reply so the main process never hangs.
//
// Wire protocol (newline-delimited JSON):
//   ← { type: "open" | "update", uri, content, version }
//   ← { type: "close", uri }
//   ← { type: "validate", uri, version }
//   → { type: "ready" }                          (once after init)
//   → { type: "diagnostics", uri, version, diagnostics: LspDiagnostic[] }
//   → { type: "log", level, message }            (forwarded to client)
// ---------------------------------------------------------------------------

function runTscHelperMode(): void {
  // Reuse the main LSP's tsService setup. workspaceRoot defaults from
  // cwd; main process sends the actual root via the first message.
  workspaceRoot = process.cwd();
  initTypeScriptService();
  process.stdout.write(JSON.stringify({ type: "ready" }) + "\n");

  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      handleHelperMessage(msg);
    }
  });
  process.stdin.resume();
}

function handleHelperMessage(msg: any): void {
  switch (msg.type) {
    case "open":
    case "update":
      documents.set(msg.uri, msg.content);
      docVersions.set(msg.uri, msg.version);
      if (msg.lang) svelteLangs.set(msg.uri, msg.lang);
      else if (isComponentUri(msg.uri)) svelteLangs.delete(msg.uri);
      // Raw component source — required for the `.pui` svelte2tsx
      // projection in computeTsDiagnostics / getScriptSnapshot. The
      // main process holds it in svelteRawTexts; the helper only learns
      // it via this message (LYK-912).
      if (msg.raw !== undefined) svelteRawTexts.set(msg.uri, msg.raw);
      return;
    case "close":
      documents.delete(msg.uri);
      docVersions.delete(msg.uri);
      svelteLangs.delete(msg.uri);
      svelteRawTexts.delete(msg.uri);
      return;
    case "validate": {
      const content = documents.get(msg.uri);
      if (content === undefined) {
        process.stdout.write(
          JSON.stringify({ type: "diagnostics", uri: msg.uri, version: msg.version, diagnostics: [] }) + "\n",
        );
        return;
      }
      let diagnostics: LspDiagnostic[] = [];
      try {
        diagnostics = computeTsDiagnostics(msg.uri, content);
      } catch (e: any) {
        process.stdout.write(
          JSON.stringify({
            type: "log",
            level: 2,
            message: `[parabun-lsp tsc-helper] validate threw: ${e?.message ?? e}`,
          }) + "\n",
        );
      }
      process.stdout.write(
        JSON.stringify({ type: "diagnostics", uri: msg.uri, version: msg.version, diagnostics }) + "\n",
      );
      return;
    }
  }
}
