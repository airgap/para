# @para/arrow

In-memory columnar tables, vectorized computes, Arrow IPC streaming + file formats, and Parquet read/write. Pure JS / Wasm. Wire-compatible with apache-arrow 21.1.0 (verified end-to-end against pyarrow on 10,000-row multi-row-group fixtures).

```js
import { Table, fromRows, toParquet, fromParquet } from "@para/arrow";

const rows = [
  { id: 1, name: "alice", age: 30 },
  { id: 2, name: "bob",   age: 25 },
];

const table = fromRows(rows);
console.log(table.computes.mean("age")); // 27.5

const buf = await toParquet(table, { compression: "snappy" });
const back = await fromParquet(buf);
```

## What ships

- **Table / RecordBatch / Column** — narrow-int widening on read, dictionary-batch decode, `List<T>`.
- **12 computes** — sum / mean / min / max / variance / stddev / quantile / median / distinct / filter / groupBy / sort / cumsum / diff / argMin / argMax / count.
- **Bridges** — `fromRows()` / `toRows()` for the array-of-objects shape JS apps tend to have.
- **Arrow IPC** — streaming + file formats. Hand-rolled FlatBuffers builder/reader (no npm dep). `DictionaryBatch` decode for round-tripping default `Dictionary<Utf8>` string columns.
- **Parquet** — `fromParquet()` / `toParquet()`. Hand-rolled Thrift / Snappy / RLE / dictionary. Compressions: UNCOMPRESSED / SNAPPY / GZIP.

## Pending

Dictionary write encoding. Nested types (Struct / Map / FixedSizeList / Decimal).

## Status

`private:true / 0.0.0-dev` — pending the workspace split. See [parabun.script.dev](https://parabun.script.dev) for the runtime-bundled story today.
