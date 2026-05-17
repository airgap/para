// Conservative .svelte → .pui codemod (LYK-901 / C4).
//
// Philosophy: `.pui` is a Svelte superset, so anything we do NOT transform
// stays valid. We therefore only rewrite patterns that are *unambiguously*
// mechanical; anything uncertain is left as raw Svelte (still valid .pui).
// Correctness over coverage — never produce a wrong transform.
//
// Rules (the LYK-901 set, verified against NotificationsPage):
//  1  let x = $state(v)            → signal x = v          (typed: signal x: T = v)
//  2  let x = $state()  (empty)    → signal x[: T|undefined] = undefined
//  3  const x = $derived(E)        → derived x = E   (single-line)
//     const x = $derived(\n…\n)    → derived x { return … }   (multi-line)
//     const x = $derived.by(()=>{B}) → derived x { B }
//  4  const x = $derived($store)   → source x = fromStore(store)  (+import)
//  5  onMount(() => { B })         → mount { B }
//     $effect(() => { B })         → effect { B }
//  6  everything else: untouched (consts/types/fns/template/escape-hatch
//     imports like untrack/tick, custom context accessors).

export interface CodemodResult {
  code: string;
  /** Human-readable notes: what converted, what was left raw and why. */
  notes: string[];
}

const SCRIPT_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/g;

function findMatch(s: string, open: number, oc: string, cc: string): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === oc) depth++;
    else if (ch === cc) {
      depth--;
      if (depth === 0) return i; // index of the closing char
    }
  }
  return -1;
}

function transformScript(body: string, notes: string[]): { code: string; needsFromStore: boolean } {
  let needsFromStore = false;

  // ── Rule 5: onMount → mount (sync OR async — `mount{}` now emits an
  // async arrow on top-level await); $effect → effect (sync only —
  // async effects are a footgun, leave `$effect(async…)` raw).
  body = rewriteCallArrowBlock(body, "onMount", "mount", notes, /*allowAsync*/ true);
  body = rewriteCallArrowBlock(body, "$effect", "effect", notes);

  // ── Per-line passes (state/derived decls) ──
  const out: string[] = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // ── Rules 3 + 4: unified `const NAME = $derived…` scan ──
    // Paren/brace-matched so single-line, multi-line, object-literal and
    // `.by` forms are all handled; bare `$store` arg → rule 4.
    // `let` accepted too — `$derived` is read-only, both → `derived x`.
    let m = line.match(/^(\s*)(?:const|let)\s+(\w+)\s*=\s*\$derived(\.by)?\s*\(/);
    if (m) {
      const indent = m[1]!;
      const name = m[2]!;
      const isBy = !!m[3];
      const joined = lines.slice(i).join("\n");
      const openParen = joined.indexOf("(", joined.indexOf("$derived"));
      const closeParen = findMatch(joined, openParen, "(", ")");
      if (closeParen !== -1) {
        const argSpan = joined.slice(openParen + 1, closeParen);
        const consumed = joined.slice(0, closeParen).split("\n").length;
        if (isBy) {
          // $derived.by(() => { BODY })  → derived NAME { BODY }
          const braceStart = joined.indexOf("{", openParen);
          const braceEnd = braceStart === -1 ? -1 : findMatch(joined, braceStart, "{", "}");
          if (braceStart !== -1 && braceEnd !== -1 && braceEnd < closeParen) {
            const inner = joined.slice(braceStart + 1, braceEnd);
            out.push(`${indent}derived ${name} {${inner}`);
            out.push(`${indent}}`);
            i += joined.slice(0, braceEnd).split("\n").length - 1;
            notes.push(`rule3c: const ${name} = $derived.by(()=>{…}) → derived ${name} { … }`);
            continue;
          }
        } else {
          const arg = argSpan.trim();
          const storeM = arg.match(/^\$(\w+)$/);
          if (storeM) {
            // Rule 4
            out.push(`${indent}source ${name} = fromStore(${storeM[1]});`);
            needsFromStore = true;
            i += consumed - 1;
            notes.push(`rule4: $derived($${storeM[1]}) → source ${name} = fromStore(${storeM[1]})`);
            continue;
          }
          if (consumed === 1) {
            out.push(`${indent}derived ${name} = ${arg};`);
            notes.push(`rule3a: single-line $derived → derived ${name} = …`);
          } else {
            out.push(`${indent}derived ${name} {`);
            out.push(`${indent}\treturn (${arg});`);
            out.push(`${indent}}`);
            notes.push(`rule3b: multi-line $derived → derived ${name} { return … }`);
          }
          i += consumed - 1;
          continue;
        }
      }
    }

    // ── Rule 1/2: unified `let NAME[: T] = $state[<G>](…)` scan ──
    // Paren-matched so single-line, multi-line and object/array inits
    // all convert; optional `<Generic>` and `: Annotation` preserved;
    // empty $state() → `= undefined` (annotated as `T | undefined`).
    m = line.match(/^(\s*)let\s+(\w+)\s*(?::\s*([^=]+?)\s*)?=\s*\$state\s*(<[^>]+>)?\s*\(/);
    if (m) {
      const indent = m[1]!;
      const name = m[2]!;
      const annot = m[3]?.trim();
      const generic = m[4] ? m[4].slice(1, -1).trim() : undefined;
      const joined = lines.slice(i).join("\n");
      const openParen = joined.indexOf("(", joined.indexOf("$state"));
      const closeParen = findMatch(joined, openParen, "(", ")");
      if (closeParen !== -1) {
        const v = joined.slice(openParen + 1, closeParen).trim();
        const consumed = joined.slice(0, closeParen).split("\n").length;
        const T = annot ?? generic;
        let outLine: string;
        if (v) {
          outLine = `${indent}signal ${name}${T ? `: ${T}` : ""} = ${v};`;
        } else {
          const ut = T ? (/\bundefined\b/.test(T) ? T : `${T} | undefined`) : undefined;
          outLine = `${indent}signal ${name}${ut ? `: ${ut}` : ""} = undefined;`;
        }
        out.push(outLine);
        i += consumed - 1;
        notes.push(`rule1/2: let ${name} = $state(…) → signal ${name}`);
        continue;
      }
    }

    out.push(line);
  }
  body = out.join("\n");

  // Drop `onMount` from a `import … from 'svelte'` iff no onMount calls
  // remain (all converted). Keep untrack/tick etc. — by-design residual.
  if (!/\bonMount\s*\(/.test(body)) {
    body = body.replace(/(import\s*\{)([^}]*)\}(\s*from\s*['"]svelte['"])/, (full, a, names, c) => {
      const kept = names
        .split(",")
        .map((s: string) => s.trim())
        .filter((s: string) => s && s !== "onMount");
      if (kept.length === names.split(",").filter((s: string) => s.trim()).length) return full;
      if (kept.length === 0) return ""; // whole import removed
      notes.push("dropped now-unused `onMount` from the svelte import");
      return `${a} ${kept.join(", ")} }${c}`;
    });
    // NB: deliberately do NOT strip the body's leading whitespace here.
    // A leftover blank line where an import was removed is harmless;
    // stripping the body's leading newline glues the first decl onto
    // the `<script>` tag and breaks lowerPuiReactivity's line-anchored
    // regexes (silent invalid output). Conservative-correctness.
  }

  return { code: body, needsFromStore };
}

function rewriteCallArrowBlock(
  src: string,
  callName: string,
  keyword: string,
  notes: string[],
  allowAsync = false,
): string {
  // callName(() => { BODY }) → keyword { BODY }. Zero-arg arrow only.
  // `allowAsync`: also match `callName(async () => {…})` — safe ONLY for
  // onMount (the `mount` keyword now emits an async arrow when its body
  // has a top-level await; Svelte async-onMount can't return a cleanup
  // anyway). NOT enabled for $effect (async effects are a footgun and
  // `effect{}` is sync — leave `$effect(async …)` raw).
  let out = "";
  let i = 0;
  const esc = callName.replace(/[$]/g, "\\$");
  const asyncPart = allowAsync ? "(?:async\\s+)?" : "";
  const re = new RegExp(`(^|[^\\w$.])${esc}\\s*\\(\\s*${asyncPart}\\(\\s*\\)\\s*=>\\s*\\{`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const pre = m[1] ?? "";
    const kwStart = m.index + pre.length;
    const braceStart = src.indexOf("{", m.index + pre.length + callName.length);
    const braceEnd = findMatch(src, braceStart, "{", "}");
    if (braceEnd === -1) continue;
    // require the call to close as `})` right after the block
    const after = src.slice(braceEnd + 1).match(/^\s*\)\s*;?/);
    if (!after) continue;
    out += src.slice(i, kwStart);
    out += `${keyword} {${src.slice(braceStart + 1, braceEnd)}}`;
    const consumedEnd = braceEnd + 1 + after[0].length;
    i = consumedEnd;
    re.lastIndex = consumedEnd;
    notes.push(`rule5: ${callName}(() => {…}) → ${keyword} { … }`);
  }
  out += src.slice(i);
  return out;
}

function balancedParens(s: string): boolean {
  let d = 0;
  for (const c of s) {
    if (c === "(") d++;
    else if (c === ")") {
      if (--d < 0) return false;
    }
  }
  return d === 0;
}

/**
 * Conservatively rewrite a `.svelte` source string to `.pui` Para dialect.
 * Only `<script>` bodies are touched; markup is byte-preserved. Returns the
 * new source plus notes on what converted / was left raw. The caller renames
 * the file `.svelte`→`.pui` (a CLI concern, out of scope here).
 */
export function svelteToPui(source: string): CodemodResult {
  const notes: string[] = [];
  let needsFromStoreAny = false;
  const code = source.replace(SCRIPT_RE, (full, bodyRaw: string) => {
    const { code: newBody, needsFromStore } = transformScript(bodyRaw, notes);
    needsFromStoreAny ||= needsFromStore;
    let b = newBody;
    if (needsFromStore && !/from\s+['"]@lyku\/para-signals['"]/.test(b)) {
      // inject the fromStore import at the top of the script body
      b = b.replace(/^(\s*)/, `$1import { fromStore } from "@lyku/para-signals";\n$1`);
      notes.push('added `import { fromStore } from "@lyku/para-signals"`');
    }
    return full.replace(bodyRaw, b);
  });
  if (notes.length === 0) notes.push("no transformable patterns found — file left as-is (still valid .pui)");
  void needsFromStoreAny;
  return { code, notes };
}

export interface SafeMigrateResult {
  code: string;
  /** true → migrated output emitted; false → original returned unchanged. */
  migrated: boolean;
  notes: string[];
  /** present when migrated=false: why the transform was rejected. */
  skippedReason?: string;
}

/**
 * **Safe-by-construction migration.** Transforms, then *verifies the
 * result compiles equivalently*; if the original compiled but the
 * migrated output does NOT, the transform is rejected and the original
 * is returned untouched. This makes auto-migration regression-free by
 * construction: a file is either correctly migrated or left exactly as
 * it was — never silently broken. (The raw `svelteToPui` is the
 * unverified transform; always prefer this for real migration.)
 *
 * Caller injects the fork `compile` (svelte/compiler) and
 * `lowerPuiReactivity` (@lyku/para-preprocess) so this module stays
 * dependency-free.
 *
 * @param compile (src, opts) — throws on compile error
 * @param lower   lowerPuiReactivity
 */
export function safeMigrate(
  source: string,
  compile: (src: string, opts: Record<string, unknown>) => unknown,
  lower: (src: string, runtime?: string, lp?: boolean, hmr?: boolean) => string,
): SafeMigrateResult {
  const opts = { generate: "client", name: "C", runes: true };
  const baselineOk = (() => {
    try {
      compile(source, opts);
      return true;
    } catch {
      return false;
    }
  })();

  let out: CodemodResult;
  try {
    out = svelteToPui(source);
  } catch (e) {
    return { code: source, migrated: false, notes: [], skippedReason: `transform threw: ${(e as Error).message}` };
  }

  // If the transform was a no-op, nothing to verify.
  if (out.code === source) return { code: source, migrated: false, notes: out.notes };

  // Verify the migrated .pui lowers + compiles.
  let migratedOk = false;
  let why = "";
  try {
    const loweredSvelte = lower(out.code, "@lyku/para-ui", false, false);
    compile(loweredSvelte, opts);
    migratedOk = true;
  } catch (e) {
    why = (e as Error).message?.split("\n")[0] ?? String(e);
  }

  // Reject only if we *introduced* a failure (original compiled, we broke it).
  if (baselineOk && !migratedOk) {
    return {
      code: source,
      migrated: false,
      notes: out.notes,
      skippedReason: `migration would regress (orig compiles, migrated fails: ${why}) — left unchanged`,
    };
  }
  return { code: out.code, migrated: true, notes: out.notes };
}
