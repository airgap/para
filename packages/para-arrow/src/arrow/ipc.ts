// Arrow IPC stream reader + writer for @para/arrow.
//
// Implements just enough of the Arrow IPC format spec to round-trip the six
// types @para/arrow currently models — int32, int64, float32, float64, bool,
// utf8 — via the *streaming* IPC format (continuation-prefixed messages,
// no file footer, no dictionary batches yet). The wire format is bit-for-
// bit compatible with what pyarrow / arrow-rs / nanoarrow consume on the
// streaming path.
//
// Format spec: https://arrow.apache.org/docs/format/Columnar.html#format-ipc
//
// What this DOESN'T do (yet): file format with footer, dictionary batches,
// list / struct / decimal / timestamp / date / interval types, custom
// metadata, body buffer compression, big-endian streams. Each is independent
// follow-up work.
//
// FlatBuffers handling is hand-rolled — the schema metadata uses
// FlatBuffers but we only emit and consume tables we control, so a tiny
// purpose-built builder + reader (FBB / FBR below) is enough. No npm
// flatbuffers dep, no generated bindings.

// arrow.ts loads this file via require() and injects the constructors it
// needs through `setArrowTypes()` after evaluating its own module body.
// We don't import them here — bun's builtin bundler doesn't support
// `..`-style imports between bun:* sub-files, and a plain string-key
// registry is enough for our needs.

type ArrowKind = "int32" | "int64" | "float32" | "float64" | "bool" | "utf8" | "list";

type DataType =
  | { kind: "int32" | "int64" | "float32" | "float64" | "bool" | "utf8" }
  | { kind: "list"; child: DataType };

type Field = { name: string; type: DataType; nullable: boolean };
type Schema = { fields: Field[] };

interface ColumnLike {
  type: DataType;
  length: number;
  values: any;
  validity: Uint8Array | undefined;
  child: ColumnLike | undefined;
  get(i: number): number | bigint | boolean | string | null | unknown[];
}

interface RecordBatchLike {
  schema: Schema;
  columns: ColumnLike[];
  numRows: number;
  numColumns: number;
  column(name: string): ColumnLike;
}

interface TableLike {
  schema: Schema;
  batches: RecordBatchLike[];
  numRows: number;
}

type ArrowTypes = {
  Column: new (type: DataType, length: number, values: any, validity?: Uint8Array, child?: ColumnLike) => ColumnLike;
  RecordBatch: new (schema: Schema, columns: ColumnLike[], numRows: number) => RecordBatchLike;
  Table: new (schema: Schema, batches: RecordBatchLike[]) => TableLike;
};

let arrowTypes: ArrowTypes | null = null;

export function setArrowTypes(types: ArrowTypes): void {
  arrowTypes = types;
}

function getTypes(): ArrowTypes {
  if (!arrowTypes) {
    throw new Error("@para/arrow ipc: arrow.ts must call setArrowTypes() before fromIPC/toIPC");
  }
  return arrowTypes;
}

// ─── Type IDs from the Arrow Schema FlatBuffer ───────────────────────────
// (Schema.fbs Type union, in declaration order.)
const TYPE_NULL = 1;
const TYPE_INT = 2;
const TYPE_FLOATINGPOINT = 3;
const TYPE_BOOL = 6;
const TYPE_UTF8 = 5;
const TYPE_DATE = 8;
const TYPE_TIME = 9;
const TYPE_TIMESTAMP = 10;
const TYPE_LIST = 12;
// We emit Int / FloatingPoint / Bool / Utf8 directly. We READ Date / Time /
// Timestamp by coercing to int32 / int64 — the unit + (for Timestamp) the
// timezone are surfaced as integers without unit metadata, so round-trip
// re-emits them as plain int. Real applications that need typed dates can
// wrap the resulting integer column with their own date library.

// Date { unit:DateUnit }; DateUnit enum: DAY=0, MILLISECOND=1.
const DATE_F_UNIT = 0;
// Time { unit:TimeUnit, bitWidth:int=32 }
const TIME_F_BITWIDTH = 1;

const MESSAGE_HEADER_NONE = 0;
const MESSAGE_HEADER_SCHEMA = 1;
const MESSAGE_HEADER_DICTIONARY_BATCH = 2;
const MESSAGE_HEADER_RECORD_BATCH = 3;
const MESSAGE_HEADER_TENSOR = 4;
const MESSAGE_HEADER_SPARSE_TENSOR = 5;

const FB_PRECISION_HALF = 0;
const FB_PRECISION_SINGLE = 1;
const FB_PRECISION_DOUBLE = 2;

const METADATA_VERSION_V5 = 4; // matches arrow's MetadataVersion::V5

// ─── FlatBuffers builder (FBB) ────────────────────────────────────────────
// Buffers are built tail-to-head. The cursor represents the number of bytes
// written from the end of `buf`; absolute byte position = buf.length - cursor.
//
// Each table writes its inline fields (or 0 for absent), then writes a
// vtable describing where each non-zero field lives, then a u32 pointing
// back to that vtable. Fields are written in reverse declaration order so
// scalars and offsets align naturally without padding for our shapes.
class FBB {
  buf: Uint8Array;
  view: DataView;
  cursor: number;
  // Per-table state — null when not inside startObject/endObject.
  vtable: Uint32Array | null;
  objStart: number;

  constructor(initial: number = 1024) {
    this.buf = new Uint8Array(initial);
    this.view = new DataView(this.buf.buffer);
    this.cursor = 0;
    this.vtable = null;
    this.objStart = 0;
  }

  // Reserve `size + additional` bytes plus padding so that the next write
  // of `size` bytes is aligned to `align`.
  private prep(align: number, additional: number): void {
    const need = additional + this.cursor;
    let cap = this.buf.length;
    while (cap < need) cap *= 2;
    if (cap !== this.buf.length) {
      const grown = new Uint8Array(cap);
      grown.set(this.buf, cap - this.buf.length);
      this.buf = grown;
      this.view = new DataView(this.buf.buffer);
    }
    // Pad so the next `size`-byte write is `align`-aligned. For our shapes
    // (max 8-byte alignment for int64), this matters at vtable + table starts.
    const padNeeded = (~(this.cursor + additional) + 1) & (align - 1);
    for (let i = 0; i < padNeeded; i++) this.writeUint8(0);
  }

  private posOf(): number {
    return this.buf.length - this.cursor;
  }

  writeUint8(v: number): void {
    if (this.cursor >= this.buf.length) this.prep(1, 1);
    this.cursor++;
    this.buf[this.posOf()] = v & 0xff;
  }

  writeInt8(v: number): void {
    this.writeUint8(v & 0xff);
  }

  writeUint16(v: number): void {
    this.prep(2, 2);
    this.cursor += 2;
    this.view.setUint16(this.posOf(), v, true);
  }

  writeInt16(v: number): void {
    this.prep(2, 2);
    this.cursor += 2;
    this.view.setInt16(this.posOf(), v, true);
  }

  writeUint32(v: number): void {
    this.prep(4, 4);
    this.cursor += 4;
    this.view.setUint32(this.posOf(), v, true);
  }

  writeInt32(v: number): void {
    this.prep(4, 4);
    this.cursor += 4;
    this.view.setInt32(this.posOf(), v, true);
  }

  writeInt64(v: bigint): void {
    this.prep(8, 8);
    this.cursor += 8;
    this.view.setBigInt64(this.posOf(), v, true);
  }

  // Write a UTF-8 string, return its absolute end-position (used as offset).
  writeString(s: string): number {
    const bytes = new TextEncoder().encode(s);
    // Strings: u32 length prefix, then bytes, then null terminator.
    // FBB convention: pad before writing so the u32 length lands aligned.
    this.prep(4, bytes.length + 1);
    this.writeUint8(0); // null terminator
    for (let i = bytes.length - 1; i >= 0; i--) this.writeUint8(bytes[i]);
    this.writeUint32(bytes.length);
    return this.cursor;
  }

  // Write a vector of u32 offsets. `offsets` are positions previously
  // returned by writeString / endObject. The stored value at each slot is
  // (offsets[i] - position of slot), per FlatBuffers' "offsets are relative
  // to themselves" rule.
  writeVectorOfOffsets(offsets: number[]): number {
    this.prep(4, 4 + offsets.length * 4);
    for (let i = offsets.length - 1; i >= 0; i--) {
      const off = offsets[i];
      // Slot's absolute position once we write it:
      const slotPos = this.cursor + 4;
      this.writeUint32(slotPos - off); // FB offsets store (target - slot) in output coords
      // But we need absolute-position math to be correct: cursor counts
      // from the end. offset values that came from prior writes are the
      // cursor at write-time, increasing toward the head. So
      // (offset - slotCursor) gives the distance "forward" in the FB sense.
    }
    this.writeUint32(offsets.length);
    return this.cursor;
  }

  // Write a vector of u8 / i8 — used for the bools-as-bitmap "stored"
  // bytes that come out of a separate body buffer. Offsets are absolute.
  writeVectorOfBytes(bytes: Uint8Array): number {
    this.prep(4, 4 + bytes.length);
    for (let i = bytes.length - 1; i >= 0; i--) this.writeUint8(bytes[i]);
    this.writeUint32(bytes.length);
    return this.cursor;
  }

  // ── Table building ────────────────────────────────────────────────────

  startObject(numFields: number): void {
    if (this.vtable !== null) {
      throw new Error("FBB: nested startObject not supported in this minimal builder");
    }
    this.vtable = new Uint32Array(numFields);
    this.objStart = this.cursor;
  }

  // Add a field. `cursorAtField` is `this.cursor` *after* writing the field
  // value (so subtraction below gives the FB-style "where to find me"
  // offset relative to the table start).
  private slot(fieldId: number): void {
    if (this.vtable === null) throw new Error("FBB: addField outside startObject");
    this.vtable[fieldId] = this.cursor;
  }

  addInt8(fieldId: number, value: number, defaultVal: number): void {
    if (value === defaultVal) return;
    this.writeInt8(value);
    this.slot(fieldId);
  }

  addUint8(fieldId: number, value: number, defaultVal: number): void {
    if (value === defaultVal) return;
    this.writeUint8(value);
    this.slot(fieldId);
  }

  addInt16(fieldId: number, value: number, defaultVal: number): void {
    if (value === defaultVal) return;
    this.writeInt16(value);
    this.slot(fieldId);
  }

  addInt32(fieldId: number, value: number, defaultVal: number): void {
    if (value === defaultVal) return;
    this.writeInt32(value);
    this.slot(fieldId);
  }

  addInt64(fieldId: number, value: bigint, defaultVal: bigint): void {
    if (value === defaultVal) return;
    this.writeInt64(value);
    this.slot(fieldId);
  }

  addBool(fieldId: number, value: boolean, defaultVal: boolean): void {
    if (value === defaultVal) return;
    this.writeUint8(value ? 1 : 0);
    this.slot(fieldId);
  }

  // Add an offset field (string / vector / sub-table). `offset` is a
  // cursor value previously returned by writeString / writeVector* /
  // endObject. Stored as an FB-relative offset.
  addOffset(fieldId: number, offset: number): void {
    if (offset === 0) return;
    this.prep(4, 4);
    this.cursor += 4;
    const slotPos = this.posOf();
    this.view.setUint32(slotPos, this.cursor - offset, true);
    this.slot(fieldId);
  }

  // Finish the current table. Writes the vtable then a u32 inside the table
  // pointing back at it (the FB convention is: object position = position of
  // an i32 that holds the vtable's offset). Returns the table's cursor (used
  // as an offset by callers placing it in vectors / parent tables).
  endObject(): number {
    if (this.vtable === null) throw new Error("FBB: endObject without startObject");
    const objEnd = this.cursor;

    // Compute vtable: 2-byte vtable size, 2-byte table size, then 2-byte
    // entries (one per field; 0 for absent, otherwise offset within table
    // measured from the table start).
    const numFields = this.vtable.length;
    const fields = this.vtable;
    let highestField = -1;
    for (let i = numFields - 1; i >= 0; i--) {
      if (fields[i] !== 0) {
        highestField = i;
        break;
      }
    }
    const vtSize = 2 * (highestField + 1) + 2 + 2; // bytes
    const tableSize = objEnd - this.objStart + 4; // table size including the back-pointer i32

    // Write vtable backwards (high field index first). Vtable entries
    // store (field_start - table_start) in output coordinates, both
    // measured forward from the head. In our cursor-from-end scheme that
    // works out to (tableStart - fOff), where tableStart is the cursor
    // value at which the back-pointer will live (= cursor + vtSize + 4
    // after the prep below).
    // Pre-align so that after writing the vtable, the cursor is already
    // 4-aligned and the back-pointer needs no further padding. Without
    // this pre-pad, the prep(4, 4) below could insert 0-3 bytes between
    // vtable and back-pointer that the already-stored vtable entries
    // would not account for (vtable entries are computed from
    // tableStart, which is fixed before the writes start).
    const padBeforeVtable = (4 - ((this.cursor + vtSize) & 3)) & 3;
    for (let i = 0; i < padBeforeVtable; i++) this.writeUint8(0);

    const tableStart = this.cursor + vtSize + 4;
    for (let i = highestField; i >= 0; i--) {
      const fOff = fields[i];
      this.writeUint16(fOff === 0 ? 0 : tableStart - fOff);
    }
    this.writeUint16(tableSize);
    this.writeUint16(vtSize);
    const vtableStart = this.cursor;

    // No prep here — the pre-alignment above already left cursor 4-aligned
    // for the back-pointer.
    this.cursor += 4;
    const tablePos = this.posOf();
    // SOffsetT (signed): stored = slot_pos - vtable_pos in output coordinates.
    // In our cursor coords, both are (cursor_final - X), so the difference is
    // (vtableStart - cursor) — negative when vtable was written before slot,
    // which is our case. Reader: vtable_pos = slot_pos - stored.
    this.view.setInt32(tablePos, vtableStart - this.cursor, true);

    this.vtable = null;
    return this.cursor;
  }

  // Write the root offset and return the assembled buffer (head-aligned).
  finish(rootOffset: number): Uint8Array {
    // Need: 4-byte root offset at the head, then the rest of the FB.
    this.prep(4, 4);
    this.cursor += 4;
    this.view.setUint32(this.posOf(), this.cursor - rootOffset, true);
    return this.buf.slice(this.buf.length - this.cursor);
  }
}

// ─── FlatBuffers reader (FBR) ────────────────────────────────────────────

class FBR {
  buf: Uint8Array;
  view: DataView;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  rootOffset(): number {
    return this.view.getUint32(0, true);
  }

  // Read a u16 at absolute position.
  u16(pos: number): number {
    return this.view.getUint16(pos, true);
  }
  i16(pos: number): number {
    return this.view.getInt16(pos, true);
  }
  u32(pos: number): number {
    return this.view.getUint32(pos, true);
  }
  i32(pos: number): number {
    return this.view.getInt32(pos, true);
  }
  i64(pos: number): bigint {
    return this.view.getBigInt64(pos, true);
  }
  u8(pos: number): number {
    return this.buf[pos];
  }

  // Read field at slot fieldId of the table at `tablePos`, returning the
  // absolute position of the field's value (or undefined if absent).
  fieldPos(tablePos: number, fieldId: number): number | undefined {
    const vtableOff = this.i32(tablePos);
    const vtableStart = tablePos - vtableOff;
    const vtSize = this.u16(vtableStart);
    // vtable layout: [vtSize:u16, tableSize:u16, field0:u16, field1:u16, ...]
    const slot = vtableStart + 2 + 2 + fieldId * 2;
    if (slot - vtableStart >= vtSize) return undefined; // beyond vtable
    const fieldOff = this.u16(slot);
    if (fieldOff === 0) return undefined;
    return tablePos + fieldOff;
  }

  // Convenience: read scalar at field, or default. (We don't need very wide
  // scalar coverage — Arrow's Schema metadata uses i16/i32/i64/u8/bool.)
  readU8(tablePos: number, fieldId: number, defaultVal: number): number {
    const p = this.fieldPos(tablePos, fieldId);
    return p === undefined ? defaultVal : this.u8(p);
  }
  readI16(tablePos: number, fieldId: number, defaultVal: number): number {
    const p = this.fieldPos(tablePos, fieldId);
    return p === undefined ? defaultVal : this.i16(p);
  }
  readI32(tablePos: number, fieldId: number, defaultVal: number): number {
    const p = this.fieldPos(tablePos, fieldId);
    return p === undefined ? defaultVal : this.i32(p);
  }
  readI64(tablePos: number, fieldId: number, defaultVal: bigint): bigint {
    const p = this.fieldPos(tablePos, fieldId);
    return p === undefined ? defaultVal : this.i64(p);
  }
  readBool(tablePos: number, fieldId: number, defaultVal: boolean): boolean {
    const p = this.fieldPos(tablePos, fieldId);
    return p === undefined ? defaultVal : this.u8(p) !== 0;
  }

  // Read offset field — returns the absolute position the offset points to,
  // or undefined if absent.
  readOffset(tablePos: number, fieldId: number): number | undefined {
    const p = this.fieldPos(tablePos, fieldId);
    if (p === undefined) return undefined;
    return p + this.u32(p);
  }

  // Read a string at a position previously dereferenced with readOffset.
  readString(stringPos: number): string {
    const len = this.u32(stringPos);
    const bytes = new Uint8Array(this.buf.buffer, this.buf.byteOffset + stringPos + 4, len);
    return new TextDecoder().decode(bytes);
  }

  // Read a vector — returns its position (start of length prefix) and length.
  readVector(vecPos: number): { pos: number; len: number } {
    return { pos: vecPos, len: this.u32(vecPos) };
  }

  // Vector of offsets: i-th element is at vecPos + 4 + i*4, value is u32
  // relative offset.
  vectorOffsetAt(vecPos: number, i: number): number {
    const slot = vecPos + 4 + i * 4;
    return slot + this.u32(slot);
  }
}

// ─── Encode ───────────────────────────────────────────────────────────────

// Field id constants per the Arrow Schema FlatBuffers (Schema.fbs).

// Schema { endianness:i16=0, fields:[Field], custom_metadata:[KV], features:[i64] }
const SCHEMA_F_ENDIANNESS = 0;
const SCHEMA_F_FIELDS = 1;

// Field { name:string, nullable:bool, type_type:u8, type:Type, dictionary:DictionaryEncoding,
//         children:[Field], custom_metadata:[KV] }
const FIELD_F_NAME = 0;
const FIELD_F_NULLABLE = 1;
const FIELD_F_TYPE_TYPE = 2;
const FIELD_F_TYPE = 3;
const FIELD_F_CHILDREN = 5;

// Int { bitWidth:i32, is_signed:bool }
const INT_F_BITWIDTH = 0;
const INT_F_IS_SIGNED = 1;

// FloatingPoint { precision:i16 }
const FP_F_PRECISION = 0;

// Bool {} — empty table

// Utf8 {} — empty table

// Message { version:i16, header_type:u8, header:Type, bodyLength:i64, custom_metadata:[KV] }
const MSG_F_VERSION = 0;
const MSG_F_HEADER_TYPE = 1;
const MSG_F_HEADER = 2;
const MSG_F_BODY_LENGTH = 3;

// RecordBatch { length:i64, nodes:[FieldNode], buffers:[Buffer], compression:BodyCompression }
const RB_F_LENGTH = 0;
const RB_F_NODES = 1;
const RB_F_BUFFERS = 2;

// DictionaryEncoding { id:i64, indexType:Int, isOrdered:bool, dictionaryKind:i16 }
const DICT_F_ID = 0;
const DICT_F_INDEX_TYPE = 1;
// FIELD slot 4 is the optional DictionaryEncoding sub-table.
const FIELD_F_DICTIONARY = 4;

// DictionaryBatch { id:i64, data:RecordBatch, isDelta:bool }
const DBATCH_F_ID = 0;
const DBATCH_F_DATA = 1;
const DBATCH_F_IS_DELTA = 2;

// Buffer struct: offset:i64, length:i64. (Flatbuffers struct = inline 16
// bytes.) We emit it inline within the buffers vector.
// FieldNode struct: length:i64, null_count:i64. Same.

// Encode an empty table (no fields, no vtable entries).
function encodeEmptyTable(fbb: FBB): number {
  fbb.startObject(0);
  return fbb.endObject();
}

function encodeIntType(fbb: FBB, bitWidth: number, isSigned: boolean): number {
  fbb.startObject(2);
  fbb.addBool(INT_F_IS_SIGNED, isSigned, false);
  fbb.addInt32(INT_F_BITWIDTH, bitWidth, 0);
  return fbb.endObject();
}

function encodeFloatingPointType(fbb: FBB, precision: number): number {
  fbb.startObject(1);
  fbb.addInt16(FP_F_PRECISION, precision, 0);
  return fbb.endObject();
}

function encodeFieldType(fbb: FBB, type: DataType): { typeId: number; typeOffset: number } {
  switch (type.kind) {
    case "int32":
      return { typeId: TYPE_INT, typeOffset: encodeIntType(fbb, 32, true) };
    case "int64":
      return { typeId: TYPE_INT, typeOffset: encodeIntType(fbb, 64, true) };
    case "float32":
      return { typeId: TYPE_FLOATINGPOINT, typeOffset: encodeFloatingPointType(fbb, FB_PRECISION_SINGLE) };
    case "float64":
      return { typeId: TYPE_FLOATINGPOINT, typeOffset: encodeFloatingPointType(fbb, FB_PRECISION_DOUBLE) };
    case "bool":
      return { typeId: TYPE_BOOL, typeOffset: encodeEmptyTable(fbb) };
    case "utf8":
      return { typeId: TYPE_UTF8, typeOffset: encodeEmptyTable(fbb) };
    case "list":
      // List type-table is empty (the child element type is conveyed via
      // the field's `children` vector, not the type table itself).
      return { typeId: TYPE_LIST, typeOffset: encodeEmptyTable(fbb) };
  }
}

function encodeField(fbb: FBB, field: Field): number {
  // Children + name need to be written before the parent table.
  const nameOffset = fbb.writeString(field.name);
  const { typeId, typeOffset } = encodeFieldType(fbb, field.type);

  // Lists carry their element type via a single child Field whose name is
  // conventionally "item". Encode the child Field first (recursion handles
  // arbitrarily-nested list-of-list-of-...), then write the children vec.
  let childrenVec = 0;
  if (field.type.kind === "list") {
    const childField: Field = {
      name: "item",
      type: field.type.child,
      // Children inherit nullability conservatively — assume nullable so
      // round-trips that include nulls in the child column work.
      nullable: true,
    };
    const childFieldOffset = encodeField(fbb, childField);
    childrenVec = fbb.writeVectorOfOffsets([childFieldOffset]);
  }

  fbb.startObject(7);
  // custom_metadata = absent
  if (childrenVec !== 0) fbb.addOffset(FIELD_F_CHILDREN, childrenVec);
  fbb.addOffset(FIELD_F_TYPE, typeOffset);
  fbb.addUint8(FIELD_F_TYPE_TYPE, typeId, 0);
  fbb.addBool(FIELD_F_NULLABLE, field.nullable, false);
  fbb.addOffset(FIELD_F_NAME, nameOffset);
  return fbb.endObject();
}

function encodeSchemaMessage(fbb: FBB, schema: Schema): number {
  // Encode each field, collect offsets.
  const fieldOffsets: number[] = [];
  for (const f of schema.fields) fieldOffsets.push(encodeField(fbb, f));
  const fieldsVec = fbb.writeVectorOfOffsets(fieldOffsets);

  fbb.startObject(2);
  fbb.addOffset(SCHEMA_F_FIELDS, fieldsVec);
  fbb.addInt16(SCHEMA_F_ENDIANNESS, 0, 0); // little-endian
  return fbb.endObject();
}

function encodeMessage(fbb: FBB, headerType: number, headerOffset: number, bodyLength: bigint): Uint8Array {
  fbb.startObject(5);
  fbb.addInt64(MSG_F_BODY_LENGTH, bodyLength, 0n);
  fbb.addOffset(MSG_F_HEADER, headerOffset);
  fbb.addUint8(MSG_F_HEADER_TYPE, headerType, MESSAGE_HEADER_NONE);
  fbb.addInt16(MSG_F_VERSION, METADATA_VERSION_V5, 0);
  const root = fbb.endObject();
  return fbb.finish(root);
}

// Build the body buffer for a single RecordBatch. Returns:
//   - the body bytes (already 8-byte aligned per buffer)
//   - the FieldNode list (one entry per column)
//   - the Buffer list (offset + length per buffer in the body)
type BodyPlan = {
  body: Uint8Array;
  nodes: Array<{ length: number; nullCount: number }>;
  buffers: Array<{ offset: number; length: number }>;
};

function alignTo(n: number, a: number): number {
  return (n + a - 1) & ~(a - 1);
}

function planBody(batch: RecordBatchLike): BodyPlan {
  const nodes: BodyPlan["nodes"] = [];
  const buffers: BodyPlan["buffers"] = [];
  // Collect chunks first; concat at the end. Each chunk is padded to 8 bytes.
  const chunks: Uint8Array[] = [];
  let cursor = 0;
  const push = (chunk: Uint8Array) => {
    buffers.push({ offset: cursor, length: chunk.byteLength });
    chunks.push(chunk);
    const padded = alignTo(chunk.byteLength, 8);
    if (padded > chunk.byteLength) chunks.push(new Uint8Array(padded - chunk.byteLength));
    cursor += padded;
  };

  // Emit a single column (depth-first for nested list types).
  const emitColumn = (col: ColumnLike): void => {
    let nullCount = 0;
    if (col.validity) {
      for (let i = 0; i < col.length; i++) {
        if (!((col.validity[i >> 3] >> (i & 7)) & 1)) nullCount++;
      }
    }
    nodes.push({ length: col.length, nullCount });

    // Validity bitmap (always emitted; empty when no nulls — Arrow allows
    // an empty buffer for no-null columns).
    if (col.validity) {
      // Validity buffer length is ceil(length / 8) bytes.
      const expected = Math.ceil(col.length / 8);
      const buf =
        col.validity.byteLength === expected
          ? new Uint8Array(col.validity.buffer, col.validity.byteOffset, expected)
          : col.validity.subarray(0, expected);
      push(new Uint8Array(buf));
    } else {
      push(new Uint8Array(0));
    }

    switch (col.type.kind) {
      case "int32": {
        const v = col.values as Int32Array;
        push(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
        break;
      }
      case "int64": {
        const v = col.values as BigInt64Array;
        push(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
        break;
      }
      case "float32": {
        const v = col.values as Float32Array;
        push(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
        break;
      }
      case "float64": {
        const v = col.values as Float64Array;
        push(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
        break;
      }
      case "bool": {
        // Pack 0/1-byte values into a bitmap.
        const src = col.values as Uint8Array;
        const packed = new Uint8Array(Math.ceil(col.length / 8));
        for (let i = 0; i < col.length; i++) {
          if (src[i] & 1) packed[i >> 3] |= 1 << (i & 7);
        }
        push(packed);
        break;
      }
      case "utf8": {
        // Two buffers: i32 offsets (length+1 entries), then UTF-8 bytes.
        const src = col.values as string[];
        const offsets = new Int32Array(col.length + 1);
        let total = 0;
        const encoded: Uint8Array[] = [];
        for (let i = 0; i < col.length; i++) {
          offsets[i] = total;
          const enc = new TextEncoder().encode(src[i] ?? "");
          encoded.push(enc);
          total += enc.byteLength;
        }
        offsets[col.length] = total;
        push(new Uint8Array(offsets.buffer, offsets.byteOffset, offsets.byteLength));
        const data = new Uint8Array(total);
        let off = 0;
        for (const e of encoded) {
          data.set(e, off);
          off += e.byteLength;
        }
        push(data);
        break;
      }
      case "list": {
        // Parent buffer: i32 offsets (length+1 entries).
        const offsets = col.values as Int32Array;
        push(new Uint8Array(offsets.buffer, offsets.byteOffset, offsets.byteLength));
        // Child column follows in depth-first order.
        if (!col.child) throw new Error("@para/arrow.toIPC: list column has no child");
        emitColumn(col.child);
        break;
      }
    }
  };

  for (const col of batch.columns) emitColumn(col);

  // Concat all chunks into one body buffer.
  const body = new Uint8Array(cursor);
  let off = 0;
  for (const c of chunks) {
    body.set(c, off);
    off += c.byteLength;
  }
  return { body, nodes, buffers };
}

function encodeRecordBatchHeader(fbb: FBB, plan: BodyPlan, length: number): number {
  // Vector of FieldNode structs (struct = inline). Each is i64 length + i64
  // null_count.
  fbb.prep(8, 16 * plan.nodes.length + 4);
  for (let i = plan.nodes.length - 1; i >= 0; i--) {
    fbb.writeInt64(BigInt(plan.nodes[i].nullCount));
    fbb.writeInt64(BigInt(plan.nodes[i].length));
  }
  fbb.writeUint32(plan.nodes.length);
  const nodesVec = fbb.cursor;

  // Vector of Buffer structs: i64 offset + i64 length. Inline.
  fbb.prep(8, 16 * plan.buffers.length + 4);
  for (let i = plan.buffers.length - 1; i >= 0; i--) {
    fbb.writeInt64(BigInt(plan.buffers[i].length));
    fbb.writeInt64(BigInt(plan.buffers[i].offset));
  }
  fbb.writeUint32(plan.buffers.length);
  const buffersVec = fbb.cursor;

  fbb.startObject(4);
  fbb.addOffset(RB_F_BUFFERS, buffersVec);
  fbb.addOffset(RB_F_NODES, nodesVec);
  fbb.addInt64(RB_F_LENGTH, BigInt(length), 0n);
  return fbb.endObject();
}

// Encapsulate one IPC message in stream framing.
function frameMessage(metadata: Uint8Array, body: Uint8Array): Uint8Array {
  // Pad metadata so total prefix (8 + metadata) is 8-aligned (body starts
  // at an 8-byte boundary).
  const prefixLen = 8 + metadata.byteLength;
  const paddedMetaLen = alignTo(prefixLen, 8) - 8;
  const out = new Uint8Array(8 + paddedMetaLen + body.byteLength);
  // continuation marker
  out[0] = 0xff;
  out[1] = 0xff;
  out[2] = 0xff;
  out[3] = 0xff;
  // metadata length (excluding continuation), little-endian
  new DataView(out.buffer).setUint32(4, paddedMetaLen, true);
  out.set(metadata, 8);
  // padding bytes are already zero
  out.set(body, 8 + paddedMetaLen);
  return out;
}

// EOS marker: continuation + 0 metadata length.
function eosFrame(): Uint8Array {
  const out = new Uint8Array(8);
  out[0] = 0xff;
  out[1] = 0xff;
  out[2] = 0xff;
  out[3] = 0xff;
  // length = 0
  return out;
}

// ─── Public encode entry point ────────────────────────────────────────────

// File format magic bytes. The leading magic is "ARROW1" (6 bytes) followed
// by two NUL padding bytes for 8-byte alignment of the streaming messages.
// The trailing magic is just "ARROW1" — no padding (per the format spec).
const FILE_MAGIC_HEAD = new Uint8Array([0x41, 0x52, 0x52, 0x4f, 0x57, 0x31, 0x00, 0x00]);
const FILE_MAGIC_TAIL = new Uint8Array([0x41, 0x52, 0x52, 0x4f, 0x57, 0x31]);

// Footer { version:i16, schema:Schema, dictionaries:[Block], recordBatches:[Block], custom_metadata:[KV] }
const FOOTER_F_VERSION = 0;
const FOOTER_F_SCHEMA = 1;
const FOOTER_F_DICTIONARIES = 2;
const FOOTER_F_RECORD_BATCHES = 3;

// Block is a flatbuffers struct: { offset:i64, metaDataLength:i32, bodyLength:i64 }.
// With max-alignment 8 the layout is offset@0, metaDataLength@8, padding@12..15,
// bodyLength@16, total size 24.
const BLOCK_SIZE = 24;

export function toIPC(source: TableLike | RecordBatchLike, format: "stream" | "file" = "stream"): Uint8Array {
  const batches: RecordBatchLike[] = "batches" in source ? source.batches : [source];
  const schema: Schema = source.schema;

  const out: Uint8Array[] = [];
  // For the file format we record the absolute offset (and metadata + body
  // lengths) of each message so the Footer can point at them.
  const blocks: Array<{ offset: number; metaDataLength: number; bodyLength: number }> = [];
  let offsetCursor = 0;
  if (format === "file") {
    out.push(FILE_MAGIC_HEAD);
    offsetCursor += FILE_MAGIC_HEAD.byteLength;
  }

  // Schema message — empty body.
  {
    const fbb = new FBB();
    const headerOffset = encodeSchemaMessage(fbb, schema);
    const meta = encodeMessage(fbb, MESSAGE_HEADER_SCHEMA, headerOffset, 0n);
    const framed = frameMessage(meta, new Uint8Array(0));
    out.push(framed);
    offsetCursor += framed.byteLength;
  }

  // RecordBatch messages.
  for (const batch of batches) {
    const plan = planBody(batch);
    const fbb = new FBB();
    const headerOffset = encodeRecordBatchHeader(fbb, plan, batch.numRows);
    const meta = encodeMessage(fbb, MESSAGE_HEADER_RECORD_BATCH, headerOffset, BigInt(plan.body.byteLength));
    const framed = frameMessage(meta, plan.body);
    if (format === "file") {
      // Block.metaDataLength includes the 8-byte prefix (continuation + len)
      // and the padded metadata flatbuffer; body follows immediately after.
      blocks.push({
        offset: offsetCursor,
        metaDataLength: framed.byteLength - plan.body.byteLength,
        bodyLength: plan.body.byteLength,
      });
    }
    out.push(framed);
    offsetCursor += framed.byteLength;
  }

  // Per spec, both stream and file formats end the message section with
  // an EOS marker. The file format then continues with the footer.
  out.push(eosFrame());
  if (format === "file") {
    offsetCursor += 8; // EOS frame is 8 bytes
    // Build the Footer flatbuffer, then append footer length + tail magic.
    const fbb = new FBB();
    const schemaOffset = encodeSchemaMessage(fbb, schema);

    // recordBatches vector of inline Block structs (24 bytes each, 8-aligned).
    fbb.prep(8, BLOCK_SIZE * blocks.length + 4);
    for (let i = blocks.length - 1; i >= 0; i--) {
      // Block struct layout (reverse since FB writes back-to-front):
      // [offset:i64 | metaLen:i32 | pad:4 | bodyLen:i64]
      const b = blocks[i];
      fbb.writeInt64(BigInt(b.bodyLength));
      // 4 bytes padding before bodyLength to maintain i64 alignment for it.
      fbb.writeUint32(0);
      fbb.writeInt32(b.metaDataLength);
      fbb.writeInt64(BigInt(b.offset));
    }
    fbb.writeUint32(blocks.length);
    const recordBatchesVec = fbb.cursor;

    // dictionaries vector — empty (we don't emit dict batches).
    fbb.prep(8, 4);
    fbb.writeUint32(0);
    const dictionariesVec = fbb.cursor;

    fbb.startObject(5);
    fbb.addOffset(FOOTER_F_RECORD_BATCHES, recordBatchesVec);
    fbb.addOffset(FOOTER_F_DICTIONARIES, dictionariesVec);
    fbb.addOffset(FOOTER_F_SCHEMA, schemaOffset);
    fbb.addInt16(FOOTER_F_VERSION, METADATA_VERSION_V5, 0);
    const root = fbb.endObject();
    const footerBytes = fbb.finish(root);

    // Layout: [...messages][EOS][Footer flatbuffer][footer_length:i32][ARROW1]
    out.push(footerBytes);
    const tail = new Uint8Array(4 + FILE_MAGIC_TAIL.byteLength);
    new DataView(tail.buffer).setInt32(0, footerBytes.byteLength, true);
    tail.set(FILE_MAGIC_TAIL, 4);
    out.push(tail);
  }

  // Concatenate all frames.
  let total = 0;
  for (const f of out) total += f.byteLength;
  const result = new Uint8Array(total);
  let cursor = 0;
  for (const f of out) {
    result.set(f, cursor);
    cursor += f.byteLength;
  }
  return result;
}

// ─── Decode ───────────────────────────────────────────────────────────────

type ParsedField = {
  name: string;
  nullable: boolean;
  kind: ArrowKind;
  /** Wire byte-width for narrow-int columns we widen on read (int8/int16
   *  → int32, uint32 → int64). Undefined when wire matches the logical
   *  kind's natural width. */
  wireWidth?: 1 | 2 | 4 | 8;
  /** Wire-format signedness when widening — needed to decide between
   *  sign-extension and zero-extension. */
  wireSigned?: boolean;
  /** When set, this field is dictionary-encoded. The body buffers in a
   *  RecordBatch carry index values into the dictionary identified by
   *  `dictId`; the actual logical values come from a DictionaryBatch
   *  message keyed by the same id. */
  dictId?: bigint;
  /** Index buffer's element type when dictionary-encoded. apache-arrow
   *  defaults to int32 for utf8 dictionaries. We support int32 + int64. */
  indexKind?: ArrowKind;
  /** For `kind === "list"`: the child element field, parsed recursively. */
  child?: ParsedField;
};

type ParsedFieldType = {
  kind: ArrowKind;
  /** Wire-format byte width per element when it differs from the logical
   *  kind's natural width. Used for narrow ints (int8 / int16) and unsigned
   *  variants (uint8 / uint16 / uint32) that we widen on read. */
  wireWidth?: 1 | 2 | 4 | 8;
  /** True if the wire-format integer is signed. Defaults to true for the
   *  native widths int32 / int64. */
  wireSigned?: boolean;
};

function parseFieldType(fbr: FBR, fieldTablePos: number): ParsedFieldType {
  const typeId = fbr.readU8(fieldTablePos, FIELD_F_TYPE_TYPE, 0);
  const typeTablePos = fbr.readOffset(fieldTablePos, FIELD_F_TYPE);
  if (typeTablePos === undefined) {
    throw new Error("@para/arrow.fromIPC: Field has type_type but no type table");
  }
  switch (typeId) {
    case TYPE_INT: {
      const bw = fbr.readI32(typeTablePos, INT_F_BITWIDTH, 0);
      const signed = fbr.readBool(typeTablePos, INT_F_IS_SIGNED, false);
      // Wire-width-driven widening:
      //   int8  / int16  → int32  (sign-extending read)
      //   uint8 / uint16 → int32  (zero-extending read; always fits)
      //   int32          → int32  (native)
      //   uint32         → int64  (zero-extending; doesn't fit in i32)
      //   int64          → int64  (native)
      //   uint64         → throw  (doesn't fit losslessly anywhere)
      if (bw === 8) return { kind: "int32", wireWidth: 1, wireSigned: signed };
      if (bw === 16) return { kind: "int32", wireWidth: 2, wireSigned: signed };
      if (bw === 32) {
        if (signed) return { kind: "int32" };
        return { kind: "int64", wireWidth: 4, wireSigned: false };
      }
      if (bw === 64) {
        if (signed) return { kind: "int64" };
        throw new Error("@para/arrow.fromIPC: uint64 columns are not supported (no lossless target)");
      }
      throw new Error(`@para/arrow.fromIPC: int bitWidth ${bw} not supported`);
    }
    case TYPE_FLOATINGPOINT: {
      const prec = fbr.readI16(typeTablePos, FP_F_PRECISION, 0);
      if (prec === FB_PRECISION_SINGLE) return { kind: "float32" };
      if (prec === FB_PRECISION_DOUBLE) return { kind: "float64" };
      throw new Error(`@para/arrow.fromIPC: floating-point precision ${prec} not supported`);
    }
    case TYPE_BOOL:
      return { kind: "bool" };
    case TYPE_UTF8:
      return { kind: "utf8" };
    case TYPE_LIST:
      // List type table is empty — child element type lives in the field's
      // children vector. The caller (parseField) handles that.
      return { kind: "list" };
    case TYPE_DATE: {
      // DateUnit: DAY=0 (32-bit days since epoch), MILLISECOND=1 (64-bit ms).
      const unit = fbr.readI16(typeTablePos, DATE_F_UNIT, 1);
      if (unit === 0) return { kind: "int32" };
      if (unit === 1) return { kind: "int64" };
      throw new Error(`@para/arrow.fromIPC: Date unit ${unit} not supported`);
    }
    case TYPE_TIMESTAMP:
      // Always 64-bit regardless of TimeUnit; timezone metadata dropped.
      return { kind: "int64" };
    case TYPE_TIME: {
      // Time has its own bitWidth field (32 or 64).
      const bw = fbr.readI32(typeTablePos, TIME_F_BITWIDTH, 32);
      if (bw === 32) return { kind: "int32" };
      if (bw === 64) return { kind: "int64" };
      throw new Error(`@para/arrow.fromIPC: Time bitWidth ${bw} not supported`);
    }
    default:
      throw new Error(`@para/arrow.fromIPC: type id ${typeId} not yet supported`);
  }
}

// Parse one Field flatbuffer table into a ParsedField. Recurses into the
// `children` vector for list types.
function parseField(fbr: FBR, fieldPos: number): ParsedField {
  const namePos = fbr.readOffset(fieldPos, FIELD_F_NAME);
  const name = namePos === undefined ? "" : fbr.readString(namePos);
  const nullable = fbr.readBool(fieldPos, FIELD_F_NULLABLE, false);
  const parsed = parseFieldType(fbr, fieldPos);

  // Dictionary encoding is optional. When present, the field's body buffers
  // carry index values; the actual logical values come from a DictionaryBatch
  // message with the same id.
  const dictPos = fbr.readOffset(fieldPos, FIELD_F_DICTIONARY);
  let dictId: bigint | undefined;
  let indexKind: ArrowKind | undefined;
  if (dictPos !== undefined) {
    dictId = fbr.readI64(dictPos, DICT_F_ID, 0n);
    const indexTypePos = fbr.readOffset(dictPos, DICT_F_INDEX_TYPE);
    if (indexTypePos !== undefined) {
      const bw = fbr.readI32(indexTypePos, INT_F_BITWIDTH, 32);
      const signed = fbr.readBool(indexTypePos, INT_F_IS_SIGNED, true);
      if (!signed) throw new Error("@para/arrow.fromIPC: unsigned dictionary indexType not supported");
      if (bw === 32) indexKind = "int32";
      else if (bw === 64) indexKind = "int64";
      else throw new Error(`@para/arrow.fromIPC: dictionary indexType bitWidth ${bw} not supported`);
    } else {
      // Default per spec: signed int32.
      indexKind = "int32";
    }
  }

  let child: ParsedField | undefined;
  if (parsed.kind === "list") {
    const childrenVec = fbr.readOffset(fieldPos, FIELD_F_CHILDREN);
    if (childrenVec === undefined) {
      throw new Error("@para/arrow.fromIPC: List field is missing its children vector");
    }
    const { len } = fbr.readVector(childrenVec);
    if (len !== 1) {
      throw new Error(`@para/arrow.fromIPC: List field must have exactly one child, got ${len}`);
    }
    const childPos = fbr.vectorOffsetAt(childrenVec, 0);
    child = parseField(fbr, childPos);
  }

  return {
    name,
    nullable,
    kind: parsed.kind,
    wireWidth: parsed.wireWidth,
    wireSigned: parsed.wireSigned,
    dictId,
    indexKind,
    child,
  };
}

// Build a runtime DataType (the structural one stored on Column) from a
// ParsedField. Recurses through list children.
function dataTypeFromParsed(pf: ParsedField): DataType {
  if (pf.kind === "list") {
    if (!pf.child) throw new Error("@para/arrow.fromIPC: list ParsedField has no child");
    return { kind: "list", child: dataTypeFromParsed(pf.child) };
  }
  return { kind: pf.kind } as DataType;
}

function parseSchema(fbr: FBR, schemaTablePos: number): ParsedField[] {
  const fieldsVec = fbr.readOffset(schemaTablePos, SCHEMA_F_FIELDS);
  if (fieldsVec === undefined) throw new Error("@para/arrow.fromIPC: Schema has no fields vector");
  const { len } = fbr.readVector(fieldsVec);
  const out: ParsedField[] = [];
  for (let i = 0; i < len; i++) {
    const fieldPos = fbr.vectorOffsetAt(fieldsVec, i);
    out.push(parseField(fbr, fieldPos));
  }
  return out;
}

type ParsedRecordBatch = {
  length: number;
  nodes: Array<{ length: number; nullCount: number }>;
  buffers: Array<{ offset: number; length: number }>;
};

type ParsedDictionaryBatch = {
  id: bigint;
  isDelta: boolean;
  inner: ParsedRecordBatch;
};

function parseDictionaryBatchHeader(fbr: FBR, dbTablePos: number): ParsedDictionaryBatch {
  const id = fbr.readI64(dbTablePos, DBATCH_F_ID, 0n);
  const isDelta = fbr.readBool(dbTablePos, DBATCH_F_IS_DELTA, false);
  const dataPos = fbr.readOffset(dbTablePos, DBATCH_F_DATA);
  if (dataPos === undefined) throw new Error("@para/arrow.fromIPC: DictionaryBatch has no data table");
  const inner = parseRecordBatchHeader(fbr, dataPos);
  return { id, isDelta, inner };
}

function parseRecordBatchHeader(fbr: FBR, rbTablePos: number): ParsedRecordBatch {
  const length = Number(fbr.readI64(rbTablePos, RB_F_LENGTH, 0n));
  const nodesVec = fbr.readOffset(rbTablePos, RB_F_NODES);
  const buffersVec = fbr.readOffset(rbTablePos, RB_F_BUFFERS);
  if (nodesVec === undefined || buffersVec === undefined) {
    throw new Error("@para/arrow.fromIPC: RecordBatch missing nodes or buffers vector");
  }
  const nodesLen = fbr.u32(nodesVec);
  const nodes: ParsedRecordBatch["nodes"] = [];
  for (let i = 0; i < nodesLen; i++) {
    // FieldNode struct is inline: { length: i64, null_count: i64 }
    const base = nodesVec + 4 + i * 16;
    nodes.push({
      length: Number(fbr.i64(base)),
      nullCount: Number(fbr.i64(base + 8)),
    });
  }
  const buffersLen = fbr.u32(buffersVec);
  const buffers: ParsedRecordBatch["buffers"] = [];
  for (let i = 0; i < buffersLen; i++) {
    // Buffer struct: { offset: i64, length: i64 }
    const base = buffersVec + 4 + i * 16;
    buffers.push({
      offset: Number(fbr.i64(base)),
      length: Number(fbr.i64(base + 8)),
    });
  }
  return { length, nodes, buffers };
}

function reconstructColumn(
  field: ParsedField,
  body: Uint8Array,
  buffers: BodyPlan["buffers"],
  bufIndex: number,
  rowCount: number,
  nodes?: ParsedRecordBatch["nodes"],
  nodeIndex?: number,
): { column: ColumnLike; consumedBuffers: number; consumedNodes: number } {
  const { Column } = getTypes();
  // Validity bitmap is always the first buffer per column.
  const validityBuf = buffers[bufIndex];
  const validitySlice =
    validityBuf.length > 0
      ? new Uint8Array(body.buffer, body.byteOffset + validityBuf.offset, validityBuf.length)
      : undefined;

  switch (field.kind) {
    case "int32": {
      const valBuf = buffers[bufIndex + 1];
      const wireWidth = field.wireWidth ?? 4;
      const wireSigned = field.wireSigned ?? true;
      const out = new Int32Array(rowCount);
      const valView = new DataView(body.buffer, body.byteOffset + valBuf.offset, valBuf.length);
      if (wireWidth === 4 && wireSigned) {
        // Native int32 — same-width copy.
        const view = new Int32Array(body.buffer, body.byteOffset + valBuf.offset, rowCount);
        out.set(view);
      } else if (wireWidth === 1) {
        if (wireSigned) {
          for (let i = 0; i < rowCount; i++) out[i] = valView.getInt8(i);
        } else {
          for (let i = 0; i < rowCount; i++) out[i] = valView.getUint8(i);
        }
      } else if (wireWidth === 2) {
        if (wireSigned) {
          for (let i = 0; i < rowCount; i++) out[i] = valView.getInt16(i * 2, true);
        } else {
          for (let i = 0; i < rowCount; i++) out[i] = valView.getUint16(i * 2, true);
        }
      } else {
        throw new Error(
          `@para/arrow.fromIPC: int32 widen path: wireWidth=${wireWidth} signed=${wireSigned} not supported`,
        );
      }
      return {
        column: new Column({ kind: "int32" }, rowCount, out, validitySlice ? new Uint8Array(validitySlice) : undefined),
        consumedBuffers: 2,
        consumedNodes: 1,
      };
    }
    case "int64": {
      const valBuf = buffers[bufIndex + 1];
      const wireWidth = field.wireWidth ?? 8;
      const wireSigned = field.wireSigned ?? true;
      const out = new BigInt64Array(rowCount);
      const valView = new DataView(body.buffer, body.byteOffset + valBuf.offset, valBuf.length);
      if (wireWidth === 8 && wireSigned) {
        // Native int64 — same-width copy.
        const view = new BigInt64Array(body.buffer, body.byteOffset + valBuf.offset, rowCount);
        out.set(view);
      } else if (wireWidth === 4 && !wireSigned) {
        // uint32 → int64 (zero-extend).
        for (let i = 0; i < rowCount; i++) out[i] = BigInt(valView.getUint32(i * 4, true));
      } else {
        throw new Error(
          `@para/arrow.fromIPC: int64 widen path: wireWidth=${wireWidth} signed=${wireSigned} not supported`,
        );
      }
      return {
        column: new Column({ kind: "int64" }, rowCount, out, validitySlice ? new Uint8Array(validitySlice) : undefined),
        consumedBuffers: 2,
        consumedNodes: 1,
      };
    }
    case "float32": {
      const valBuf = buffers[bufIndex + 1];
      const view = new Float32Array(body.buffer, body.byteOffset + valBuf.offset, rowCount);
      return {
        column: new Column(
          { kind: "float32" },
          rowCount,
          new Float32Array(view),
          validitySlice ? new Uint8Array(validitySlice) : undefined,
        ),
        consumedBuffers: 2,
        consumedNodes: 1,
      };
    }
    case "float64": {
      const valBuf = buffers[bufIndex + 1];
      const view = new Float64Array(body.buffer, body.byteOffset + valBuf.offset, rowCount);
      return {
        column: new Column(
          { kind: "float64" },
          rowCount,
          new Float64Array(view),
          validitySlice ? new Uint8Array(validitySlice) : undefined,
        ),
        consumedBuffers: 2,
        consumedNodes: 1,
      };
    }
    case "bool": {
      // Unpack bitmap → byte array.
      const valBuf = buffers[bufIndex + 1];
      const packed = new Uint8Array(body.buffer, body.byteOffset + valBuf.offset, valBuf.length);
      const out = new Uint8Array(rowCount);
      for (let i = 0; i < rowCount; i++) out[i] = (packed[i >> 3] >> (i & 7)) & 1;
      return {
        column: new Column({ kind: "bool" }, rowCount, out, validitySlice ? new Uint8Array(validitySlice) : undefined),
        consumedBuffers: 2,
        consumedNodes: 1,
      };
    }
    case "utf8": {
      const offsetsBuf = buffers[bufIndex + 1];
      const dataBuf = buffers[bufIndex + 2];
      const offsets = new Int32Array(body.buffer, body.byteOffset + offsetsBuf.offset, rowCount + 1);
      const data = new Uint8Array(body.buffer, body.byteOffset + dataBuf.offset, dataBuf.length);
      const out: string[] = new Array(rowCount);
      const decoder = new TextDecoder();
      for (let i = 0; i < rowCount; i++) {
        out[i] = decoder.decode(data.subarray(offsets[i], offsets[i + 1]));
      }
      return {
        column: new Column({ kind: "utf8" }, rowCount, out, validitySlice ? new Uint8Array(validitySlice) : undefined),
        consumedBuffers: 3,
        consumedNodes: 1,
      };
    }
    case "list": {
      if (!field.child) throw new Error("@para/arrow.fromIPC: list field has no child");
      if (!nodes || nodeIndex === undefined) {
        throw new Error("@para/arrow.fromIPC: list reconstruction requires the FieldNode list");
      }
      // Parent buffers: validity bitmap (already taken at bufIndex), then
      // i32 offsets at bufIndex + 1.
      const offsetsBuf = buffers[bufIndex + 1];
      const offsets = new Int32Array(
        body.buffer.slice(
          body.byteOffset + offsetsBuf.offset,
          body.byteOffset + offsetsBuf.offset + (rowCount + 1) * 4,
        ),
      );
      // Child column starts at the next FieldNode (depth-first ordering),
      // and consumes the remaining buffers from bufIndex + 2 onward.
      const childNode = nodes[nodeIndex + 1];
      const childResult = reconstructColumn(
        field.child,
        body,
        buffers,
        bufIndex + 2,
        childNode.length,
        nodes,
        nodeIndex + 1,
      );
      return {
        column: new Column(
          dataTypeFromParsed(field),
          rowCount,
          offsets,
          validitySlice ? new Uint8Array(validitySlice) : undefined,
          childResult.column as ColumnLike,
        ),
        consumedBuffers: 2 + childResult.consumedBuffers,
        consumedNodes: 1 + childResult.consumedNodes,
      };
    }
  }
}

// Materialize a dictionary-encoded field by resolving each index to its
// dictionary value. Returns a regular Column of the field's logical type.
// Validity from the index column propagates: a null index → null output.
function resolveDictColumn(indexCol: ColumnLike, dict: ColumnLike, logicalKind: ArrowKind): ColumnLike {
  const { Column } = getTypes();
  const n = indexCol.length;
  // We forward the index column's validity bitmap (post-resolution
  // null-ness equals null-ness of the index for these dictionary types).
  const validity = indexCol.validity;
  const idxAt = (i: number): number | null => {
    if (validity && !((validity[i >> 3] >> (i & 7)) & 1)) return null;
    const v = indexCol.get(i);
    return v == null ? null : Number(v);
  };

  switch (logicalKind) {
    case "int32": {
      const out = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        const idx = idxAt(i);
        if (idx == null) continue;
        out[i] = dict.get(idx) as number;
      }
      return new Column({ kind: "int32" }, n, out, validity);
    }
    case "int64": {
      const out = new BigInt64Array(n);
      for (let i = 0; i < n; i++) {
        const idx = idxAt(i);
        if (idx == null) continue;
        out[i] = dict.get(idx) as bigint;
      }
      return new Column({ kind: "int64" }, n, out, validity);
    }
    case "float32": {
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const idx = idxAt(i);
        if (idx == null) continue;
        out[i] = dict.get(idx) as number;
      }
      return new Column({ kind: "float32" }, n, out, validity);
    }
    case "float64": {
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const idx = idxAt(i);
        if (idx == null) continue;
        out[i] = dict.get(idx) as number;
      }
      return new Column({ kind: "float64" }, n, out, validity);
    }
    case "bool": {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const idx = idxAt(i);
        if (idx == null) continue;
        out[i] = (dict.get(idx) as boolean) ? 1 : 0;
      }
      return new Column({ kind: "bool" }, n, out, validity);
    }
    case "utf8": {
      const out: string[] = new Array(n);
      for (let i = 0; i < n; i++) {
        const idx = idxAt(i);
        if (idx == null) {
          out[i] = "";
          continue;
        }
        out[i] = dict.get(idx) as string;
      }
      return new Column({ kind: "utf8" }, n, out, validity);
    }
  }
}

// ─── Public decode entry point ────────────────────────────────────────────

// Returns true if `bytes` starts with the 8-byte head magic ("ARROW1\0\0")
// and ends with the 6-byte tail magic ("ARROW1"). The format is asymmetric:
// the head is padded to 8-byte alignment for the streaming messages that
// follow it, the tail isn't.
function looksLikeFileFormat(bytes: Uint8Array): boolean {
  if (bytes.byteLength < FILE_MAGIC_HEAD.byteLength + FILE_MAGIC_TAIL.byteLength + 4) return false;
  for (let i = 0; i < FILE_MAGIC_HEAD.byteLength; i++) {
    if (bytes[i] !== FILE_MAGIC_HEAD[i]) return false;
  }
  for (let i = 0; i < FILE_MAGIC_TAIL.byteLength; i++) {
    if (bytes[bytes.byteLength - FILE_MAGIC_TAIL.byteLength + i] !== FILE_MAGIC_TAIL[i]) return false;
  }
  return true;
}

export function fromIPC(bytes: Uint8Array): TableLike {
  // Auto-detect the file format. apache-arrow's file format puts the
  // Schema in the Footer (not as a leading streaming Schema message) and
  // identifies each RecordBatch / DictionaryBatch by the absolute byte
  // offset and metadata-length / body-length recorded in the Footer's
  // Block lists. We parse the footer up front, then decode each block.
  if (looksLikeFileFormat(bytes)) {
    return fromIPCFile(bytes);
  }
  const { RecordBatch, Table, Column } = getTypes();

  let cursor = 0;
  let schema: Schema | null = null;
  let parsedFields: ParsedField[] = [];
  const batches: RecordBatchLike[] = [];
  // dict_id → resolved values column. Populated when DictionaryBatch
  // messages arrive; consumed when a RecordBatch references a dict-
  // encoded field.
  const dictionaries = new Map<bigint, ColumnLike>();

  while (cursor < bytes.byteLength) {
    // Continuation prefix or pre-V5 length-only prefix.
    if (cursor + 4 > bytes.byteLength) break;
    const cont = new DataView(bytes.buffer, bytes.byteOffset + cursor, 4).getUint32(0, true);
    let metaLenPos: number;
    if (cont === 0xffffffff) {
      metaLenPos = cursor + 4;
      cursor += 4;
    } else {
      // Pre-V5 streams omit the continuation; cont IS the metadata length.
      metaLenPos = cursor;
    }
    if (metaLenPos + 4 > bytes.byteLength) break;
    const metaLen = new DataView(bytes.buffer, bytes.byteOffset + metaLenPos, 4).getUint32(0, true);
    cursor = metaLenPos + 4;
    if (metaLen === 0) break; // EOS

    const metaBytes = new Uint8Array(bytes.buffer, bytes.byteOffset + cursor, metaLen);
    cursor += metaLen;

    // Parse the Message FlatBuffer.
    const fbr = new FBR(metaBytes);
    const root = fbr.rootOffset();
    const headerType = fbr.readU8(root, MSG_F_HEADER_TYPE, 0);
    const headerPos = fbr.readOffset(root, MSG_F_HEADER);
    const bodyLength = Number(fbr.readI64(root, MSG_F_BODY_LENGTH, 0n));

    const body =
      bodyLength > 0 ? new Uint8Array(bytes.buffer, bytes.byteOffset + cursor, bodyLength) : new Uint8Array(0);
    cursor += bodyLength;

    if (headerType === MESSAGE_HEADER_SCHEMA) {
      if (headerPos === undefined) throw new Error("@para/arrow.fromIPC: Schema message has no header table");
      parsedFields = parseSchema(fbr, headerPos);
      schema = {
        fields: parsedFields.map(f => ({ name: f.name, type: dataTypeFromParsed(f), nullable: f.nullable })),
      };
    } else if (headerType === MESSAGE_HEADER_RECORD_BATCH) {
      if (!schema) throw new Error("@para/arrow.fromIPC: RecordBatch arrived before Schema");
      if (headerPos === undefined) throw new Error("@para/arrow.fromIPC: RecordBatch message has no header table");
      const rb = parseRecordBatchHeader(fbr, headerPos);
      const cols: ColumnLike[] = [];
      let bufIndex = 0;
      let nodeIndex = 0;
      for (let i = 0; i < schema.fields.length; i++) {
        const pf = parsedFields[i];
        const node = rb.nodes[nodeIndex];
        if (pf.dictId !== undefined) {
          // Dictionary-encoded field: body buffers carry an index column of
          // pf.indexKind. Reconstruct the index column, then resolve every
          // value through dictionaries[pf.dictId].
          const dict = dictionaries.get(pf.dictId);
          if (!dict) {
            throw new Error(
              `@para/arrow.fromIPC: dictionary id ${pf.dictId} referenced before its DictionaryBatch arrived`,
            );
          }
          const {
            column: indexCol,
            consumedBuffers,
            consumedNodes,
          } = reconstructColumn(
            { name: pf.name, nullable: pf.nullable, kind: pf.indexKind ?? "int32" },
            body,
            rb.buffers,
            bufIndex,
            node.length,
            rb.nodes,
            nodeIndex,
          );
          cols.push(resolveDictColumn(indexCol, dict, pf.kind));
          bufIndex += consumedBuffers;
          nodeIndex += consumedNodes;
        } else {
          const { column, consumedBuffers, consumedNodes } = reconstructColumn(
            pf,
            body,
            rb.buffers,
            bufIndex,
            node.length,
            rb.nodes,
            nodeIndex,
          );
          cols.push(column);
          bufIndex += consumedBuffers;
          nodeIndex += consumedNodes;
        }
      }
      batches.push(new RecordBatch(schema, cols, rb.length));
    } else if (headerType === MESSAGE_HEADER_DICTIONARY_BATCH) {
      if (headerPos === undefined) {
        throw new Error("@para/arrow.fromIPC: DictionaryBatch message has no header table");
      }
      const db = parseDictionaryBatchHeader(fbr, headerPos);
      if (db.isDelta) {
        throw new Error(
          "@para/arrow.fromIPC: dictionary deltas (isDelta=true) are not yet supported — apache-arrow's default is non-delta",
        );
      }
      // Find the field that uses this dict id to determine the logical type.
      const owner = parsedFields.find(f => f.dictId === db.id);
      if (!owner) {
        throw new Error(`@para/arrow.fromIPC: DictionaryBatch id ${db.id} arrived but no schema field references it`);
      }
      const innerNode = db.inner.nodes[0];
      const { column } = reconstructColumn(
        { name: "", nullable: false, kind: owner.kind },
        body,
        db.inner.buffers,
        0,
        innerNode.length,
      );
      dictionaries.set(db.id, column);
    }
    // Unknown header types are silently skipped (they consumed 0 body
    // since bodyLength was 0).
  }

  if (!schema) throw new Error("@para/arrow.fromIPC: stream ended before any Schema message");
  if (batches.length === 0) return emptyTable(schema);
  return new Table(schema, batches);
}

function emptyTable(schema: Schema): TableLike {
  const { RecordBatch, Table, Column } = getTypes();
  const makeEmpty = (type: DataType): ColumnLike => {
    switch (type.kind) {
      case "int32":
        return new Column({ kind: "int32" }, 0, new Int32Array(0));
      case "int64":
        return new Column({ kind: "int64" }, 0, new BigInt64Array(0));
      case "float32":
        return new Column({ kind: "float32" }, 0, new Float32Array(0));
      case "float64":
        return new Column({ kind: "float64" }, 0, new Float64Array(0));
      case "bool":
        return new Column({ kind: "bool" }, 0, new Uint8Array(0));
      case "utf8":
        return new Column({ kind: "utf8" }, 0, []);
      case "list":
        // Single-entry offsets ([0]) — there are no rows so no per-row
        // offset, but the offsets buffer still needs the trailing total.
        return new Column(type, 0, new Int32Array([0]), undefined, makeEmpty(type.child));
    }
  };
  const emptyCols: ColumnLike[] = schema.fields.map(f => makeEmpty(f.type));
  return new Table(schema, [new RecordBatch(schema, emptyCols, 0)]);
}

// Decode a single RecordBatch message at the given absolute byte offset,
// using the (already-parsed) schema to drive column reconstruction.
// Returns the resulting RecordBatchLike.
function decodeRecordBatchAt(
  bytes: Uint8Array,
  schema: Schema,
  parsedFields: ParsedField[],
  dictionaries: Map<bigint, ColumnLike>,
  msgStart: number,
): RecordBatchLike {
  const { RecordBatch } = getTypes();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Message framing: continuation (4) + metaLen (4) + meta bytes + body bytes.
  const cont = view.getUint32(msgStart, true);
  let metaLenPos = msgStart;
  if (cont === 0xffffffff) metaLenPos = msgStart + 4;
  const metaLen = view.getUint32(metaLenPos, true);
  const metaStart = metaLenPos + 4;
  const metaBytes = new Uint8Array(bytes.buffer, bytes.byteOffset + metaStart, metaLen);
  const fbr = new FBR(metaBytes);
  const root = fbr.rootOffset();
  const headerType = fbr.readU8(root, MSG_F_HEADER_TYPE, 0);
  const headerPos = fbr.readOffset(root, MSG_F_HEADER);
  const bodyLength = Number(fbr.readI64(root, MSG_F_BODY_LENGTH, 0n));
  const bodyStart = metaStart + metaLen;
  const body =
    bodyLength > 0 ? new Uint8Array(bytes.buffer, bytes.byteOffset + bodyStart, bodyLength) : new Uint8Array(0);

  if (headerType !== MESSAGE_HEADER_RECORD_BATCH || headerPos === undefined) {
    throw new Error(`@para/arrow.fromIPC: expected RecordBatch at offset ${msgStart}, got header type ${headerType}`);
  }
  const rb = parseRecordBatchHeader(fbr, headerPos);
  const cols: ColumnLike[] = [];
  let bufIndex = 0;
  let nodeIndex = 0;
  for (let i = 0; i < schema.fields.length; i++) {
    const pf = parsedFields[i];
    const node = rb.nodes[nodeIndex];
    if (pf.dictId !== undefined) {
      const dict = dictionaries.get(pf.dictId);
      if (!dict) {
        throw new Error(`@para/arrow.fromIPC: dictionary id ${pf.dictId} referenced but no DictionaryBatch found`);
      }
      const {
        column: indexCol,
        consumedBuffers,
        consumedNodes,
      } = reconstructColumn(
        { name: pf.name, nullable: pf.nullable, kind: pf.indexKind ?? "int32" },
        body,
        rb.buffers,
        bufIndex,
        node.length,
        rb.nodes,
        nodeIndex,
      );
      cols.push(resolveDictColumn(indexCol, dict, pf.kind));
      bufIndex += consumedBuffers;
      nodeIndex += consumedNodes;
    } else {
      const { column, consumedBuffers, consumedNodes } = reconstructColumn(
        pf,
        body,
        rb.buffers,
        bufIndex,
        node.length,
        rb.nodes,
        nodeIndex,
      );
      cols.push(column);
      bufIndex += consumedBuffers;
      nodeIndex += consumedNodes;
    }
  }
  return new RecordBatch(schema, cols, rb.length);
}

function fromIPCFile(bytes: Uint8Array): TableLike {
  const { Table } = getTypes();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const footerLenPos = bytes.byteLength - FILE_MAGIC_TAIL.byteLength - 4;
  const footerLen = view.getInt32(footerLenPos, true);
  const minTailBytes = FILE_MAGIC_HEAD.byteLength + FILE_MAGIC_TAIL.byteLength + 4;
  if (footerLen <= 0 || footerLen > bytes.byteLength - minTailBytes) {
    throw new Error(`@para/arrow.fromIPC: file format footer length ${footerLen} is invalid`);
  }
  const footerStart = footerLenPos - footerLen;
  const footerBytes = new Uint8Array(bytes.buffer, bytes.byteOffset + footerStart, footerLen);
  const ffbr = new FBR(footerBytes);
  const footerRoot = ffbr.rootOffset();

  const schemaPos = ffbr.readOffset(footerRoot, FOOTER_F_SCHEMA);
  if (schemaPos === undefined) {
    throw new Error("@para/arrow.fromIPC: file format Footer is missing its Schema");
  }
  const parsedFields = parseSchema(ffbr, schemaPos);
  const schema: Schema = {
    fields: parsedFields.map(f => ({ name: f.name, type: dataTypeFromParsed(f), nullable: f.nullable })),
  };

  // Walk dictionaries vector first so RecordBatches can reference them.
  const dictionaries = new Map<bigint, ColumnLike>();
  const dictsVec = ffbr.readOffset(footerRoot, FOOTER_F_DICTIONARIES);
  if (dictsVec !== undefined) {
    const len = ffbr.u32(dictsVec);
    for (let i = 0; i < len; i++) {
      const blockBase = dictsVec + 4 + i * BLOCK_SIZE;
      const offset = Number(ffbr.i64(blockBase));
      // Decode the dictionary message at offset using the same logic as the
      // streaming decoder. We construct a minimal "single message" decoder
      // inline because the layout is fully self-describing.
      const msgView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const cont = msgView.getUint32(offset, true);
      let metaLenPos = offset;
      if (cont === 0xffffffff) metaLenPos = offset + 4;
      const metaLen = msgView.getUint32(metaLenPos, true);
      const metaStart = metaLenPos + 4;
      const metaBytes = new Uint8Array(bytes.buffer, bytes.byteOffset + metaStart, metaLen);
      const mfbr = new FBR(metaBytes);
      const mroot = mfbr.rootOffset();
      const headerPos = mfbr.readOffset(mroot, MSG_F_HEADER);
      const bodyLength = Number(mfbr.readI64(mroot, MSG_F_BODY_LENGTH, 0n));
      const bodyStart = metaStart + metaLen;
      const body =
        bodyLength > 0 ? new Uint8Array(bytes.buffer, bytes.byteOffset + bodyStart, bodyLength) : new Uint8Array(0);
      if (headerPos === undefined) throw new Error("@para/arrow.fromIPC: DictionaryBatch missing header table");
      const db = parseDictionaryBatchHeader(mfbr, headerPos);
      if (db.isDelta) {
        throw new Error("@para/arrow.fromIPC: dictionary deltas not supported");
      }
      const owner = parsedFields.find(f => f.dictId === db.id);
      if (!owner) continue;
      const innerNode = db.inner.nodes[0];
      const { column } = reconstructColumn(
        { name: "", nullable: false, kind: owner.kind },
        body,
        db.inner.buffers,
        0,
        innerNode.length,
      );
      dictionaries.set(db.id, column);
    }
  }

  const batches: RecordBatchLike[] = [];
  const rbsVec = ffbr.readOffset(footerRoot, FOOTER_F_RECORD_BATCHES);
  if (rbsVec !== undefined) {
    const len = ffbr.u32(rbsVec);
    for (let i = 0; i < len; i++) {
      const blockBase = rbsVec + 4 + i * BLOCK_SIZE;
      const offset = Number(ffbr.i64(blockBase));
      batches.push(decodeRecordBatchAt(bytes, schema, parsedFields, dictionaries, offset));
    }
  }

  if (batches.length === 0) return emptyTable(schema);
  return new Table(schema, batches);
}
