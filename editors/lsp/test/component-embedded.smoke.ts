#!/usr/bin/env parabun
// Smoke test: parabun-lsp serves diagnostics on Svelte-shaped component files.
// Covers both `.svelte` (legacy preprocessor flow — only `lang="pts"` etc.
// engages) and `.pui` (Para's native UI format — file extension is the
// marker; bare `<script>` and `<script lang="ts">` engage too). Verifies
// type-error diagnostics, clean-script silence, and well-formedness
// (unclosed `<script>` tag).

import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const LSP = path.resolve(__dirname, "..", "parabun-lsp.ts");
const lspDir = path.resolve(__dirname, "..");

// parabun-lsp `require("parabun-pui-transform")`s the bundled .pui
// projection. The packaged .vsix gets it via copy-assets; a source run
// has no equivalent, so without this the `.pui` cases never actually
// exercise the projection (silent: they'd just see zero diagnostics —
// which is precisely how the LYK-911/912 .pui bugs went unnoticed).
// Build + install it into node_modules so the smoke is faithful.
function ensurePuiTransformModule(): void {
  const dest = path.join(lspDir, "node_modules", "parabun-pui-transform");
  execFileSync(process.execPath, ["esbuild-pui-transform.mjs"], { cwd: lspDir, stdio: "ignore" });
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(lspDir, "dist-pui-transform", "pui-transform.js"), path.join(dest, "index.js"));
  fs.writeFileSync(
    path.join(dest, "package.json"),
    JSON.stringify({ name: "parabun-pui-transform", version: "0.1.0", main: "index.js" }, null, 2) + "\n",
  );
}
ensurePuiTransformModule();

interface Case {
  uri: string;
  text: string;
  expect: "diag-on-line" | "no-diag";
  expectLine?: number;
}

const cases: Case[] = [
  {
    uri: "file:///tmp/SmokeA.svelte",
    text: `<!-- header -->
<script lang="pts">
  const n: number = "not a number";
</script>

<p>hello</p>
`,
    expect: "diag-on-line",
    expectLine: 2,
  },
  {
    uri: "file:///tmp/SmokeB.svelte",
    text: `<script lang="pts">
  export const b: number = 42;
</script>

<p>{b}</p>
`,
    expect: "no-diag",
  },
  {
    uri: "file:///tmp/SmokeC.svelte",
    text: `<script lang="ts">
  export const c: number = "not a number";
</script>

<p>plain svelte file</p>
`,
    expect: "no-diag",
  },
  // .pui: parabun-flavored by file extension. Bare <script> and
  // <script lang="ts"> both engage. Diagnostics fire just like .svelte +
  // lang="pts".
  {
    uri: "file:///tmp/SmokeD.pui",
    text: `<script lang="pts">
  export const d: number = "still wrong";
</script>

<p>pui with explicit lang</p>
`,
    expect: "diag-on-line",
    expectLine: 1,
  },
  {
    uri: "file:///tmp/SmokeE.pui",
    text: `<script lang="ts">
  export const e: number = "ts inside pui should still type-check";
</script>

<p>pui with lang=ts</p>
`,
    expect: "diag-on-line",
    expectLine: 1,
  },
  {
    uri: "file:///tmp/SmokeF.pui",
    text: `<script>
  export const f: number = "bare script in pui is parabun";
</script>

<p>pui with bare script</p>
`,
    expect: "diag-on-line",
    expectLine: 1,
  },
  // Well-formedness: unclosed parabun-flavored <script> tag emits a fast-pass
  // diagnostic on the opening tag line. In .pui the bare <script> counts;
  // in .svelte only lang="pts"/"parabun"/"pjs" counts.
  {
    uri: "file:///tmp/SmokeG.pui",
    text: `<script>
  const g: number = 5;

<p>oops, no closing script tag</p>
`,
    expect: "diag-on-line",
    expectLine: 0,
  },
  {
    uri: "file:///tmp/SmokeH.svelte",
    text: `<script lang="pts">
  const h: number = 5;

<p>oops, no closing script tag</p>
`,
    expect: "diag-on-line",
    expectLine: 0,
  },
  // Para `.pui` reactivity keywords must NOT trip the fast-pass parabun
  // parser. mount/prop/single-line-derived were missing from
  // transformParabunToTS + PARABUN_SYNTAX_RE and produced a spurious
  // `Expected ";" but found "{"` (source "parabun") on valid .pui.
  {
    // `mount` was retired as a keyword (2026-05-17) — lifecycle is plain
    // Svelte calls now, auto-imported by the projection (no false
    // `Cannot find name 'onMount'`). This also regression-covers that.
    uri: "file:///tmp/SmokeI.pui",
    text: `<script lang="ts">
  prop title: string = '', count = 0;
  derived shout = title;
  onMount(() => {
    console.log(shout, count);
  });
</script>

<p>{shout}</p>
`,
    expect: "no-diag",
  },
  {
    uri: "file:///tmp/SmokeJ.pui",
    text: `<script lang="ts">
  onMount(() => {});
</script>

<p>plain onMount call, auto-imported</p>
`,
    expect: "no-diag",
  },
  {
    // Multi-line `derived = …` (ternary wrap) — projection must capture
    // the whole expression, not truncate at the first newline (was
    // "Unexpected ?"). Regression for the pui-transform derivedInitEnd fix.
    uri: "file:///tmp/SmokeJ2.pui",
    text: `<script lang="ts">
  prop user: { id: number } | null = null;
  derived currentUser = user && Object.keys(user).length > 0
            ? user
            : { id: -1 };
</script>

<p>{currentUser.id}</p>
`,
    expect: "no-diag",
  },
  {
    // Single-statement `effect EXPR;` must project to valid TS so the
    // REST of the file still type-checks — otherwise an unprojected
    // `effect appSync.sync();` poisons parsing and NO undefined-name
    // diagnostics fire anywhere (the +layout.pui `mosudnt`/`mount;`
    // report). Here `effect` line is clean; the typo on the next line
    // must still be flagged.
    uri: "file:///tmp/SmokeJ3.pui",
    text: `<script lang="ts">
  let n = $state(0);
  effect console.log(n);
  nosuchvar;
</script>

<p>{n}</p>
`,
    expect: "diag-on-line",
    expectLine: 3,
  },
  {
    // The literal +layout.pui report: single-stmt `effect` present AND a
    // bare `mount;` (retired keyword → now an undefined identifier). The
    // fast undefined-name pass must run for .pui (it used to bail on the
    // extension) and flag `mount` on its line.
    uri: "file:///tmp/SmokeJ4.pui",
    text: `<script lang="ts">
  effect doStuff();
  mount;
</script>

<p>x</p>
`,
    expect: "diag-on-line",
    expectLine: 2,
  },
  // LYK-911: block-form `derived NAME { … }` can't be column-shimmed by
  // the legacy fast-pass transform; routing the .pui fast pass through
  // the single-source pui-transform projection makes it clean.
  {
    uri: "file:///tmp/SmokeK.pui",
    text: `<script lang="ts">
  derived total {
    let s = 0;
    for (const n of [1, 2, 3]) s += n;
    return s;
  }
</script>

<p>{total}</p>
`,
    expect: "no-diag",
  },
  // The new single-source path must still surface genuine syntax errors
  // (not just suppress everything). Malformed type annotation → parse
  // error on line 1.
  {
    uri: "file:///tmp/SmokeM.pui",
    text: `<script lang="ts">
  const broken: = 5;
</script>

<p>x</p>
`,
    expect: "diag-on-line",
    expectLine: 1,
  },
  // LYK-913: a `fun`-declared function must resolve with REAL types via
  // the projection (was `any` — `fun` reached svelte2tsx unlowered).
  // Proof: a type error THROUGH a `fun` function is caught. If `fun`
  // weren't lowered, `add` would be `any`, `add(1,2)` `any`, the
  // string-assignment would be allowed, and there'd be NO diagnostic.
  {
    uri: "file:///tmp/SmokeN.pui",
    text: `<script lang="ts">
  fun add(a: number, b: number): number { return a + b; }
  const wrong: string = add(1, 2);
</script>

<p>{wrong}</p>
`,
    expect: "diag-on-line",
    expectLine: 2,
  },
  // LYK-914: a `|>` pipeline inside a function body must lower in the
  // projection so types flow through it. `5 |> double` → `double(5)`
  // (number); assigning to `string` is a real TS error on line 3. If the
  // pipeline weren't lowered (the pre-LYK-914 block no-op), the body
  // would be invalid TS and this exact type error wouldn't surface.
  {
    uri: "file:///tmp/SmokeO.pui",
    text: `<script lang="ts">
  fun double(n: number): number { return n * 2; }
  fun run(): void {
    const r: string = 5 |> double;
    console.log(r);
  }
</script>

<p>pipe in fn body</p>
`,
    expect: "diag-on-line",
    expectLine: 3,
  },
  // LYK-915: `is` lowers to `Type.parse(x).tag === "Ok"`. Unlowered
  // `x is User` is a TS syntax error → would diagnose. With a local
  // `User` shim in scope it lowers + type-checks clean.
  {
    uri: "file:///tmp/SmokeP.pui",
    text: `<script lang="ts">
  const User = { parse: (v: unknown) => ({ tag: "Ok" as const }) };
  const input: unknown = 1;
  const ok: boolean = input is User;
  console.log(ok);
</script>

<p>is guard</p>
`,
    expect: "no-diag",
  },
  // LYK-915: decimal `1.5d` lowers to `__paraDec("1.5")`. Unlowered,
  // `1.5d` is a TS lex/parse error → would diagnose. The injected
  // `__paraDec` name is projection scaffolding (PUI_SCAFFOLD_DIAG).
  {
    uri: "file:///tmp/SmokeQ.pui",
    text: `<script lang="ts">
  const price = 0.1d + 0.2d;
  console.log(price);
</script>

<p>decimal literal</p>
`,
    expect: "no-diag",
  },
  // LYK-915: range `1..3` lowers to `__parabunRange(1, 3)`. Unlowered,
  // `1..3` is a TS parse error → would diagnose. `__parabunRange` is
  // filtered projection scaffolding.
  {
    uri: "file:///tmp/SmokeR.pui",
    text: `<script lang="ts">
  fun run(): void {
    for (const i of 1..3) console.log(i);
  }
  run();
</script>

<p>range in fn body</p>
`,
    expect: "no-diag",
  },
  // LYK-916: `match` lowers to a parse-safe, subject-typed `any` stub.
  // `pick` returns `string` (declared), so `const bad: number = pick(2)`
  // is a real TS error on line 2. Proves match no longer breaks the
  // projection (no syntax error / no `any` cascade) AND that `fun` +
  // signature typing flows around it.
  {
    uri: "file:///tmp/SmokeS.pui",
    text: `<script lang="ts">
  fun pick(n: number): string { return match n { 1 => "a", _ => "b" }; }
  const bad: number = pick(2);
  console.log(bad);
</script>

<p>match in fn body</p>
`,
    expect: "diag-on-line",
    expectLine: 2,
  },
  // LYK-916: a clean multi-line `match` must parse with zero diagnostics
  // (was a svelte2tsx/tsc syntax error → cascade before the stub).
  {
    uri: "file:///tmp/SmokeT.pui",
    text: `<script lang="ts">
  const status = 200;
  const label = match status {
    200 => "ok",
    404 => "missing",
    _ => "unknown"
  };
  console.log(label);
</script>

<p>{label}</p>
`,
    expect: "no-diag",
  },
];

const proc = spawn("parabun", ["run", LSP, "--stdio"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, BUN_DEBUG_QUIET_LOGS: "1" },
});

let buf = "";
const allPublishes: { uri: string; diagnostics: any[] }[] = [];

function send(msg: object): void {
  const json = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`;
  proc.stdin.write(header + json);
}

proc.stdout.setEncoding("utf8");
proc.stdout.on("data", (chunk: string) => {
  buf += chunk;
  while (true) {
    const headerEnd = buf.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const header = buf.slice(0, headerEnd);
    const lenMatch = header.match(/Content-Length:\s*(\d+)/i);
    if (!lenMatch) {
      buf = buf.slice(headerEnd + 4);
      continue;
    }
    const len = Number(lenMatch[1]);
    const bodyStart = headerEnd + 4;
    if (buf.length < bodyStart + len) break;
    const body = buf.slice(bodyStart, bodyStart + len);
    buf = buf.slice(bodyStart + len);
    let msg: any;
    try {
      msg = JSON.parse(body);
    } catch {
      continue;
    }
    if (msg.method === "textDocument/publishDiagnostics") allPublishes.push(msg.params);
  }
});

proc.stderr.on("data", (chunk: Buffer) => {
  const s = chunk.toString();
  if (s.trim()) console.error("[lsp stderr]", s.trim());
});

async function run(): Promise<void> {
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { processId: process.pid, rootUri: "file:///raid/parabun", capabilities: {} },
  });
  send({ jsonrpc: "2.0", method: "initialized", params: {} });

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: c.uri,
          languageId: c.uri.endsWith(".pui") ? "parabun-ui" : "svelte",
          version: 1,
          text: c.text,
        },
      },
    });
  }

  // Wait long enough for the slow tsc pass on all three docs.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (cases.every(c => allPublishes.some(p => p.uri === c.uri))) {
      // Wait a bit more in case slow pass replaces fast pass.
      await new Promise(r => setTimeout(r, 1500));
      break;
    }
    await new Promise(r => setTimeout(r, 250));
  }

  let failed = 0;
  for (const c of cases) {
    // Use the LAST publish for this URI (slow pass clobbers fast pass).
    const latest = [...allPublishes].reverse().find(p => p.uri === c.uri);
    const diags = latest?.diagnostics ?? [];
    if (c.expect === "no-diag") {
      if (diags.length !== 0) {
        console.error(`FAIL ${c.uri}: expected no diagnostics, got ${diags.length}:`, diags);
        failed++;
      } else {
        console.log(`PASS ${c.uri}: no diagnostics`);
      }
    } else {
      const onLine = diags.some(d => d.range?.start?.line === c.expectLine);
      if (!onLine) {
        console.error(`FAIL ${c.uri}: expected diagnostic on line ${c.expectLine}, got ${JSON.stringify(diags)}`);
        failed++;
      } else {
        console.log(`PASS ${c.uri}: diagnostic on line ${c.expectLine}`);
      }
    }
  }

  proc.kill();
  process.exit(failed === 0 ? 0 : 1);
}

run();
