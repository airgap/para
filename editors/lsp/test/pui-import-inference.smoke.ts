#!/usr/bin/env parabun
// Locks #7: cross-file `.pui`-imports-`.pui` PROP-TYPE inference in the
// LSP. A bogus prop value on an imported `.pui` component MUST be flagged
// (TS2322 not-assignable), proving the import resolved to the real
// svelte2tsx-projected $props() — not the loose `*.pui` wildcard ambient.
// Also asserts no phantom Svelte-global diagnostics (svelte2tsx shims).
//
// This chain has SIX stacked failure points (wildcard-ambient shadow /
// svelte2tsx ambients / jsx unset / module-resolution precedence /
// fileExists virtual / fromTsPath open-only) — each silently degrades to
// loose `any`. Hand-verification gave false "works" repeatedly; this is
// the regression gate. Self-contained tmpdir fixture (real on-disk files,
// real file:// URIs, its own tsconfig — mirrors a real Vite+Svelte
// project; the bug only reproduces cross-file + closed import).

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const lspDir = path.resolve(__dirname, "..");
// Faithful: the .pui projection module the LSP require()s. Same setup as
// component-embedded.smoke.ts.
execFileSync(process.execPath, ["esbuild-pui-transform.mjs"], { cwd: lspDir, stdio: "ignore" });
{
  const dest = path.join(lspDir, "node_modules", "parabun-pui-transform");
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(lspDir, "dist-pui-transform", "pui-transform.js"), path.join(dest, "index.js"));
  fs.writeFileSync(
    path.join(dest, "package.json"),
    JSON.stringify({ name: "parabun-pui-transform", version: "0.0.0", main: "index.js" }),
  );
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pui-import-"));
fs.writeFileSync(
  path.join(dir, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      skipLibCheck: true,
      types: [],
    },
    include: ["*.pui", "*.ts"],
  }),
);
fs.writeFileSync(
  path.join(dir, "Child.pui"),
  `<script lang="pts">
\tlet { mode = 'a', count = 0 }: { mode?: 'a' | 'b'; count?: number } = $props();
</script>
<b>{mode}{count}</b>
`,
);
fs.writeFileSync(
  path.join(dir, "Parent.pui"),
  `<script lang="pts">
\timport Child from './Child.pui';
\tsignal n = 0;
</script>
<Child mode="THIS_IS_NOT_A_OR_B" count={n} />
`,
);
const parentUri = "file://" + path.join(dir, "Parent.pui");
const parentText = fs.readFileSync(path.join(dir, "Parent.pui"), "utf8");

const proc = spawn(process.execPath, [path.join(lspDir, "parabun-lsp.ts")], {
  cwd: lspDir,
  stdio: ["pipe", "pipe", "ignore"],
  env: { ...process.env, BUN_DEBUG_QUIET_LOGS: "1" },
});

let buf = Buffer.alloc(0);
const pending = new Map<number, (v: any) => void>();
const diags: any[] = [];
let nextId = 1;
function send(o: any) {
  const s = JSON.stringify({ jsonrpc: "2.0", ...o });
  proc.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
}
function req(method: string, params: any) {
  const id = nextId++;
  return new Promise<any>(res => {
    pending.set(id, res);
    send({ id, method, params });
  });
}
proc.stdout.on("data", (d: Buffer) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const h = buf.indexOf("\r\n\r\n");
    if (h < 0) return;
    const m = /Content-Length: (\d+)/i.exec(buf.slice(0, h).toString());
    if (!m) return;
    const len = +m[1]!;
    const start = h + 4;
    if (buf.length < start + len) return;
    const msg = JSON.parse(buf.slice(start, start + len).toString());
    buf = buf.slice(start + len);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)!(msg.result);
      pending.delete(msg.id);
    } else if (msg.method === "textDocument/publishDiagnostics" && msg.params?.uri === parentUri) {
      diags.push(...(msg.params.diagnostics || []));
    }
  }
});

const fail = (m: string) => {
  console.log(`FAIL ${m}`);
  proc.kill();
  process.exit(1);
};

(async () => {
  await req("initialize", {
    processId: process.pid,
    rootUri: "file://" + dir,
    capabilities: {},
    workspaceFolders: [{ uri: "file://" + dir, name: "fx" }],
  });
  send({ method: "initialized", params: {} });
  send({
    method: "textDocument/didOpen",
    params: { textDocument: { uri: parentUri, languageId: "pui", version: 1, text: parentText } },
  });
  await new Promise(r => setTimeout(r, 5000));

  const phantom = diags.filter(d =>
    /svelte-shims|__sveltets|svelteHTML|Cannot find name '(__sveltets|svelteHTML)/.test(d.message),
  );
  const propErr = diags.find(
    d => /not assignable/.test(d.message) && /'a'|"a"|'b'|"b"|mode|THIS_IS_NOT_A_OR_B/.test(d.message),
  );

  console.log(
    "diagnostics:",
    diags.map(d => `[L${d.range?.start?.line}] ${d.message}`),
  );
  if (phantom.length)
    fail(
      `phantom Svelte-global diagnostics leaked (svelte2tsx ambients missing): ${phantom.map(d => d.message).join(" | ")}`,
    );
  if (!propErr)
    fail("bogus prop NOT flagged — `.pui` import resolved to loose ambient, NOT real $props() (#7 regressed)");
  console.log(`PASS pui-import-inference: real cross-file prop type enforced — ${JSON.stringify(propErr.message)}`);
  proc.kill();
  process.exit(0);
})();

setTimeout(() => fail("timeout"), 40000);
