/**
 * pui-transform — `.pui` → typed-TSX + bidirectional sourcemap mapper for
 * parabun-lsp in-`.pui` type intelligence (LYK-880 Slice B).
 *
 * Two real v3 maps, chained for column-accurate mapping:
 *   raw .pui  --lowering map (magic-string)-->  lowered Svelte
 *   lowered   --svelte2tsx map-->               generated TSX
 *
 * The lowering is re-implemented here over a whole-file MagicString with
 * segment-preserving overwrites: keywords/punctuation are rewritten while
 * user identifiers and expressions stay in place, so they keep exact
 * column mapping. `effect { body }` rewrites only the opener/closer — the
 * (often large) body is untouched and fully mapped. Where source↔output
 * token order is inherently reordered (the `signal x` bridge, merged
 * `prop` destructure) the line is overwritten whole and is line-accurate
 * (the LSP additionally strips the `__sig_` prefix in hovers).
 *
 * Parity contract (enforced by test/pui-lower-parity.smoke.ts): for the
 * REACTIVITY lowering — `signal` / `derived` (expr + block) / `effect`
 * (block + single-statement) / `prop` — `.code` is byte-identical to
 * @lyku/para-preprocess's proven `lowerPuiReactivity(src,'@lyku/para-ui',
 * true)`, so the magic-string port is faithful and the generated map
 * trustworthy. Two deltas are INTENTIONAL and out of the byte-identity
 * scope (the gate excludes them, by design — not drift):
 *   1. Operator desugars (pure / |> / ..! / fun / is / ranges / decimal /
 *      match-stub). The LSP applies these so the projection is valid TS;
 *      canonical does not (the Zig parser does, at build). Different
 *      layers — never expected identical.
 *   2. Auto-injected imports (provide/inject/using/source/lifecycle/nav)
 *      are placed INSIDE the `<script>` here (line-preserving, so
 *      diagnostic positions map); canonical emits them before the tag.
 *      Required for LSP sourcemap accuracy; deliberately divergent.
 *
 * Bundled self-contained via esbuild-pui-transform.mjs.
 */

import {
  transformDecimal,
  transformErrorChain,
  transformFun,
  transformIs,
  transformPipeline,
  transformPure,
  transformRanges,
} from "@lyku/para-transpile/syntactic"; // Babel-free entry — NOT the package
// index (which drags bare-read/using-polyfill → @babel and breaks the
// CI bundle build; was the cause of parabun build #235's failure).
import { svelte2tsx } from "svelte2tsx";
import MagicStringNS from "magic-string";
import { TraceMap, originalPositionFor, generatedPositionFor } from "@jridgewell/trace-mapping";
// LYK-886: the escape predicate is shared (not byte-mirrored) so the
// editor's inline/bridge decision is structurally identical to the build
// path's. Resolves to para-preprocess src via the `bun` export condition
// (esbuild-pui-transform bundles it; direct bun runs honor it too).
import {
  buildEscapeChecker,
  derivedInitEnd,
  hasTopLevelAwait,
  matchTypeStubSpans,
  parseDeclarator,
  PUI_KIT_NAV,
  PUI_RUNTIME_LIFECYCLE,
  splitDeclarators,
  usesIdentCall,
} from "@lyku/para-preprocess";

const MagicString: typeof import("magic-string").default = (MagicStringNS as any).default ?? (MagicStringNS as any);

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

// Brace-aware: offset just AFTER the `}` matching the `{` at openOffset.
// Skips comments/strings. -1 if unbalanced. (Mirrors para-preprocess.)
function findMatchingBrace(s: string, openOffset: number): number {
  let depth = 1;
  let i = openOffset + 1;
  while (i < s.length && depth > 0) {
    const ch = s[i]!;
    if (ch === "/" && s[i + 1] === "/") {
      const eol = s.indexOf("\n", i);
      i = eol === -1 ? s.length : eol;
      continue;
    }
    if (ch === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      i = end === -1 ? s.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      i++;
      while (i < s.length && s[i] !== q) {
        if (s[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  return depth === 0 ? i : -1;
}

interface LoweredFile {
  code: string;
  /** v3 map: lowered file ↔ raw .pui (sources: [filename]). */
  map: any;
}

/**
 * Lower every `<script>` body's Para keywords in the raw .pui over a
 * whole-file MagicString. Segment-preserving where token order allows;
 * whole-line where it's inherently reordered. linePreserving (imports
 * injected inline) so line counts match raw.
 */
function lowerPuiFileWithMap(raw: string, filename: string): LoweredFile {
  const ms = new MagicString(raw);
  // overwrite, but appendLeft for zero-length ranges (expr ending exactly
  // at line-end with no trailing `;` is common).
  const repl = (start: number, end: number, str: string) => {
    if (start === end) ms.appendLeft(start, str);
    else ms.overwrite(start, end, str);
  };
  const signalNames = new Set<string>();
  const svelteImports = new Set<string>();
  const kitNavImports = new Set<string>();
  let needsSignalImport = false;
  let needsPromiseSignal = false;
  let firstBodyStart = -1;
  const bodyRanges: Array<[number, number]> = [];

  SCRIPT_RE.lastIndex = 0;
  let sm: RegExpExecArray | null;
  while ((sm = SCRIPT_RE.exec(raw)) !== null) {
    const bodyStart = sm.index + sm[0].indexOf(">", 1) + 1;
    const bodyEnd = sm.index + sm[0].length - "</script>".length;
    const body = raw.slice(bodyStart, bodyEnd);
    // Mirror the build path's lifecycle/nav auto-import (para-preprocess)
    // so a .pui using plain `onMount`/`afterNavigate` doesn't show a
    // false `Cannot find name` in the editor while building fine. Same
    // source-of-truth sets + detector (no build-vs-editor drift).
    for (const name of PUI_RUNTIME_LIFECYCLE) if (usesIdentCall(body, name)) svelteImports.add(name);
    for (const name of PUI_KIT_NAV) if (usesIdentCall(body, name)) kitNavImports.add(name);
    // LYK-886: same escape predicate as the build path — imported, not
    // copied, so editor↔build parity is structural. Built per <script>
    // body; `body` is raw here (provide/inject still keywords) which the
    // shared checker handles identically to the desugared build input.
    const escapesName = buildEscapeChecker(body);
    if (firstBodyStart === -1) firstBodyStart = bodyStart;
    bodyRanges.push([bodyStart, bodyEnd]);

    // ── effect { body } → $effect(() => { body }) ───────────────────────
    // Overwrite opener + matching close only; body stays mapped.
    {
      const re = /(^|[^\w$.])effect\s*\{/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        const kwStart = bodyStart + m.index + (m[1] ? m[1].length : 0);
        const braceStart = bodyStart + re.lastIndex - 1;
        const braceEnd = findMatchingBrace(raw, braceStart);
        if (braceEnd === -1) continue;
        repl(kwStart, braceStart + 1, "$effect(() => {");
        repl(braceEnd - 1, braceEnd, "})");
        re.lastIndex = braceEnd - bodyStart;
      }
    }

    // `mount` was retired as a keyword (2026-05-17) — lifecycle is plain
    // Svelte/SvelteKit calls now (auto-imported by para-preprocess on the
    // build path). `mount {` projects as a plain identifier + block; no
    // rewrite here keeps the LSP projection consistent with the build.

    // ── derived NAME { body } → const NAME = $derived.by(() => { body })
    // (LYK-892). Multi-statement derivation block; opener/closer-only
    // rewrite keeps the body mapped. Byte-identical to the build path.
    {
      const re = /(^|[^\w$.])derived\s+(\w+)\s*\{/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        const kwStart = bodyStart + m.index + (m[1] ? m[1].length : 0);
        const name = m[2]!;
        const braceStart = bodyStart + re.lastIndex - 1;
        const braceEnd = findMatchingBrace(raw, braceStart);
        if (braceEnd === -1) continue;
        repl(kwStart, braceStart + 1, `const ${name} = $derived.by(() => {`);
        repl(braceEnd - 1, braceEnd, "})");
        re.lastIndex = braceEnd - bodyStart;
      }
    }

    // Per-line passes. Recompute line offsets against raw (effect overwrite
    // doesn't move line starts: opener/closer lines keep their newline).
    const lineStarts: number[] = [bodyStart];
    for (let k = bodyStart; k < bodyEnd; k++) if (raw[k] === "\n") lineStarts.push(k + 1);

    // A multi-line `derived NAME = …` consumes following lines; skip
    // line-starts that fall inside an already-rewritten expression.
    let consumedUntil = -1;
    for (const ls of lineStarts) {
      if (ls < consumedUntil) continue;
      let le = raw.indexOf("\n", ls);
      if (le === -1 || le > bodyEnd) le = bodyEnd;
      const lineText = raw.slice(ls, le);

      // derived NAME = EXPR → const NAME = $derived(EXPR). EXPR may span
      // newlines (ternary / binary / member-chain wrap) — its true
      // extent comes from the shared derivedInitEnd scanner (same one
      // the build path uses), NOT this line's end. The expression text
      // is left in place (positions preserved → diagnostics map);
      // only the opener/closer are rewritten.
      let d = lineText.match(/^(\s*)derived\s+(\w+)((?:\s*:\s*[^=]+)?)\s*=\s*(.+?)\s*;?\s*$/);
      if (d) {
        const indent = d[1]!;
        const nameRel = lineText.indexOf(d[2]!, indent.length);
        const nameAbs = ls + nameRel;
        const exprRel = lineText.lastIndexOf(d[4]!);
        const exprAbs = ls + exprRel;
        const end = Math.min(derivedInitEnd(raw, exprAbs), bodyEnd);
        const term = raw[end] === ";" ? end + 1 : end;
        repl(ls, nameAbs, `${indent}const `);
        repl(nameAbs + d[2]!.length, exprAbs, ` = $derived(`);
        repl(end, term, `);`);
        consumedUntil = term;
        continue;
      }

      // Single-statement `effect EXPR;` → `$effect(() => EXPR)`. Same
      // disambiguation as the parser/grammar (`effect` + ws + identifier
      // — NOT `effect {` / `effect(` / `effect.` / `effect=`). EXPR may
      // span newlines; extent from the shared derivedInitEnd scanner.
      // Expression-bodied (implicit return preserved). Block `effect {`
      // is already lowered by the pre-loop pass. Without this the raw
      // `effect appSync.sync();` reaches tsc as invalid TS and kills
      // diagnostics for the WHOLE file.
      let ef = lineText.match(/^(\s*)effect(\s+)(?=[A-Za-z_$])/);
      if (ef) {
        const kwAbs = ls + ef[1]!.length;
        const exprAbs = ls + ef[0]!.length;
        const end = Math.min(derivedInitEnd(raw, exprAbs), bodyEnd);
        const term = raw[end] === ";" ? end + 1 : end;
        repl(kwAbs, exprAbs, `$effect(() => `);
        // `)` not `);` — byte-parity with canonical lowerPuiReactivity
        // (para-preprocess emits `$effect(() => EXPR)`, no trailing
        // semicolon; the original `;` is consumed via `term`). Enforced
        // by test/pui-lower-parity.smoke.ts.
        repl(end, term, `)`);
        consumedUntil = term;
        continue;
      }

      // provide NAME = EXPR → setContext("NAME", EXPR)
      let pv = lineText.match(/^(\s*)provide\s+(\w+)(?:\s*:\s*[^=]+)?\s*=\s*(.+?)\s*;?\s*$/);
      if (pv) {
        svelteImports.add("setContext");
        const indent = pv[1]!;
        const exprRel = lineText.lastIndexOf(pv[3]!);
        repl(ls, ls + exprRel, `${indent}setContext(${JSON.stringify(pv[2]!)}, `);
        repl(ls + exprRel + pv[3]!.length, le, `);`);
        continue;
      }

      // inject NAME: TYPE → const NAME: TYPE = getContext("NAME")
      let ij = lineText.match(/^(\s*)inject\s+(\w+)\s*:\s*(.+?)\s*;?\s*$/);
      if (ij) {
        svelteImports.add("getContext");
        const indent = ij[1]!;
        repl(ls, le, `${indent}const ${ij[2]!}: ${ij[3]!.trim()} = getContext(${JSON.stringify(ij[2]!)});`);
        continue;
      }

      // using NAME = EXPR → const NAME = EXPR; onDestroy(() => NAME.dispose?.())
      let us = lineText.match(/^(\s*)using\s+(\w+)(?:\s*:\s*[^=]+)?\s*=\s*(.+?)\s*;?\s*$/);
      if (us) {
        svelteImports.add("onDestroy");
        const indent = us[1]!;
        const name = us[2]!;
        const exprRel = lineText.lastIndexOf(us[3]!);
        repl(ls, ls + exprRel, `${indent}const ${name} = `);
        repl(ls + exprRel + us[3]!.length, le, `; onDestroy(() => ${name}.dispose?.());`);
        continue;
      }

      // async signal NAME = EXPR → promiseSignal-backed {data,error,
      // pending} reactive view + auto-dispose (LYK-891). Two-repl keeps
      // EXPR mapped; byte-identical to the build path. Must precede the
      // `signal` block. Needs onDestroy + promiseSignal.
      let as = lineText.match(/^(\s*)async\s+signal\s+(\w+)(?:\s*:\s*[^=]+)?\s*=\s*(.+?)\s*;?\s*$/);
      if (as) {
        svelteImports.add("onDestroy");
        needsPromiseSignal = true;
        const indent = as[1]!;
        const name = as[2]!;
        const exprRel = lineText.lastIndexOf(as[3]!);
        repl(ls, ls + exprRel, `${indent}const __as_${name} = promiseSignal(() => (`);
        repl(
          ls + exprRel + as[3]!.length,
          le,
          `)); let ${name} = $state(__as_${name}.peek?.() ?? __as_${name}); ` +
            `$effect.pre(() => __as_${name}.subscribe?.((__v: typeof ${name}) => { ${name} = __v; })); ` +
            `onDestroy(() => __as_${name}.dispose?.());`,
        );
        continue;
      }

      // source NAME = EXPR → native-handle reactive view + auto-dispose
      // (LYK-895). Two-repl keeps EXPR mapped; byte-identical to the build
      // path's whole-line form. Needs onDestroy.
      let sc = lineText.match(/^(\s*)source\s+(\w+)(?:\s*:\s*[^=]+)?\s*=\s*(.+?)\s*;?\s*$/);
      if (sc) {
        svelteImports.add("onDestroy");
        const indent = sc[1]!;
        const name = sc[2]!;
        const exprRel = lineText.lastIndexOf(sc[3]!);
        repl(ls, ls + exprRel, `${indent}const __src_${name} = `);
        repl(
          ls + exprRel + sc[3]!.length,
          le,
          `; let ${name} = $state(__src_${name}.peek?.() ?? __src_${name}); ` +
            `$effect.pre(() => __src_${name}.subscribe?.((__v: typeof ${name}) => { ${name} = __v; })); ` +
            `onDestroy(() => __src_${name}.dispose?.());`,
        );
        continue;
      }

      // signal a = 1, b = 2 → per-declarator bridge, fragments re-joined
      // on the one line (source↔output reordered → whole-line).
      let sg = lineText.match(/^(\s*)signal\s+(.+?)\s*;?\s*$/);
      if (sg) {
        const indent = sg[1]!;
        const decls = splitDeclarators(sg[2]!).map(parseDeclarator);
        if (decls.length === 0 || decls.some(d => d === null || d.default === undefined || d.default === "")) {
          continue; // not a valid signal statement — leave untouched
        }
        const frags = decls.map(d => {
          const name = d!.name;
          const expr = d!.default!;
          // LYK-886: provably component-local → plain `$state`, no bridge.
          // NOT added to signalNames (so the __sig_ assignment-rewrite +
          // signal import are skipped for this name), matching the build
          // path with linePreserving=true.
          if (!escapesName(name)) return `let ${name} = $state(${expr});`;
          signalNames.add(name);
          needsSignalImport = true;
          return (
            `const __sig_${name} = signal(${expr}); ` +
            `let ${name} = $state(__sig_${name}.peek()); ` +
            `$effect.pre(() => __sig_${name}.subscribe((__v: typeof ${name}) => { ${name} = __v; }));`
          );
        });
        repl(ls, le, `${indent}${frags.join(" ")}`);
        continue;
      }
    }

    // prop NAME: TYPE [= DEF] → merged single `let { … } = $props()` at the
    // first prop line; later prop lines blanked. Reordered/merged → not
    // token-faithful; line-accurate.
    {
      type P = { ls: number; le: number; indent: string; name: string; type: string; def?: string };
      const propDecls: P[] = [];
      const propLineSpans: Array<{ ls: number; le: number }> = [];
      for (const ls of lineStarts) {
        let le = raw.indexOf("\n", ls);
        if (le === -1 || le > bodyEnd) le = bodyEnd;
        const m = raw.slice(ls, le).match(/^(\s*)prop\s+(.+?)\s*;?\s*$/);
        if (!m) continue;
        const before = propDecls.length;
        for (const decl of splitDeclarators(m[2]!)) {
          const d = parseDeclarator(decl);
          if (!d) continue;
          propDecls.push({ ls, le, indent: m[1] ?? "", name: d.name, type: (d.type ?? "any").trim(), def: d.default });
        }
        if (propDecls.length > before) propLineSpans.push({ ls, le });
      }
      if (propDecls.length) {
        const dParts = propDecls.map(p => (p.def !== undefined ? `${p.name} = ${p.def}` : p.name));
        const tParts = propDecls.map(p => (p.def !== undefined ? `${p.name}?: ${p.type}` : `${p.name}: ${p.type}`));
        const merged = `${propDecls[0]!.indent}let { ${dParts.join(", ")} }: { ${tParts.join("; ")} } = $props();`;
        repl(propLineSpans[0]!.ls, propLineSpans[0]!.le, merged);
        for (let k = 1; k < propLineSpans.length; k++) repl(propLineSpans[k]!.ls, propLineSpans[k]!.le, "");
      }
    }

    // ── general parabun syntax → TS, single-sourced via @lyku/para-transpile ──
    // LYK-913/914/915: the build path lowers general parabun syntax via
    // Bun.Transpiler (type-stripping — fine for runtime). svelte2tsx
    // needs *typed* TS, so the projection runs @lyku/para-transpile's
    // type-preserving, position-preserving passes instead:
    //   • transformDecimal   — `1.5d` → `__paraDec("1.5")`
    //   • transformFun       — `fun` → `function`
    //   • transformPure      — `pure ` strip
    //   • transformIs        — `x is T` → `T.parse(x).tag === "Ok"`
    //   • transformPipeline  — `x |> f` → `f(x)` (block-scope-aware)
    //   • transformErrorChain— `p ..! h`/`..&`/`..>` → .catch/.finally/.then
    //   • transformRanges    — `a..b` → `__parabunRange(a, b)`
    // Order mirrors @lyku/para-transpile's own `transpile()` (decimal, fun,
    // pure, is, …, pipeline before error-chain so `|>` binds tighter,
    // ranges last). All are region-based / line-preserving, so the
    // per-line MagicString diff keeps low.map line-accurate. The injected
    // helper names (`__paraDec`, `__parabunRange*`) are projection
    // scaffolding — filtered by PUI_SCAFFOLD_DIAG (parabun-lsp.ts), like
    // svelte2tsx's. `match` is the one still deferred (multi-line — needs
    // sourcemap threading, tracked separately). A line the reactivity
    // lowering already overwrote throws on overlap → skipped.
    // ── match → parse-safe, subject-typed `any` stub (LYK-916) ──────────
    // `match` is a multi-line, structure-changing desugar; full per-arm
    // result narrowing would need a Zig-faithful sourcemap-threaded
    // lowering (beyond what ANY current parabun tooling does — the LSP's
    // non-`.pui` path stubs it too). We bring `.pui` to that same proven
    // parity: replace the whole `match { … }` with
    // `((__pm: any): any => null as any)(SUBJECT)` so it parses and the
    // SUBJECT still type-checks (its errors surface); arm results are
    // `any`. Single-sourced via matchTypeStubSpans (shared with the
    // legacy path; a parity test guards drift). The stub is emitted on
    // the match's first line + the original `\n` count, so line totals
    // are preserved and the per-line pass below still aligns. Overlap
    // with a reactivity rewrite → skipped.
    for (const sp of matchTypeStubSpans(raw)) {
      if (sp.start < bodyStart || sp.end > bodyEnd) continue;
      const subj = transformRanges(
        transformErrorChain(transformPipeline(transformIs(transformPure(transformFun(transformDecimal(sp.subject)))))),
      );
      let nl = 0;
      for (let k = sp.start; k < sp.end; k++) if (raw[k] === "\n") nl++;
      try {
        repl(sp.start, sp.end, `((__pm: any): any => null as any)(${subj})` + "\n".repeat(nl));
      } catch {
        /* overlaps a reactivity rewrite — skip */
      }
    }

    {
      const lowered = transformRanges(
        transformErrorChain(transformPipeline(transformIs(transformPure(transformFun(transformDecimal(body)))))),
      );
      if (lowered !== body) {
        const origLines = body.split("\n");
        const newLines = lowered.split("\n");
        if (origLines.length === newLines.length) {
          let off = bodyStart;
          for (let i = 0; i < origLines.length; i++) {
            const ol = origLines[i]!;
            const nl = newLines[i]!;
            if (ol !== nl) {
              // Minimal edit: a whole-line overwrite would map EVERY
              // token on the line back to the line start (MagicString
              // treats an overwrite as one opaque chunk) — that broke
              // hover/go-to/diagnostic precision on every line touched by
              // a now-common transform (`|>`/`is`/decimal/…). Keep the
              // common prefix & suffix untouched so they retain exact
              // identity mapping; only the genuinely-rewritten middle
              // span is coarse (that text legitimately moved).
              let p = 0;
              const maxP = Math.min(ol.length, nl.length);
              while (p < maxP && ol[p] === nl[p]) p++;
              let s = 0;
              const maxS = Math.min(ol.length - p, nl.length - p);
              while (s < maxS && ol[ol.length - 1 - s] === nl[nl.length - 1 - s]) s++;
              const a = off + p;
              const b = off + ol.length - s;
              const mid = nl.slice(p, nl.length - s);
              try {
                repl(a, b, mid); // repl() does appendLeft when a === b
              } catch {
                /* overlaps a reactivity rewrite on this line — skip */
              }
            }
            off += ol.length + 1; // + "\n"
          }
        }
      }
    }
  }

  // Assignment rewrite: `NAME = EXPR` → `__sig_NAME.set(EXPR)` for known
  // signals, skipping the bridge decl line. Scan raw lines (line-anchored;
  // unaffected by prior overwrites since those changed only matched lines).
  if (signalNames.size) {
    let off = 0;
    for (const lineText of raw.split("\n")) {
      const ls = off;
      const le = off + lineText.length;
      off = le + 1;
      // Only rewrite assignment lines inside a <script> body (original
      // lowerPuiReactivity ran per-body; markup must stay untouched).
      if (!bodyRanges.some(([s, e]) => ls >= s && le <= e)) continue;
      for (const name of signalNames) {
        if (lineText.includes(`const __sig_${name}`)) continue;
        const m = lineText.match(new RegExp(`^(\\s*)${name}\\s*=\\s*(.+?)\\s*;?\\s*$`));
        if (!m || m[2] === undefined) continue;
        const indent = m[1]!;
        const exprRel = lineText.lastIndexOf(m[2]!);
        try {
          repl(ls, ls + exprRel, `${indent}__sig_${name}.set(`);
          repl(ls + exprRel + m[2]!.length, le, `);`);
        } catch {
          /* overlaps a decl we already rewrote — skip */
        }
        break;
      }
    }
  }

  // Inline import injection (linePreserving: no newline → line count ==
  // raw). lowerPuiReactivity prepends the signal import FIRST then the
  // svelte imports SECOND, so the svelte imports end up before the signal
  // import in the final string — mirror that order here for byte-parity.
  let prefix = "";
  if (svelteImports.size) {
    prefix += `import { ${[...svelteImports].join(", ")} } from "@lyku/para-ui"; `;
  }
  // SvelteKit nav hooks come from $app/navigation (not the runtime).
  // Dedup against a hand-authored import so we don't double-declare.
  if (kitNavImports.size) {
    const existing = new Set<string>();
    const navRe = /import\s*\{([^}]+)\}\s*from\s+['"]\$app\/navigation['"]/g;
    let nm: RegExpExecArray | null;
    while ((nm = navRe.exec(raw)) !== null)
      for (const n of nm[1]!.split(",")) existing.add(n.trim().split(/\s+as\s+/)[0]!);
    const toAdd = [...kitNavImports].filter(n => !existing.has(n));
    if (toAdd.length) prefix += `import { ${toAdd.join(", ")} } from "$app/navigation"; `;
  }
  const paraImports: string[] = [];
  if (needsSignalImport) paraImports.push("signal");
  if (needsPromiseSignal) paraImports.push("promiseSignal");
  if (paraImports.length && !/from\s+['"]@para\/signals['"]/.test(raw)) {
    prefix += `import { ${paraImports.join(", ")} } from "@lyku/para-signals"; `;
  }
  // Insert imports at the start of the first <script> body (inside the
  // tag), inline — matches lowerPuiReactivity, keeps line count == raw.
  if (prefix && firstBodyStart >= 0) ms.appendLeft(firstBodyStart, prefix);

  return {
    code: ms.toString(),
    map: ms.generateMap({ source: filename, hires: true, includeContent: false }),
  };
}

export interface PuiTransform {
  code: string;
  toGenerated(line: number, character: number): { line: number; character: number } | null;
  toOriginal(line: number, character: number): { line: number; character: number } | null;
}

export function puiTransform(raw: string, filename: string): PuiTransform {
  const low = lowerPuiFileWithMap(raw, filename);
  const out = svelte2tsx(low.code, { filename, isTsFile: true, mode: "ts" });

  const sv = new TraceMap(out.map as never); // generated ↔ lowered
  const lo = new TraceMap(low.map as never); // lowered ↔ raw
  const SOURCE = filename;
  const LOWERED = filename + ".lowered";

  return {
    code: out.code,
    toGenerated(line, character) {
      // raw → lowered → generated
      const l = generatedPositionFor(lo, { source: SOURCE, line: line + 1, column: character });
      if (l.line == null) return null;
      const g = generatedPositionFor(sv, { source: LOWERED, line: l.line, column: l.column ?? 0 });
      if (g.line == null) {
        // svelte2tsx labels its source by `filename`, not `.lowered`;
        // retry with the actual source name.
        const g2 = generatedPositionFor(sv, { source: SOURCE, line: l.line, column: l.column ?? 0 });
        if (g2.line == null) return null;
        return { line: g2.line - 1, character: g2.column ?? 0 };
      }
      return { line: g.line - 1, character: g.column ?? 0 };
    },
    toOriginal(line, character) {
      // generated → lowered → raw
      const l = originalPositionFor(sv, { line: line + 1, column: character });
      if (l.line == null) return null;
      const o = originalPositionFor(lo, { line: l.line, column: l.column ?? 0 });
      if (o.line == null) return null;
      return { line: o.line - 1, character: o.column ?? 0 };
    },
  };
}

/** Test hook: lowered code only (for byte-parity vs lowerPuiReactivity). */
export function _puiLoweredCode(raw: string, filename = "x.pui"): string {
  return lowerPuiFileWithMap(raw, filename).code;
}
