// Compiles src/simd.wat → src/simd.wasm using the `wabt` npm package.
// Run via `bun run build:wasm` in this package. The wasm binary is
// committed so shim consumers don't need wabt at install time — this
// script only runs for maintainers editing the WAT source.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const wabtMod = (await import("wabt" as string)).default;
const wabt = await wabtMod();

const watPath = resolve(root, "src", "simd.wat");
const wasmPath = resolve(root, "src", "simd.wasm");

const wat = readFileSync(watPath, "utf8");
const mod = wabt.parseWat("simd.wat", wat, { simd: true });
try {
  mod.resolveNames();
  mod.validate();
  const { buffer } = mod.toBinary({ log: false, write_debug_names: false });
  writeFileSync(wasmPath, buffer);
  console.log(`wrote ${wasmPath}: ${buffer.byteLength} bytes`);
} finally {
  mod.destroy();
}
