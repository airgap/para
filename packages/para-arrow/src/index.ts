// Hardcoded module "@para/arrow"
//
// Tier 2 — in-memory columnar tables and a few compute primitives. Built
// to pair with @para/csv (CSV → typed columns → analytical work) and to
// share buffers with @para/simd / parabun:gpu when those land.
//
//   import arrow from "@para/arrow";
//
//   const batch = arrow.recordBatch({
//     age:   new Int32Array([25, 30, 35]),
//     name:  ["alice", "bob", "carol"],
//     score: new Float64Array([0.95, 0.82, 0.71]),
//   });
//
//   batch.numRows;                    // 3
//   batch.column("age").get(0);       // 25
//   arrow.sum(batch.column("age"));   // 90
//
//   const adults = arrow.filter(batch, row => row.age >= 30);
//   const table = arrow.table([batch1, batch2, batch3]);
//
// What's NOT here yet:
//   - Arrow IPC reader / writer (the binary stream + file formats). The
//     spec uses FlatBuffers for schema metadata; landing those means
//     vendoring or hand-rolling a FlatBuffers decoder. Tracked as the
//     v2 ship of this module.
//   - Parquet read/write — its own format, separate from IPC; v3.
//   - Filter / aggregation pushdown to parabun:gpu. Today the computes are
//     scalar JS loops; once IPC is in, the SIMD / GPU paths pair with
//     buffer-residency the same way parabun:image's filters do.
//
// The in-memory object model matches Arrow's enough that swapping in a
// real IPC reader later doesn't change the public API: a Column is a
// typed-array view over its values plus an optional validity bitmap, a
// RecordBatch is a Schema + parallel-length Columns, and a Table is a
// sequence of RecordBatches sharing one Schema.

// ─── Type system ───────────────────────────────────────────────────────────

type ArrowKind = "int32" | "int64" | "float32" | "float64" | "bool" | "utf8" | "list";

// `DataType` is a discriminated union: list types carry a `child` field
// describing the element type; primitive types just have `kind`.
type DataType =
  | { kind: "int32" | "int64" | "float32" | "float64" | "bool" | "utf8" }
  | { kind: "list"; child: DataType };

type Field = {
  name: string;
  type: DataType;
  nullable: boolean;
};

type Schema = {
  fields: Field[];
};

// One column in a RecordBatch. `values` shape depends on `type.kind`:
//   int32 → Int32Array, int64 → BigInt64Array, float32 → Float32Array,
//   float64 → Float64Array, bool → Uint8Array (0/1 per row), utf8 → string[]
//   list  → Int32Array (offsets, length+1 entries), with the actual values
//           in `child` (a Column of the element type whose length is the
//           sum of all per-row list lengths).
//
// `validity` is an optional bitmap (one bit per row, 1 = present, 0 = null).
// Length-bytes is ceil(length/8). Absent means no nulls.
type ColumnValues = Int32Array | BigInt64Array | Float32Array | Float64Array | Uint8Array | string[];

type ColumnGetResult = number | bigint | boolean | string | null | unknown[];

class Column {
  type: DataType;
  length: number;
  values: ColumnValues;
  validity: Uint8Array | undefined;
  /** Child column for list-typed columns. Undefined for primitives. */
  child: Column | undefined;

  constructor(type: DataType, length: number, values: ColumnValues, validity?: Uint8Array, child?: Column) {
    this.type = type;
    this.length = length;
    this.values = values;
    this.validity = validity;
    this.child = child;
  }

  /**
   * Read the value at row `i`. Returns the JS-native form of the column's
   * type — number / bigint / boolean / string / array (for list) — or null
   * when the row is masked off by the validity bitmap.
   */
  get(i: number): ColumnGetResult {
    if (i < 0 || i >= this.length) {
      throw new RangeError(`@para/arrow Column.get: index ${i} out of range [0, ${this.length})`);
    }
    if (this.validity && !((this.validity[i >> 3] >> (i & 7)) & 1)) return null;
    switch (this.type.kind) {
      case "int32":
        return (this.values as Int32Array)[i];
      case "int64":
        return (this.values as BigInt64Array)[i];
      case "float32":
        return (this.values as Float32Array)[i];
      case "float64":
        return (this.values as Float64Array)[i];
      case "bool":
        return ((this.values as Uint8Array)[i] & 1) === 1;
      case "utf8":
        return (this.values as string[])[i];
      case "list": {
        if (!this.child) {
          throw new Error("@para/arrow Column.get: list column has no child");
        }
        const offsets = this.values as Int32Array;
        const start = offsets[i];
        const end = offsets[i + 1];
        const out: unknown[] = new Array(end - start);
        for (let k = 0; k < end - start; k++) out[k] = this.child.get(start + k);
        return out;
      }
    }
  }

  /**
   * Iterate every row. Useful when the row index isn't needed.
   */
  *[Symbol.iterator](): IterableIterator<ColumnGetResult> {
    for (let i = 0; i < this.length; i++) yield this.get(i);
  }
}

class RecordBatch {
  schema: Schema;
  columns: Column[];
  numRows: number;

  constructor(schema: Schema, columns: Column[], numRows: number) {
    this.schema = schema;
    this.columns = columns;
    this.numRows = numRows;
  }

  get numColumns(): number {
    return this.columns.length;
  }

  /**
   * Look up a column by name. Throws when the name isn't in the schema.
   */
  column(name: string): Column {
    const idx = this.schema.fields.findIndex(f => f.name === name);
    if (idx < 0) {
      throw new RangeError(`@para/arrow: no column named ${JSON.stringify(name)}`);
    }
    return this.columns[idx];
  }

  /**
   * Materialize one row as a plain object. Useful for filters and ad-hoc
   * scans — but for high-throughput code, prefer accessing columns by index
   * to skip the per-row property allocation.
   */
  row(i: number): Record<string, number | bigint | boolean | string | null> {
    const out: Record<string, number | bigint | boolean | string | null> = {};
    for (let c = 0; c < this.columns.length; c++) {
      out[this.schema.fields[c].name] = this.columns[c].get(i);
    }
    return out;
  }

  *[Symbol.iterator](): IterableIterator<Record<string, number | bigint | boolean | string | null>> {
    for (let i = 0; i < this.numRows; i++) yield this.row(i);
  }
}

class Table {
  schema: Schema;
  batches: RecordBatch[];
  numRows: number;

  constructor(schema: Schema, batches: RecordBatch[]) {
    this.schema = schema;
    this.batches = batches;
    this.numRows = batches.reduce((n, b) => n + b.numRows, 0);
  }

  get numColumns(): number {
    return this.schema.fields.length;
  }

  /**
   * Lazy concatenated column view. Reads cross batch boundaries by routing
   * `get(i)` to the underlying batch — no upfront allocation. For most
   * compute paths this is fine; for cases where you really want one
   * contiguous typed array, materialize via `arrow.concat(table.column(...))`.
   */
  column(name: string): Column {
    const idx = this.schema.fields.findIndex(f => f.name === name);
    if (idx < 0) throw new RangeError(`@para/arrow: no column named ${JSON.stringify(name)}`);
    const field = this.schema.fields[idx];
    return new ConcatColumn(
      field.type,
      this.batches.map(b => b.columns[idx]),
    );
  }

  *[Symbol.iterator](): IterableIterator<Record<string, number | bigint | boolean | string | null>> {
    for (const batch of this.batches) yield* batch;
  }
}

// Column view that walks a sequence of underlying columns. Exposes the same
// `get` / iteration API as Column. For numeric-typed-array consumers that
// want one buffer, see `arrow.concat`.
class ConcatColumn extends Column {
  #parts: Column[];
  #cumLengths: number[];

  constructor(type: DataType, parts: Column[]) {
    let total = 0;
    const cum: number[] = [0];
    for (const p of parts) {
      total += p.length;
      cum.push(total);
    }
    // ConcatColumn doesn't materialize values — `get()` overrides routing.
    super(type, total, [] as string[]);
    this.#parts = parts;
    this.#cumLengths = cum;
  }

  override get(i: number): number | bigint | boolean | string | null {
    if (i < 0 || i >= this.length) {
      throw new RangeError(`@para/arrow ConcatColumn.get: index ${i} out of range [0, ${this.length})`);
    }
    // Binary search for the part. parts.length is small (~tens) in practice
    // so a linear scan is fine; binary search not necessary.
    for (let p = 0; p < this.#parts.length; p++) {
      if (i < this.#cumLengths[p + 1]) {
        return this.#parts[p].get(i - this.#cumLengths[p]);
      }
    }
    /* unreachable */ throw new Error("@para/arrow ConcatColumn: unreachable");
  }
}

// ─── Builders ──────────────────────────────────────────────────────────────

type ColumnInput =
  | Int32Array
  | BigInt64Array
  | Float32Array
  | Float64Array
  | Uint8Array
  | boolean[]
  | string[]
  | number[] // numbers default to Float64Array
  | unknown[][]; // arrays of arrays → list<T> (child type inferred from flattened first non-empty row)

function inferColumn(name: string, input: ColumnInput): { field: Field; column: Column } {
  if (input instanceof Int32Array) {
    return {
      field: { name, type: { kind: "int32" }, nullable: false },
      column: new Column({ kind: "int32" }, input.length, input),
    };
  }
  if (input instanceof BigInt64Array) {
    return {
      field: { name, type: { kind: "int64" }, nullable: false },
      column: new Column({ kind: "int64" }, input.length, input),
    };
  }
  if (input instanceof Float32Array) {
    return {
      field: { name, type: { kind: "float32" }, nullable: false },
      column: new Column({ kind: "float32" }, input.length, input),
    };
  }
  if (input instanceof Float64Array) {
    return {
      field: { name, type: { kind: "float64" }, nullable: false },
      column: new Column({ kind: "float64" }, input.length, input),
    };
  }
  if (input instanceof Uint8Array) {
    // Uint8Array as bool — values must already be 0 or 1.
    return {
      field: { name, type: { kind: "bool" }, nullable: false },
      column: new Column({ kind: "bool" }, input.length, input),
    };
  }
  if (Array.isArray(input)) {
    if (input.length === 0) {
      // Empty arrays default to float64 — caller can override by passing a
      // typed array if they need a different shape.
      return {
        field: { name, type: { kind: "float64" }, nullable: false },
        column: new Column({ kind: "float64" }, 0, new Float64Array(0)),
      };
    }
    const sample = input[0];
    if (typeof sample === "number") {
      const arr = new Float64Array(input as number[]);
      return {
        field: { name, type: { kind: "float64" }, nullable: false },
        column: new Column({ kind: "float64" }, arr.length, arr),
      };
    }
    if (typeof sample === "boolean") {
      const arr = new Uint8Array(input.length);
      for (let i = 0; i < input.length; i++) arr[i] = (input[i] as boolean) ? 1 : 0;
      return {
        field: { name, type: { kind: "bool" }, nullable: false },
        column: new Column({ kind: "bool" }, input.length, arr),
      };
    }
    if (typeof sample === "string") {
      return {
        field: { name, type: { kind: "utf8" }, nullable: false },
        column: new Column({ kind: "utf8" }, input.length, input as string[]),
      };
    }
    // Array-of-arrays → list<T>. Flatten all elements into a single child
    // input, infer the child column from that flattened view, build offsets
    // describing per-row list lengths.
    if (Array.isArray(sample)) {
      const rows = input as unknown[][];
      const offsets = new Int32Array(rows.length + 1);
      let total = 0;
      for (let i = 0; i < rows.length; i++) {
        offsets[i] = total;
        total += rows[i].length;
      }
      offsets[rows.length] = total;

      // Find first non-empty row to infer child type from.
      let flat: unknown[] | null = null;
      for (const row of rows) {
        if (row.length > 0) {
          flat = [];
          for (const r of rows) for (const v of r) flat.push(v);
          break;
        }
      }
      // All-empty: default child to float64 (caller can pass a typed array
      // for the child type by wrapping in a fully-typed Column manually if
      // they care).
      const childInferred =
        flat !== null
          ? inferColumn("__child", flat as ColumnInput)
          : {
              field: { name: "__child", type: { kind: "float64" } as DataType, nullable: false },
              column: new Column({ kind: "float64" }, 0, new Float64Array(0)),
            };
      const listType: DataType = { kind: "list", child: childInferred.field.type };
      return {
        field: { name, type: listType, nullable: false },
        column: new Column(listType, rows.length, offsets, undefined, childInferred.column),
      };
    }
  }
  throw new TypeError(
    `@para/arrow.recordBatch: column ${JSON.stringify(name)} has unsupported value type — pass a typed array, string[], boolean[], or number[]`,
  );
}

/**
 * Build a RecordBatch from a column-name → column-values map. Column types
 * are inferred from each value: typed arrays keep their type, `number[]`
 * promotes to Float64, `boolean[]` to Bool, `string[]` to Utf8.
 *
 * All columns must have the same length — otherwise this throws.
 */
function recordBatch(columns: Record<string, ColumnInput>): RecordBatch {
  const fields: Field[] = [];
  const cols: Column[] = [];
  let length = -1;
  for (const [name, input] of Object.entries(columns)) {
    const { field, column } = inferColumn(name, input);
    if (length < 0) length = column.length;
    else if (column.length !== length) {
      throw new RangeError(
        `@para/arrow.recordBatch: column lengths must match — ${JSON.stringify(name)} has ${column.length}, expected ${length}`,
      );
    }
    fields.push(field);
    cols.push(column);
  }
  if (length < 0) length = 0;
  return new RecordBatch({ fields }, cols, length);
}

/**
 * Concatenate a sequence of RecordBatches. All batches must share the same
 * schema (compared by field name + type kind, not nullable bit).
 */
function table(batches: RecordBatch[]): Table {
  if (batches.length === 0) {
    throw new RangeError("@para/arrow.table: must pass at least one RecordBatch");
  }
  const schema = batches[0].schema;
  for (let b = 1; b < batches.length; b++) {
    const other = batches[b].schema;
    if (other.fields.length !== schema.fields.length) {
      throw new RangeError("@para/arrow.table: schemas must match across batches");
    }
    for (let f = 0; f < schema.fields.length; f++) {
      if (other.fields[f].name !== schema.fields[f].name || other.fields[f].type.kind !== schema.fields[f].type.kind) {
        throw new RangeError(
          `@para/arrow.table: schemas differ at field ${f} (${schema.fields[f].name}: ${schema.fields[f].type.kind} vs ${other.fields[f].name}: ${other.fields[f].type.kind})`,
        );
      }
    }
  }
  return new Table(schema, batches);
}

// ─── Row-major ↔ columnar bridge ───────────────────────────────────────────
//
// JS data lives row-major (each object is one record); columnar formats live
// column-major (each array is one column across every record). Converting
// between the two is the seam between @para/csv (yields rows) and @para/arrow
// (works on columns). The seam can't live inside either module — bun:* can't
// cross-import bun:* — so it lives at the call site, with these helpers
// taking the boilerplate.

type RowSchema = Partial<Record<string, ArrowKind>>;

type FromRowsOptions = {
  /**
   * Override the auto-inferred type for one or more columns. Inference
   * picks `int32` for whole numbers in [-2³¹, 2³¹), `float64` for other
   * numbers, `bool` for booleans, and `utf8` for strings. Pass entries
   * here to widen ints to int64 (large values), narrow floats to float32,
   * etc. Columns not listed are inferred as usual.
   */
  schema?: RowSchema;
  /** Drop rows where any required field is null/undefined. Default false. */
  skipNulls?: boolean;
};

function inferKindFromValue(v: unknown): ArrowKind | null {
  if (typeof v === "number") {
    return Number.isInteger(v) && v >= -2147483648 && v < 2147483648 ? "int32" : "float64";
  }
  if (typeof v === "bigint") return "int64";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "string") return "utf8";
  return null;
}

/**
 * Build a RecordBatch from an array of plain JS objects. Column types are
 * inferred from the first non-null value seen for each column, or pinned
 * via `opts.schema`. Missing fields produce nulls in the validity bitmap.
 *
 *   const rows = [
 *     { name: "alice", age: 30, score: 0.95 },
 *     { name: "bob",   age: 25, score: 0.82 },
 *   ];
 *   const batch = arrow.fromRows(rows);
 *   arrow.sum(batch.column("age"));     // 55
 *
 * Pairs with @para/csv at the call site:
 *
 *   const rows = [];
 *   for await (const row of csv.parseCsv(file, { header: true, infer: true })) rows.push(row);
 *   const batch = arrow.fromRows(rows);
 */
function fromRows<T extends Record<string, any>>(rows: T[], opts: FromRowsOptions = {}): RecordBatch {
  if (!Array.isArray(rows)) {
    throw new TypeError("@para/arrow.fromRows: rows must be an array");
  }
  // Collect every column name across rows (rows can have ragged keysets).
  const colNames: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row == null || typeof row !== "object") continue;
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        colNames.push(key);
      }
    }
  }

  // Resolve per-column types: explicit schema first, else infer from first
  // non-null value seen.
  const kinds: Record<string, ArrowKind> = {};
  for (const name of colNames) {
    const pinned = opts.schema?.[name];
    if (pinned) {
      kinds[name] = pinned;
      continue;
    }
    let inferred: ArrowKind | null = null;
    for (const row of rows) {
      if (row == null) continue;
      const v = row[name];
      if (v == null) continue;
      inferred = inferKindFromValue(v);
      if (inferred) break;
    }
    // If every row is null/missing for this column, default to utf8 (the
    // most permissive type — the column will be all-null anyway).
    kinds[name] = inferred ?? "utf8";
  }

  // Filter rows if requested.
  const useRows = opts.skipNulls
    ? rows.filter(row => {
        if (row == null) return false;
        for (const name of colNames) {
          const v = (row as any)[name];
          if (v == null) return false;
        }
        return true;
      })
    : rows;
  const n = useRows.length;

  // Allocate per-column storage.
  const fields: Field[] = [];
  const cols: Column[] = [];
  for (const name of colNames) {
    const kind = kinds[name];
    let values: ColumnValues;
    let validity: Uint8Array | undefined;
    let hasNull = false;

    switch (kind) {
      case "int32": {
        const arr = new Int32Array(n);
        const v = new Uint8Array(Math.ceil(n / 8));
        for (let i = 0; i < n; i++) {
          const row = useRows[i];
          const raw = row == null ? undefined : (row as any)[name];
          if (raw == null) {
            hasNull = true;
          } else {
            arr[i] = Number(raw) | 0;
            v[i >> 3] |= 1 << (i & 7);
          }
        }
        values = arr;
        validity = hasNull ? v : undefined;
        break;
      }
      case "int64": {
        const arr = new BigInt64Array(n);
        const v = new Uint8Array(Math.ceil(n / 8));
        for (let i = 0; i < n; i++) {
          const row = useRows[i];
          const raw = row == null ? undefined : (row as any)[name];
          if (raw == null) {
            hasNull = true;
          } else {
            arr[i] = typeof raw === "bigint" ? raw : BigInt(raw);
            v[i >> 3] |= 1 << (i & 7);
          }
        }
        values = arr;
        validity = hasNull ? v : undefined;
        break;
      }
      case "float32":
      case "float64": {
        const arr = kind === "float32" ? new Float32Array(n) : new Float64Array(n);
        const v = new Uint8Array(Math.ceil(n / 8));
        for (let i = 0; i < n; i++) {
          const row = useRows[i];
          const raw = row == null ? undefined : (row as any)[name];
          if (raw == null) {
            hasNull = true;
          } else {
            arr[i] = Number(raw);
            v[i >> 3] |= 1 << (i & 7);
          }
        }
        values = arr;
        validity = hasNull ? v : undefined;
        break;
      }
      case "bool": {
        const arr = new Uint8Array(n);
        const v = new Uint8Array(Math.ceil(n / 8));
        for (let i = 0; i < n; i++) {
          const row = useRows[i];
          const raw = row == null ? undefined : (row as any)[name];
          if (raw == null) {
            hasNull = true;
          } else {
            arr[i] = raw ? 1 : 0;
            v[i >> 3] |= 1 << (i & 7);
          }
        }
        values = arr;
        validity = hasNull ? v : undefined;
        break;
      }
      case "utf8": {
        const arr: string[] = new Array(n);
        const v = new Uint8Array(Math.ceil(n / 8));
        for (let i = 0; i < n; i++) {
          const row = useRows[i];
          const raw = row == null ? undefined : (row as any)[name];
          if (raw == null) {
            hasNull = true;
            arr[i] = "";
          } else {
            arr[i] = String(raw);
            v[i >> 3] |= 1 << (i & 7);
          }
        }
        values = arr;
        validity = hasNull ? v : undefined;
        break;
      }
    }

    fields.push({ name, type: { kind }, nullable: hasNull });
    cols.push(new Column({ kind }, n, values, validity));
  }

  return new RecordBatch({ fields }, cols, n);
}

/**
 * The reverse — turn a RecordBatch (or Table) back into an array of plain JS
 * objects. Useful for handing data to row-shaped consumers (`fetch` JSON
 * payload, ORM `insertMany`, etc.) after a columnar pipeline. Null rows
 * become `null` for the field.
 */
function toRows(source: RecordBatch | Table): Array<Record<string, number | bigint | boolean | string | null>> {
  if (source instanceof Table) {
    const out: Array<Record<string, number | bigint | boolean | string | null>> = [];
    for (const batch of source.batches) {
      for (let i = 0; i < batch.numRows; i++) out.push(batch.row(i));
    }
    return out;
  }
  const out: Array<Record<string, number | bigint | boolean | string | null>> = new Array(source.numRows);
  for (let i = 0; i < source.numRows; i++) out[i] = source.row(i);
  return out;
}

// ─── Computes ──────────────────────────────────────────────────────────────

function isNumeric(t: DataType): boolean {
  return t.kind === "int32" || t.kind === "int64" || t.kind === "float32" || t.kind === "float64";
}

function requireNumeric(col: Column, op: string): void {
  if (!isNumeric(col.type)) {
    throw new TypeError(`@para/arrow.${op}: column type ${col.type.kind} is not numeric`);
  }
}

/**
 * Sum a numeric column (int32 / int64 / float32 / float64). Honors validity
 * bitmap — null rows are skipped. Returns a `bigint` for int64 columns and
 * a `number` for the others.
 */
function sum(col: Column): number | bigint {
  requireNumeric(col, "sum");
  if (col.type.kind === "int64") {
    let acc = 0n;
    if (col instanceof ConcatColumn) {
      for (let i = 0; i < col.length; i++) {
        const v = col.get(i);
        if (v != null) acc += v as bigint;
      }
      return acc;
    }
    const v = col.values as BigInt64Array;
    if (col.validity) {
      for (let i = 0; i < col.length; i++) {
        if ((col.validity[i >> 3] >> (i & 7)) & 1) acc += v[i];
      }
    } else {
      for (let i = 0; i < col.length; i++) acc += v[i];
    }
    return acc;
  }
  let acc = 0;
  if (col instanceof ConcatColumn) {
    for (let i = 0; i < col.length; i++) {
      const v = col.get(i);
      if (v != null) acc += v as number;
    }
    return acc;
  }
  const v = col.values as Int32Array | Float32Array | Float64Array;
  if (col.validity) {
    for (let i = 0; i < col.length; i++) {
      if ((col.validity[i >> 3] >> (i & 7)) & 1) acc += v[i];
    }
  } else {
    for (let i = 0; i < col.length; i++) acc += v[i];
  }
  return acc;
}

/**
 * Arithmetic mean of a numeric column. Empty / all-null inputs return NaN.
 * Always returns `number` (int64 columns are widened to f64 for the divide).
 */
function mean(col: Column): number {
  requireNumeric(col, "mean");
  let acc = 0;
  let count = 0;
  for (let i = 0; i < col.length; i++) {
    const v = col.get(i);
    if (v == null) continue;
    acc += typeof v === "bigint" ? Number(v) : (v as number);
    count++;
  }
  return count === 0 ? NaN : acc / count;
}

/**
 * Min / max over a numeric column. NaN propagates (matching JS Math.min /
 * Math.max). Null rows are skipped. Empty / all-null inputs return +Inf for
 * min, -Inf for max — same conventions as parabun:gpu.reduce.
 */
function min(col: Column): number | bigint {
  requireNumeric(col, "min");
  if (col.type.kind === "int64") {
    let m: bigint | null = null;
    for (let i = 0; i < col.length; i++) {
      const v = col.get(i) as bigint | null;
      if (v == null) continue;
      if (m === null || v < m) m = v;
    }
    return m === null ? 0n : m;
  }
  let m = Infinity;
  for (let i = 0; i < col.length; i++) {
    const v = col.get(i) as number | null;
    if (v == null) continue;
    if (Number.isNaN(v)) return NaN;
    if (v < m) m = v;
  }
  return m;
}

function max(col: Column): number | bigint {
  requireNumeric(col, "max");
  if (col.type.kind === "int64") {
    let m: bigint | null = null;
    for (let i = 0; i < col.length; i++) {
      const v = col.get(i) as bigint | null;
      if (v == null) continue;
      if (m === null || v > m) m = v;
    }
    return m === null ? 0n : m;
  }
  let m = -Infinity;
  for (let i = 0; i < col.length; i++) {
    const v = col.get(i) as number | null;
    if (v == null) continue;
    if (Number.isNaN(v)) return NaN;
    if (v > m) m = v;
  }
  return m;
}

/**
 * Row index of the minimum value in a numeric column. Skips null rows;
 * NaN propagates (returns NaN — matches `parabun:gpu.reduce("min")`'s NaN
 * semantics, just with the index reported in the value's place). Empty
 * or all-null columns throw — there's no meaningful argmin.
 *
 * Tie-break: first occurrence wins (lower index when values are equal).
 */
function argMin(col: Column): number {
  requireNumeric(col, "argMin");
  let bestIdx = -1;
  if (col.type.kind === "int64") {
    let bestV: bigint | null = null;
    for (let i = 0; i < col.length; i++) {
      const v = col.get(i) as bigint | null;
      if (v == null) continue;
      if (bestV === null || v < bestV) {
        bestV = v;
        bestIdx = i;
      }
    }
  } else {
    let bestV = Infinity;
    for (let i = 0; i < col.length; i++) {
      const v = col.get(i) as number | null;
      if (v == null) continue;
      if (Number.isNaN(v)) return NaN;
      if (v < bestV) {
        bestV = v;
        bestIdx = i;
      }
    }
  }
  if (bestIdx < 0) {
    throw new RangeError("@para/arrow.argMin: column is empty or all-null");
  }
  return bestIdx;
}

/**
 * Row index of the maximum value. Same conventions as argMin (skip nulls,
 * NaN propagates, first-occurrence tie-break, throws on empty/all-null).
 */
function argMax(col: Column): number {
  requireNumeric(col, "argMax");
  let bestIdx = -1;
  if (col.type.kind === "int64") {
    let bestV: bigint | null = null;
    for (let i = 0; i < col.length; i++) {
      const v = col.get(i) as bigint | null;
      if (v == null) continue;
      if (bestV === null || v > bestV) {
        bestV = v;
        bestIdx = i;
      }
    }
  } else {
    let bestV = -Infinity;
    for (let i = 0; i < col.length; i++) {
      const v = col.get(i) as number | null;
      if (v == null) continue;
      if (Number.isNaN(v)) return NaN;
      if (v > bestV) {
        bestV = v;
        bestIdx = i;
      }
    }
  }
  if (bestIdx < 0) {
    throw new RangeError("@para/arrow.argMax: column is empty or all-null");
  }
  return bestIdx;
}

/**
 * Count rows in a column or a whole record batch / table. By default counts
 * non-null rows; pass `{ all: true }` to count every row regardless of
 * nullity.
 */
function count(target: Column | RecordBatch | Table, opts: { all?: boolean } = {}): number {
  if (target instanceof RecordBatch) return target.numRows;
  if (target instanceof Table) return target.numRows;
  // Column
  if (opts.all || !target.validity) return target.length;
  let c = 0;
  for (let i = 0; i < target.length; i++) {
    if ((target.validity[i >> 3] >> (i & 7)) & 1) c++;
  }
  return c;
}

/**
 * Filter a RecordBatch — keeps rows where `predicate(row, i)` returns truthy.
 * Materializes the predicate's row-as-object for ergonomic predicates; for
 * high-throughput cases write a column-major filter manually instead.
 */
function filter(batch: RecordBatch, predicate: (row: Record<string, any>, index: number) => boolean): RecordBatch {
  const keepIdx: number[] = [];
  for (let i = 0; i < batch.numRows; i++) {
    if (predicate(batch.row(i), i)) keepIdx.push(i);
  }
  return gatherIndices(batch, keepIdx);
}

function sliceValidity(src: Uint8Array | undefined, keepIdx: number[]): Uint8Array | undefined {
  if (!src) return undefined;
  const out = new Uint8Array(Math.ceil(keepIdx.length / 8));
  for (let i = 0; i < keepIdx.length; i++) {
    const srcBit = (src[keepIdx[i] >> 3] >> (keepIdx[i] & 7)) & 1;
    if (srcBit) out[i >> 3] |= 1 << (i & 7);
  }
  return out;
}

/**
 * Materialize a column (typically from a Table's `ConcatColumn` view) into a
 * single contiguous typed array. Numeric columns produce the matching typed
 * array; utf8 produces a fresh `string[]`; bool produces a `Uint8Array` of
 * 0/1 values. Throws on null-bearing columns — callers handle nulls
 * explicitly when they materialize.
 */
function concat(col: Column): ColumnValues {
  if (col.validity) {
    throw new TypeError("@para/arrow.concat: column has nulls — handle them explicitly before materializing");
  }
  switch (col.type.kind) {
    case "int32": {
      const out = new Int32Array(col.length);
      for (let i = 0; i < col.length; i++) out[i] = col.get(i) as number;
      return out;
    }
    case "int64": {
      const out = new BigInt64Array(col.length);
      for (let i = 0; i < col.length; i++) out[i] = col.get(i) as bigint;
      return out;
    }
    case "float32": {
      const out = new Float32Array(col.length);
      for (let i = 0; i < col.length; i++) out[i] = col.get(i) as number;
      return out;
    }
    case "float64": {
      const out = new Float64Array(col.length);
      for (let i = 0; i < col.length; i++) out[i] = col.get(i) as number;
      return out;
    }
    case "bool": {
      const out = new Uint8Array(col.length);
      for (let i = 0; i < col.length; i++) out[i] = (col.get(i) as boolean) ? 1 : 0;
      return out;
    }
    case "utf8": {
      const out: string[] = new Array(col.length);
      for (let i = 0; i < col.length; i++) out[i] = col.get(i) as string;
      return out;
    }
    case "list": {
      // Concatenated form for list columns is the array of arrays per row.
      // For materializing the underlying child buffer, callers can grab
      // `col.child.values` directly.
      throw new TypeError(
        "@para/arrow.concat: list columns aren't a flat-typed-array shape — access col.child.values directly, or use col.get(i) per row",
      );
    }
  }
}

// ─── Statistics: variance / stddev / quantile ─────────────────────────────

type VarianceOptions = {
  /**
   * Delta degrees of freedom. Divisor is `n - ddof`.
   *   `0` (default) — population variance, what numpy returns by default.
   *   `1`           — sample variance (Bessel-corrected, unbiased).
   * Values >= n return NaN.
   */
  ddof?: number;
};

/**
 * Population variance (or sample with `{ ddof: 1 }`). Two-pass — Kahan-
 * compensated mean, then sum of squared deviations. Null rows are skipped.
 * int64 columns widen to f64 internally for the divide.
 */
function variance(col: Column, opts: VarianceOptions = {}): number {
  requireNumeric(col, "variance");
  const ddof = opts.ddof ?? 0;
  if (typeof ddof !== "number" || !Number.isFinite(ddof) || ddof < 0) {
    throw new RangeError(`@para/arrow.variance: ddof must be a finite non-negative number; got ${ddof}`);
  }
  // Pass 1: count + Kahan mean.
  let mean = 0;
  let c = 0;
  let n = 0;
  for (let i = 0; i < col.length; i++) {
    const v = col.get(i);
    if (v == null) continue;
    const num = typeof v === "bigint" ? Number(v) : (v as number);
    n++;
    // Welford-style online mean would also work; Kahan is the reference here.
    const y = num - c;
    const t = mean + y;
    c = t - mean - y;
    mean = t;
  }
  if (n === 0 || ddof >= n) return NaN;
  mean = mean / n;
  // Pass 2: sum of squared deviations.
  let sumSq = 0;
  for (let i = 0; i < col.length; i++) {
    const v = col.get(i);
    if (v == null) continue;
    const num = typeof v === "bigint" ? Number(v) : (v as number);
    const d = num - mean;
    sumSq += d * d;
  }
  return sumSq / (n - ddof);
}

/**
 * Standard deviation = sqrt(variance(col, opts)). Same nullity / ddof rules.
 */
function stddev(col: Column, opts: VarianceOptions = {}): number {
  return Math.sqrt(variance(col, opts));
}

/**
 * Quantile (linear interpolation between adjacent ordered samples). `q` in
 * [0, 1]; q=0.5 is the median, q=0.95 is the 95th percentile. NaN
 * propagates — any NaN in the column produces NaN. Null rows are skipped.
 */
function quantile(col: Column, q: number): number {
  requireNumeric(col, "quantile");
  if (typeof q !== "number" || q < 0 || q > 1) {
    throw new RangeError(`@para/arrow.quantile: q must be a number in [0, 1]; got ${q}`);
  }
  // Materialize non-null values into a typed array for sorting. Use Float64
  // regardless of source type for numerical comparison — int64 widens, the
  // ordering is preserved within the safe-integer range that anyone calling
  // quantile actually cares about.
  const values: number[] = [];
  for (let i = 0; i < col.length; i++) {
    const v = col.get(i);
    if (v == null) continue;
    const num = typeof v === "bigint" ? Number(v) : (v as number);
    if (Number.isNaN(num)) return NaN;
    values.push(num);
  }
  if (values.length === 0) return NaN;
  values.sort((a, b) => a - b);
  if (values.length === 1) return values[0];
  const pos = q * (values.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return values[lo];
  const frac = pos - lo;
  return values[lo] * (1 - frac) + values[hi] * frac;
}

/**
 * Median = quantile(col, 0.5).
 */
function median(col: Column): number {
  return quantile(col, 0.5);
}

// ─── Distinct + groupBy ────────────────────────────────────────────────────

/**
 * Unique values from a column, preserving first-occurrence order. Returns
 * a JS array — for small cardinality columns this is the right shape.
 * Null rows are skipped. Bigint columns return bigint values; bool returns
 * booleans; numeric types return numbers; utf8 returns strings.
 */
function distinct(col: Column): Array<number | bigint | boolean | string> {
  const seen = new Set<number | bigint | boolean | string>();
  const out: Array<number | bigint | boolean | string> = [];
  for (let i = 0; i < col.length; i++) {
    const v = col.get(i);
    if (v == null) continue;
    if (!seen.has(v as any)) {
      seen.add(v as any);
      out.push(v as any);
    }
  }
  return out;
}

type GroupResult = Map<string | number | bigint | boolean, RecordBatch>;

/**
 * Partition a RecordBatch by the values of one column. Returns a Map keyed
 * by the group value; each entry is a RecordBatch containing the rows that
 * shared that key. Null group values land under the `null` key (stored as
 * the string "null" since Map keys can't sort by null cleanly).
 *
 *   const byCategory = arrow.groupBy(batch, "category");
 *   for (const [key, group] of byCategory) {
 *     console.log(`${key}: ${arrow.sum(group.column("score"))}`);
 *   }
 */
function groupBy(batch: RecordBatch, columnName: string): GroupResult {
  const keyCol = batch.column(columnName);
  // Collect indices per group key in one pass over the batch.
  const byKey = new Map<any, number[]>();
  for (let i = 0; i < batch.numRows; i++) {
    const k = keyCol.get(i);
    const norm = k == null ? null : k;
    let bucket = byKey.get(norm);
    if (!bucket) {
      bucket = [];
      byKey.set(norm, bucket);
    }
    bucket.push(i);
  }
  // Build each group's RecordBatch by gathering the column data at the
  // index list — single pass per column per group, no rescan of the
  // full batch.
  const result: GroupResult = new Map();
  for (const [key, idx] of byKey) {
    result.set(key, gatherIndices(batch, idx));
  }
  return result;
}

// Build a new RecordBatch from the rows of `batch` at positions `idx`.
// Used by groupBy and available as a building block for any other
// index-driven slice.
function gatherIndices(batch: RecordBatch, idx: number[]): RecordBatch {
  const cols: Column[] = batch.columns.map(col => {
    const t = col.type.kind;
    const validity = sliceValidity(col.validity, idx);
    if (t === "int32") {
      const dst = new Int32Array(idx.length);
      const src = col.values as Int32Array;
      for (let i = 0; i < idx.length; i++) dst[i] = src[idx[i]];
      return new Column(col.type, idx.length, dst, validity);
    }
    if (t === "int64") {
      const dst = new BigInt64Array(idx.length);
      const src = col.values as BigInt64Array;
      for (let i = 0; i < idx.length; i++) dst[i] = src[idx[i]];
      return new Column(col.type, idx.length, dst, validity);
    }
    if (t === "float32") {
      const dst = new Float32Array(idx.length);
      const src = col.values as Float32Array;
      for (let i = 0; i < idx.length; i++) dst[i] = src[idx[i]];
      return new Column(col.type, idx.length, dst, validity);
    }
    if (t === "float64") {
      const dst = new Float64Array(idx.length);
      const src = col.values as Float64Array;
      for (let i = 0; i < idx.length; i++) dst[i] = src[idx[i]];
      return new Column(col.type, idx.length, dst, validity);
    }
    if (t === "bool") {
      const dst = new Uint8Array(idx.length);
      const src = col.values as Uint8Array;
      for (let i = 0; i < idx.length; i++) dst[i] = src[idx[i]];
      return new Column(col.type, idx.length, dst, validity);
    }
    if (t === "utf8") {
      const src = col.values as string[];
      const dst: string[] = new Array(idx.length);
      for (let i = 0; i < idx.length; i++) dst[i] = src[idx[i]];
      return new Column(col.type, idx.length, dst, validity);
    }
    // list: rebuild offsets so they reference the new dense child slice,
    // and gather only the child-row range each kept parent row points at.
    // Two passes: first compute new total length and per-row offsets, then
    // build a fresh child column out of the gathered child indices.
    const srcOffsets = col.values as Int32Array;
    const dstOffsets = new Int32Array(idx.length + 1);
    const childIdx: number[] = [];
    let total = 0;
    for (let i = 0; i < idx.length; i++) {
      dstOffsets[i] = total;
      const start = srcOffsets[idx[i]];
      const end = srcOffsets[idx[i] + 1];
      for (let k = start; k < end; k++) childIdx.push(k);
      total += end - start;
    }
    dstOffsets[idx.length] = total;
    // Use a synthetic single-column RecordBatch to recurse through gather.
    // This handles arbitrarily-nested list-of-list-of-... types.
    const childGathered = gatherIndices(
      new RecordBatch(
        { fields: [{ name: "__child", type: col.child!.type, nullable: !!col.child!.validity }] },
        [col.child!],
        col.child!.length,
      ),
      childIdx,
    ).columns[0];
    return new Column(col.type, idx.length, dstOffsets, validity, childGathered);
  });
  return new RecordBatch(batch.schema, cols, idx.length);
}

// ─── sort / cumsum / diff ──────────────────────────────────────────────────

type SortOptions = {
  /** Sort descending instead of ascending. Default false. */
  descending?: boolean;
  /** Place null rows at the start instead of the end. Default false (nulls last). */
  nullsFirst?: boolean;
};

/**
 * Sort a RecordBatch by the values of one column. Returns a new RecordBatch
 * with rows permuted; every column is gathered through the same index
 * permutation so cross-column row alignment is preserved.
 *
 * Uses Array.prototype.sort with a comparator — V8/JSC's sort is TimSort,
 * which is stable. Equal keys retain their original relative order, so
 * sorting by one column and then another gives the expected lexicographic
 * result.
 *
 *   const byScoreDesc = arrow.sort(batch, "score", { descending: true });
 */
function sort(batch: RecordBatch, columnName: string, opts: SortOptions = {}): RecordBatch {
  const keyCol = batch.column(columnName);
  const descending = opts.descending === true;
  const nullsFirst = opts.nullsFirst === true;

  const n = batch.numRows;
  const idx = new Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;

  // Comparator returns negative if a should come before b.
  // Null handling is independent of the descending flag — nullsFirst always
  // means "nulls at output[0..]" regardless of direction.
  idx.sort((a: number, b: number) => {
    const va = keyCol.get(a);
    const vb = keyCol.get(b);
    if (va === null && vb === null) return 0;
    if (va === null) return nullsFirst ? -1 : 1;
    if (vb === null) return nullsFirst ? 1 : -1;
    let cmp: number;
    if (typeof va === "bigint" && typeof vb === "bigint") {
      cmp = va < vb ? -1 : va > vb ? 1 : 0;
    } else if (typeof va === "string" && typeof vb === "string") {
      cmp = va < vb ? -1 : va > vb ? 1 : 0;
    } else if (typeof va === "boolean" && typeof vb === "boolean") {
      cmp = va === vb ? 0 : va ? 1 : -1;
    } else {
      const na = va as number;
      const nb = vb as number;
      cmp = na < nb ? -1 : na > nb ? 1 : 0;
    }
    return descending ? -cmp : cmp;
  });

  return gatherIndices(batch, idx);
}

/**
 * Inclusive prefix sum (running total) of a numeric column. Returns a new
 * column of the same type, length, and nullity. Null rows preserve the
 * running total of preceding non-null rows (i.e. they hold whatever the
 * accumulator was when the null was encountered, but are still flagged as
 * null in the validity bitmap).
 *
 * For Float64 / Float32 columns the accumulator is Kahan-compensated.
 * int32 keeps a number accumulator; int64 uses bigint.
 */
function cumsum(col: Column): Column {
  requireNumeric(col, "cumsum");
  const n = col.length;
  const validity = col.validity ? new Uint8Array(col.validity) : undefined;

  if (col.type.kind === "int64") {
    const out = new BigInt64Array(n);
    let acc = 0n;
    for (let i = 0; i < n; i++) {
      const v = col.get(i) as bigint | null;
      if (v != null) acc += v;
      out[i] = acc;
    }
    return new Column({ kind: "int64" }, n, out, validity);
  }

  // Numeric: Kahan-compensated for f32/f64, plain for int32 (exact within
  // safe-integer range).
  const useKahan = col.type.kind === "float32" || col.type.kind === "float64";
  const Out = col.type.kind === "int32" ? Int32Array : col.type.kind === "float32" ? Float32Array : Float64Array;
  const out = new Out(n);
  let acc = 0;
  let c = 0;
  for (let i = 0; i < n; i++) {
    const v = col.get(i) as number | null;
    if (v != null) {
      if (useKahan) {
        const y = v - c;
        const t = acc + y;
        c = t - acc - y;
        acc = t;
      } else {
        acc += v;
      }
    }
    out[i] = acc;
  }
  return new Column(col.type, n, out, validity);
}

/**
 * First differences (out[i] = col[i] - col[i-1]). The first row is set to
 * null in the output regardless of input nullity — there's no prior row to
 * subtract from. Subsequent null rows propagate to null in the output.
 */
function diff(col: Column): Column {
  requireNumeric(col, "diff");
  const n = col.length;
  // Always emit a validity bitmap — at minimum row 0 is null.
  const validity = new Uint8Array(Math.ceil(n / 8));
  const inputValid = col.validity;

  if (col.type.kind === "int64") {
    const out = new BigInt64Array(n);
    for (let i = 1; i < n; i++) {
      const a = col.get(i) as bigint | null;
      const b = col.get(i - 1) as bigint | null;
      if (a == null || b == null) continue;
      out[i] = a - b;
      validity[i >> 3] |= 1 << (i & 7);
    }
    return new Column({ kind: "int64" }, n, out, validity);
  }

  const Out = col.type.kind === "int32" ? Int32Array : col.type.kind === "float32" ? Float32Array : Float64Array;
  const out = new Out(n);
  for (let i = 1; i < n; i++) {
    const a = col.get(i) as number | null;
    const b = col.get(i - 1) as number | null;
    if (a == null || b == null) continue;
    out[i] = a - b;
    validity[i >> 3] |= 1 << (i & 7);
  }
  // Avoid an unused-binding warning on inputValid; the per-row col.get()
  // already consults the input validity bitmap, so this var only serves
  // as a documented hook for future fast-path branching.
  void inputValid;
  return new Column(col.type, n, out, validity);
}

// ─── IPC reader / writer ───────────────────────────────────────────────────
// Streaming format only (continuation-prefixed Schema + RecordBatch
// messages, no file footer, no dictionary batches). See `./arrow/ipc.ts`
// for the FlatBuffers builder/reader and the Schema/RecordBatch encoders.

const ipc = require("./arrow/ipc.ts");
ipc.setArrowTypes({ Column, RecordBatch, Table });
const parquet = require("./arrow/parquet.ts");
parquet.setArrowTypes({ Column, RecordBatch, Table });

function fromIPC(bytes: Uint8Array): Table {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("@para/arrow.fromIPC: bytes must be a Uint8Array");
  }
  return ipc.fromIPC(bytes) as Table;
}

function toIPC(source: Table | RecordBatch, format: "stream" | "file" = "stream"): Uint8Array {
  if (!(source instanceof Table) && !(source instanceof RecordBatch)) {
    throw new TypeError("@para/arrow.toIPC: source must be a Table or RecordBatch");
  }
  if (format !== "stream" && format !== "file") {
    throw new TypeError(`@para/arrow.toIPC: format must be "stream" or "file", got ${format}`);
  }
  return ipc.toIPC(source, format) as Uint8Array;
}

function fromParquet(bytes: Uint8Array): Table {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("@para/arrow.fromParquet: bytes must be a Uint8Array");
  }
  return parquet.fromParquet(bytes) as Table;
}

function toParquet(
  source: Table | RecordBatch,
  opts?: { compression?: "uncompressed" | "snappy" | "gzip" },
): Uint8Array {
  if (!(source instanceof Table) && !(source instanceof RecordBatch)) {
    throw new TypeError("@para/arrow.toParquet: source must be a Table or RecordBatch");
  }
  return parquet.toParquet(source, opts) as Uint8Array;
}

export default {
  // Types
  RecordBatch,
  Table,
  Column,
  // Builders
  recordBatch,
  table,
  fromRows,
  toRows,
  // Computes
  sum,
  mean,
  min,
  max,
  argMin,
  argMax,
  count,
  variance,
  stddev,
  quantile,
  median,
  distinct,
  filter,
  groupBy,
  sort,
  cumsum,
  diff,
  concat,
  // I/O
  fromIPC,
  toIPC,
  fromParquet,
  toParquet,
};
