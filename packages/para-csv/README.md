# @para/csv

Streaming CSV parser with two output modes: row-objects (the standard JS shape) and **typed-array columns** (the unique one). The columnar mode parses straight into `Float32Array` / `Float64Array` / `Int32Array` / etc. so numeric data lands in compute-ready buffers with no per-row object allocation and no per-cell boxing.

```js
import csv from "@para/csv";
import { sum } from "@para/simd";

// Columnar — rows go straight into typed-array buffers per column.
const cols = await csv.parseColumns(Bun.file("./sensors.csv"), {
  schema: { ts: "f64", temp: "f32", sensorId: "i32", label: "string" },
});
// cols.ts is a Float64Array, cols.temp a Float32Array, etc. Feed
// straight into @para/simd / @para/arrow with no copy.
const totalTemp = sum(cols.temp);
```

```js
// Row-objects — the standard async iterator shape.
for await (const row of csv.parseCsv(file.stream())) {
  // row = { col1, col2, ... }
}
```

## Why columnar?

Most CSV libraries return `Array<{col1, col2}>` row objects. Each row is a JS Object (~56-byte header) plus a boxed `Number` for each numeric cell — ~24 bytes per number. For a 1M-row, 4-numeric-column CSV that's ~120 MB of boxing overhead before you've done any actual work.

`parseColumns` writes straight into `TypedArray` buffers (one per column), grows them exponentially, and tight-fits the result at end-of-stream. For a 200K-row × 4-numeric-column CSV on this codebase: 1.4× faster than the row-objects path, and the result is 3 MB of contiguous bytes — ready to hand to `@para/simd`, `@para/arrow.fromColumns()`, GPU upload, or whatever else expects packed numeric data.

The JS ecosystem otherwise covers this with DuckDB-WASM (10+ MB bundle) or Apache Arrow JS (clunky CSV loader). Pure-JS streaming CSV → typed-array columns sits in a real gap, mostly useful for: edge functions and Workers (no room for the big bundles), browser data viz at the medium-data scale, ML/data prep where you'd rather skip Python.

## API

### `parseColumns(source, { schema, headers?, ...dialect })`

Returns a `Promise<{ [col]: TypedArray | string[] }>` with one buffer per schema column.

- **`schema`** — object mapping column name to type:
  - `"f32"` / `"f64"` → `Float32Array` / `Float64Array`
  - `"i8"` / `"u8"` / `"i16"` / `"u16"` / `"i32"` / `"u32"` → matching int TypedArray
  - `"string"` → plain `string[]` (TypedArrays can't hold strings)
- **`headers`** — `true` (default) treats the first row as headers and matches schema keys against header cell names. `false` maps schema keys to column indices in declaration order. Or pass an explicit array of header names.
- **dialect options** — see [`parseCsv`](#parsecsvsource-opts) below.

Empty / missing numeric cells become `NaN` for floats, `0` for ints. Caller validates if `0` is a meaningful sentinel.

### `parseCsv(source, opts?)`

The classical row-objects async iterator. RFC 4180 quoting, optional headers, type inference. `parallel: true` opt-in for off-main-thread parsing via `@para/parallel`.

```js
for await (const row of csv.parseCsv("./big.csv", { headers: true })) {
  // row = { col1: ..., col2: ... } with inferred types
}
```

Options (shared across `parseCsv`, `parseColumns`, `parseBatches`, `reduceColumns` unless noted):

| Option | Default | What it does |
| --- | --- | --- |
| `delimiter` | `","` | Field delimiter. `"\t"` for TSV. Pass `""` to auto-detect from the first non-comment line (`,` `\t` `;` `|`). |
| `quote` | `'"'` | Quote character. |
| `escape` | same as `quote` | RFC 4180 doubled-quote by default. Set to `"\\"` for backslash-escape dialects. |
| `comment` | `""` (off) | If set, lines starting with this character are skipped before any field opens. |
| `trim` | `false` | Strip whitespace around each cell. Quoted cells stay verbatim. |
| `skipEmptyLines` | `true` | Drop wholly-blank rows. |
| `headers` | `true` | First row is headers (object output). `false` for arrays. `string[]` to pass explicit headers. |
| `transformHeader` | none | `(header, index) => string`. Normalize header casing / spacing before object keys are built or schema lookup happens. |
| `transform` | none | `(value, column) => string`. `parseCsv` only — map each cell value before type inference. |
| `maxRows` | `Infinity` | Cap on data rows yielded; the header row doesn't count. Trivial preview support. |
| `typeInference` | `true` | `parseCsv` only — auto-coerce numeric / boolean / null. |
| `skipLines` | `0` | Skip leading rows before header detection. |
| `parallel` | `false` | Off-main-thread parse via `@para/parallel`. See below. |

A leading UTF-8 BOM is stripped from the first chunk automatically.

### `stringify(rows, opts?)`

Inverse of `parseCsv`. Accepts an array of objects (header row inferred from key union) or an array of arrays (no header row unless `headers` is passed).

```js
const text = csv.stringify([
  { id: 1, name: "Ada, Lovelace" },
  { id: 2, name: "Grace" },
]);
// id,name
// 1,"Ada, Lovelace"
// 2,Grace
```

Options: `delimiter`, `quote`, `escape`, `newline` (default `"\r\n"`), `headers` (`true` / `false` / `string[]`), `bom`. Cells are quoted only when they need to be (delimiter, quote, escape, CR, LF). `null` / `undefined` round-trip as empty cells. `Date` values stringify as ISO 8601.

## On the parallel mode (`parseCsv` only)

`parallel: true` is **off-the-main-thread**, not necessarily faster per-file. Sweep on this codebase showed 1.18× at 5 MB, 0.95× at 50 MB, 0.93× at 200 MB — overhead grows with input size. Use it when you don't want to block the main thread, not when you need raw throughput on a single big file.

## Status

`private:true / 0.0.0-dev` — pending the workspace split. See [parabun.script.dev](https://parabun.script.dev) for the runtime-bundled story today.
