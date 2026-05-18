#!/usr/bin/env parabun
// Parity gate: the LSP's magic-string `.pui` reactivity lowering
// (_puiLoweredCode = lowerPuiFileWithMap().code) MUST be byte-identical
// to the canonical runtime lowering @lyku/para-preprocess
// `lowerPuiReactivity(src,'@lyku/para-ui',true)`.
//
// This is the gate pui-transform.ts's header has long *asserted* exists
// but never actually had — which is exactly how the magic-string port
// silently drifted (e.g. single-statement `effect EXPR;` emitting a
// stray trailing `;` the runtime path doesn't).
//
// SCOPE — deliberately reactivity-only. Two LSP↔canonical deltas are
// INTENTIONAL (see pui-transform.ts header) and are NOT in this corpus,
// because comparing them would be falsely-red, not drift:
//   1. operator desugars (pure / |> / ..! / fun / is / ranges / decimal
//      / match) — LSP-only by design (Zig parser does them at build).
//   2. auto-injected imports (provide / inject / using / source /
//      lifecycle / nav) — LSP places them inside `<script>` for
//      sourcemap line-preservation; canonical emits them before the tag.
//   3. an UNTERMINATED trailing single-statement `effect EXPR` (no `;`,
//      last thing in the script): same root cause as (2) — the LSP's
//      position-preservation invariant keeps the source newline inside
//      the arrow; canonical `.trim()`s it for clean runtime emit. The
//      emitted AST is identical; only insignificant whitespace differs,
//      and only on this degenerate edge. (Investigating it DID surface +
//      fix a real canonical build bug: derivedInitEnd swallowing
//      `</script>` — see expandEffectSingle's `</script>` clamp.)
//      Terminated `effect EXPR;` IS in the corpus and byte-identical.
// Keep this corpus free of all three so a failure here is REAL drift.

import { _puiLoweredCode } from "../pui-transform.ts";
import { lowerPuiReactivity } from "@lyku/para-preprocess";

const cases: Record<string, string> = {
  "signal: scalar": `<script lang="pts">
\tsignal count = 0;
</script>
<b>{count}</b>`,
  "signal: typed": `<script lang="pts">
\tsignal name: string = 'x';
</script>`,
  "signal: multi-declarator": `<script lang="pts">
\tsignal a = 1, b = 2;
</script>`,
  "derived: expression": `<script lang="pts">
\tsignal count = 0;
\tderived doubled = count * 2;
</script>`,
  "derived: block": `<script lang="pts">
\tsignal count = 0;
\tderived big {
\t\treturn count > 10;
\t}
</script>`,
  "effect: block": `<script lang="pts">
\tsignal count = 0;
\teffect {
\t\tconsole.log(count);
\t}
</script>`,
  // The drift this gate was born to catch: single-statement `effect`.
  "effect: single-statement (semicolon)": `<script lang="pts">
\tsignal count = 0;
\teffect console.log(count);
</script>`,
  // NOTE: unterminated trailing `effect EXPR` (no `;`) is intentional
  // delta #3 (see header) — excluded by design, not omitted to go green.
  "prop: typed + default": `<script lang="pts">
\tprop label: string = 'hi';
</script>`,
  "prop: multi": `<script lang="pts">
\tprop a: number;
\tprop b: string = 'x';
</script>`,
  "combined component": `<script lang="pts">
\tsignal count = 0;
\tprop step: number = 1;
\tderived next = count + step;
\tderived gated {
\t\treturn next > 100;
\t}
\teffect {
\t\tconsole.log(next);
\t}
\teffect report(count);
</script>
<button onclick={() => count += step}>{next}</button>`,
};

let failed = 0;
for (const [name, raw] of Object.entries(cases)) {
  const lsp = _puiLoweredCode(raw, "parity.pui");
  const canon = lowerPuiReactivity(raw, "@lyku/para-ui", true);
  if (lsp === canon) {
    console.log(`  ok  ${name}`);
    continue;
  }
  failed++;
  console.log(`FAIL  ${name}  — LSP lowering drifted from canonical`);
  // Minimal first-divergence report.
  const a = lsp.split("\n");
  const b = canon.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      console.log(`  line ${i + 1}:`);
      console.log(`    LSP : ${JSON.stringify(a[i])}`);
      console.log(`    canon: ${JSON.stringify(b[i])}`);
      break;
    }
  }
}

if (failed > 0) {
  console.log(
    `\npui-lower-parity: ${failed} case(s) DRIFTED — the LSP \`.pui\` reactivity lowering no longer matches @lyku/para-preprocess. Reconcile pui-transform.ts to canonical (canonical is authoritative).`,
  );
  process.exit(1);
}
console.log(`\npui-lower-parity: all ${Object.keys(cases).length} reactivity cases byte-identical to canonical.`);
