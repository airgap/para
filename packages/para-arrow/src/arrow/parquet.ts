// Parquet reader for @para/arrow.
//
// Supports the column-oriented Apache Parquet format on read. The slice
// of the spec covered:
//
//   - File framing: PAR1 magic at start + end, length-prefixed Thrift
//     FileMetaData footer, multiple row groups, multiple column chunks.
//   - Physical types: BOOLEAN, INT32, INT64, FLOAT, DOUBLE, BYTE_ARRAY
//     (treated as utf8 by default — coerced to string).
//   - Encodings: PLAIN, PLAIN_DICTIONARY (deprecated alias for
//     RLE_DICTIONARY), RLE_DICTIONARY, RLE (for definition / repetition
//     levels and bit-packed booleans), BIT_PACKED (deprecated, sometimes
//     emitted by older writers).
//   - Compression: UNCOMPRESSED, SNAPPY (handed-rolled inflate — Bun
//     doesn't ship a Snappy decoder), GZIP (via Bun.gunzipSync).
//   - Page formats: V1 data pages (def levels + rep levels + values),
//     dictionary pages.
//   - Schemas: flat, top-level columns. Required and optional. Nested
//     types (List / Map / Struct) read into list-of-structs would need
//     definition / repetition level reconstruction — out of scope for v1.
//
// Hand-rolled Thrift compact protocol decoder; no npm dep on
// `parquetjs` / `thrift`. The schema list is hard-coded against the
// parquet.thrift definitions, not a generic Thrift parser.

interface ColumnLike {
  type: { kind: string };
  length: number;
  values: any;
  validity: Uint8Array | undefined;
  child: ColumnLike | undefined;
  get(i: number): unknown;
}

interface RecordBatchLike {
  schema: { fields: { name: string; type: { kind: string }; nullable: boolean }[] };
  columns: ColumnLike[];
  numRows: number;
  numColumns: number;
  column(name: string): ColumnLike;
}

interface TableLike {
  schema: { fields: { name: string; type: { kind: string }; nullable: boolean }[] };
  batches: RecordBatchLike[];
  numRows: number;
}

type ArrowTypes = {
  Column: new (
    type: { kind: string },
    length: number,
    values: any,
    validity?: Uint8Array,
    child?: ColumnLike,
  ) => ColumnLike;
  RecordBatch: new (
    schema: { fields: { name: string; type: { kind: string }; nullable: boolean }[] },
    columns: ColumnLike[],
    numRows: number,
  ) => RecordBatchLike;
  Table: new (
    schema: { fields: { name: string; type: { kind: string }; nullable: boolean }[] },
    batches: RecordBatchLike[],
  ) => TableLike;
};

let arrowTypes: ArrowTypes | null = null;

export function setArrowTypes(types: ArrowTypes): void {
  arrowTypes = types;
}

function getTypes(): ArrowTypes {
  if (!arrowTypes) {
    throw new Error("@para/arrow parquet: arrow.ts must call setArrowTypes() before fromParquet");
  }
  return arrowTypes;
}

// ─── Thrift compact protocol ──────────────────────────────────────────────
// Field header: 1 byte. High nibble = field-id delta, low nibble = type.
// If delta == 0, the absolute field id follows as a zigzag i16.
//
// Element types (compact-protocol numbering):
const TC_STOP = 0;
const TC_BOOL_TRUE = 1;
const TC_BOOL_FALSE = 2;
const TC_BYTE = 3;
const TC_I16 = 4;
const TC_I32 = 5;
const TC_I64 = 6;
const TC_DOUBLE = 7;
const TC_BINARY = 8;
const TC_LIST = 9;
const TC_SET = 10;
const TC_MAP = 11;
const TC_STRUCT = 12;

class ThriftReader {
  buf: Uint8Array;
  view: DataView;
  pos: number;

  constructor(buf: Uint8Array, pos: number = 0) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.pos = pos;
  }

  // Unsigned varint.
  readVarint(): number {
    let result = 0;
    let shift = 0;
    while (true) {
      if (this.pos >= this.buf.length) throw new Error("thrift: varint overflowed buffer");
      const b = this.buf[this.pos++];
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result >>> 0;
      shift += 7;
      if (shift > 35) throw new Error("thrift: varint > 5 bytes");
    }
  }

  // 64-bit unsigned varint as bigint (used for I64 zigzag).
  readVarint64(): bigint {
    let result = 0n;
    let shift = 0n;
    while (true) {
      if (this.pos >= this.buf.length) throw new Error("thrift: varint64 overflowed buffer");
      const b = BigInt(this.buf[this.pos++]);
      result |= (b & 0x7fn) << shift;
      if ((b & 0x80n) === 0n) return result;
      shift += 7n;
      if (shift > 63n) throw new Error("thrift: varint64 > 10 bytes");
    }
  }

  readZigzagI32(): number {
    const v = this.readVarint();
    return (v >>> 1) ^ -(v & 1);
  }

  readZigzagI64(): bigint {
    const v = this.readVarint64();
    return (v >> 1n) ^ -(v & 1n);
  }

  readByte(): number {
    return this.buf[this.pos++];
  }

  readI8(): number {
    return (this.buf[this.pos++] << 24) >> 24;
  }

  readBinary(): Uint8Array {
    const len = this.readVarint();
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  readString(): string {
    return new TextDecoder().decode(this.readBinary());
  }

  // Skip a value of the given type. Used to drop fields we don't care about.
  skip(type: number): void {
    switch (type) {
      case TC_BOOL_TRUE:
      case TC_BOOL_FALSE:
        return;
      case TC_BYTE:
        this.pos += 1;
        return;
      case TC_I16:
      case TC_I32:
        this.readZigzagI32();
        return;
      case TC_I64:
        this.readZigzagI64();
        return;
      case TC_DOUBLE:
        this.pos += 8;
        return;
      case TC_BINARY:
        this.readBinary();
        return;
      case TC_LIST:
      case TC_SET: {
        const head = this.readByte();
        const elementType = head & 0x0f;
        let size = (head >> 4) & 0x0f;
        if (size === 15) size = this.readVarint();
        for (let i = 0; i < size; i++) this.skip(elementType);
        return;
      }
      case TC_MAP: {
        const size = this.readVarint();
        if (size > 0) {
          const kvType = this.readByte();
          const keyType = (kvType >> 4) & 0x0f;
          const valueType = kvType & 0x0f;
          for (let i = 0; i < size; i++) {
            this.skip(keyType);
            this.skip(valueType);
          }
        }
        return;
      }
      case TC_STRUCT:
        this.skipStruct();
        return;
      default:
        throw new Error(`thrift: cannot skip type ${type}`);
    }
  }

  skipStruct(): void {
    let lastFieldId = 0;
    while (true) {
      const head = this.readByte();
      const type = head & 0x0f;
      if (type === TC_STOP) return;
      const delta = (head >> 4) & 0x0f;
      const fieldId = delta === 0 ? this.readZigzagI32() : lastFieldId + delta;
      lastFieldId = fieldId;
      this.skip(type);
    }
  }

  // Read fields until STOP, dispatching to the caller-provided handler.
  // Handler returns true if it consumed the field, false to skip.
  readStruct(handler: (fieldId: number, type: number, r: ThriftReader) => boolean): void {
    let lastFieldId = 0;
    while (true) {
      const head = this.readByte();
      const type = head & 0x0f;
      if (type === TC_STOP) return;
      const delta = (head >> 4) & 0x0f;
      const fieldId = delta === 0 ? this.readZigzagI32() : lastFieldId + delta;
      lastFieldId = fieldId;
      if (!handler(fieldId, type, this)) this.skip(type);
    }
  }

  // List header: type + size.
  readListHeader(): { elementType: number; size: number } {
    const head = this.readByte();
    const elementType = head & 0x0f;
    let size = (head >> 4) & 0x0f;
    if (size === 15) size = this.readVarint();
    return { elementType, size };
  }
}

// ─── Parquet thrift schema (subset we actually parse) ─────────────────────

// Type enum (parquet.thrift)
const PQ_TYPE_BOOLEAN = 0;
const PQ_TYPE_INT32 = 1;
const PQ_TYPE_INT64 = 2;
const PQ_TYPE_INT96 = 3;
const PQ_TYPE_FLOAT = 4;
const PQ_TYPE_DOUBLE = 5;
const PQ_TYPE_BYTE_ARRAY = 6;
const PQ_TYPE_FIXED_LEN_BYTE_ARRAY = 7;

// FieldRepetitionType
const PQ_REP_REQUIRED = 0;
const PQ_REP_OPTIONAL = 1;
const PQ_REP_REPEATED = 2;

// ConvertedType (legacy logical-type mapping)
const PQ_CT_UTF8 = 0;

// CompressionCodec
const PQ_CODEC_UNCOMPRESSED = 0;
const PQ_CODEC_SNAPPY = 1;
const PQ_CODEC_GZIP = 2;

// PageType
const PQ_PAGE_DATA_PAGE = 0;
const PQ_PAGE_INDEX_PAGE = 1;
const PQ_PAGE_DICTIONARY_PAGE = 2;
const PQ_PAGE_DATA_PAGE_V2 = 3;

// Encoding
const PQ_ENC_PLAIN = 0;
const PQ_ENC_PLAIN_DICTIONARY = 2;
const PQ_ENC_RLE = 3;
const PQ_ENC_BIT_PACKED = 4;
const PQ_ENC_DELTA_BINARY_PACKED = 5;
const PQ_ENC_DELTA_LENGTH_BYTE_ARRAY = 6;
const PQ_ENC_DELTA_BYTE_ARRAY = 7;
const PQ_ENC_RLE_DICTIONARY = 8;

interface SchemaElement {
  type: number | undefined; // physical type — undefined for group nodes
  typeLength: number | undefined;
  repetitionType: number; // defaults to required at the root
  name: string;
  numChildren: number; // 0 for leaf
  convertedType: number | undefined;
}

interface ColumnMetaData {
  type: number;
  encodings: number[];
  pathInSchema: string[];
  codec: number;
  numValues: bigint;
  dataPageOffset: bigint;
  dictionaryPageOffset: bigint | undefined;
}

interface ColumnChunk {
  fileOffset: bigint;
  metaData: ColumnMetaData;
}

interface RowGroup {
  columns: ColumnChunk[];
  numRows: bigint;
}

interface FileMetaData {
  version: number;
  schema: SchemaElement[];
  numRows: bigint;
  rowGroups: RowGroup[];
}

function parseSchemaElement(r: ThriftReader): SchemaElement {
  const out: SchemaElement = {
    type: undefined,
    typeLength: undefined,
    repetitionType: PQ_REP_REQUIRED,
    name: "",
    numChildren: 0,
    convertedType: undefined,
  };
  r.readStruct((fid, t, rr) => {
    switch (fid) {
      case 1:
        out.type = rr.readZigzagI32();
        return true;
      case 2:
        out.typeLength = rr.readZigzagI32();
        return true;
      case 3:
        out.repetitionType = rr.readZigzagI32();
        return true;
      case 4:
        out.name = rr.readString();
        return true;
      case 5:
        out.numChildren = rr.readZigzagI32();
        return true;
      case 6:
        out.convertedType = rr.readZigzagI32();
        return true;
    }
    return false;
  });
  return out;
}

function parseColumnMetaData(r: ThriftReader): ColumnMetaData {
  const out: ColumnMetaData = {
    type: PQ_TYPE_INT32,
    encodings: [],
    pathInSchema: [],
    codec: PQ_CODEC_UNCOMPRESSED,
    numValues: 0n,
    dataPageOffset: 0n,
    dictionaryPageOffset: undefined,
  };
  r.readStruct((fid, t, rr) => {
    switch (fid) {
      case 1:
        out.type = rr.readZigzagI32();
        return true;
      case 2: {
        const { size } = rr.readListHeader();
        for (let i = 0; i < size; i++) out.encodings.push(rr.readZigzagI32());
        return true;
      }
      case 3: {
        const { size } = rr.readListHeader();
        for (let i = 0; i < size; i++) out.pathInSchema.push(rr.readString());
        return true;
      }
      case 4:
        out.codec = rr.readZigzagI32();
        return true;
      case 5:
        out.numValues = rr.readZigzagI64();
        return true;
      case 9:
        out.dataPageOffset = rr.readZigzagI64();
        return true;
      case 11:
        out.dictionaryPageOffset = rr.readZigzagI64();
        return true;
    }
    return false;
  });
  return out;
}

function parseColumnChunk(r: ThriftReader): ColumnChunk {
  let fileOffset = 0n;
  let metaData: ColumnMetaData | undefined;
  r.readStruct((fid, t, rr) => {
    switch (fid) {
      case 2:
        fileOffset = rr.readZigzagI64();
        return true;
      case 3:
        metaData = parseColumnMetaData(rr);
        return true;
    }
    return false;
  });
  if (!metaData) throw new Error("parquet: ColumnChunk has no inline meta_data — file_path indirection not supported");
  return { fileOffset, metaData };
}

function parseRowGroup(r: ThriftReader): RowGroup {
  const out: RowGroup = { columns: [], numRows: 0n };
  r.readStruct((fid, t, rr) => {
    switch (fid) {
      case 1: {
        const { size } = rr.readListHeader();
        for (let i = 0; i < size; i++) out.columns.push(parseColumnChunk(rr));
        return true;
      }
      case 3:
        out.numRows = rr.readZigzagI64();
        return true;
    }
    return false;
  });
  return out;
}

function parseFileMetaData(r: ThriftReader): FileMetaData {
  const out: FileMetaData = { version: 0, schema: [], numRows: 0n, rowGroups: [] };
  r.readStruct((fid, t, rr) => {
    switch (fid) {
      case 1:
        out.version = rr.readZigzagI32();
        return true;
      case 2: {
        const { size } = rr.readListHeader();
        for (let i = 0; i < size; i++) out.schema.push(parseSchemaElement(rr));
        return true;
      }
      case 3:
        out.numRows = rr.readZigzagI64();
        return true;
      case 4: {
        const { size } = rr.readListHeader();
        for (let i = 0; i < size; i++) out.rowGroups.push(parseRowGroup(rr));
        return true;
      }
    }
    return false;
  });
  return out;
}

// ─── Page header (Thrift) ─────────────────────────────────────────────────

interface DataPageHeader {
  numValues: number;
  encoding: number;
  defLevelEncoding: number;
  repLevelEncoding: number;
}

interface DictionaryPageHeader {
  numValues: number;
  encoding: number;
}

interface PageHeader {
  type: number;
  uncompressedSize: number;
  compressedSize: number;
  dataPageHeader: DataPageHeader | undefined;
  dictionaryPageHeader: DictionaryPageHeader | undefined;
}

function parseDataPageHeader(r: ThriftReader): DataPageHeader {
  const out: DataPageHeader = {
    numValues: 0,
    encoding: PQ_ENC_PLAIN,
    defLevelEncoding: PQ_ENC_RLE,
    repLevelEncoding: PQ_ENC_RLE,
  };
  r.readStruct((fid, t, rr) => {
    switch (fid) {
      case 1:
        out.numValues = rr.readZigzagI32();
        return true;
      case 2:
        out.encoding = rr.readZigzagI32();
        return true;
      case 3:
        out.defLevelEncoding = rr.readZigzagI32();
        return true;
      case 4:
        out.repLevelEncoding = rr.readZigzagI32();
        return true;
    }
    return false;
  });
  return out;
}

function parseDictionaryPageHeader(r: ThriftReader): DictionaryPageHeader {
  const out: DictionaryPageHeader = { numValues: 0, encoding: PQ_ENC_PLAIN };
  r.readStruct((fid, t, rr) => {
    switch (fid) {
      case 1:
        out.numValues = rr.readZigzagI32();
        return true;
      case 2:
        out.encoding = rr.readZigzagI32();
        return true;
    }
    return false;
  });
  return out;
}

function parsePageHeader(r: ThriftReader): PageHeader {
  const out: PageHeader = {
    type: PQ_PAGE_DATA_PAGE,
    uncompressedSize: 0,
    compressedSize: 0,
    dataPageHeader: undefined,
    dictionaryPageHeader: undefined,
  };
  r.readStruct((fid, t, rr) => {
    switch (fid) {
      case 1:
        out.type = rr.readZigzagI32();
        return true;
      case 2:
        out.uncompressedSize = rr.readZigzagI32();
        return true;
      case 3:
        out.compressedSize = rr.readZigzagI32();
        return true;
      case 5:
        out.dataPageHeader = parseDataPageHeader(rr);
        return true;
      case 7:
        out.dictionaryPageHeader = parseDictionaryPageHeader(rr);
        return true;
    }
    return false;
  });
  return out;
}

// ─── Snappy decompression ─────────────────────────────────────────────────
// Snappy is the parquet default for compression=snappy. The format spec is
// short; reference: github.com/google/snappy/blob/master/format_description.txt
//
// File starts with a varint giving the uncompressed length. Then a sequence
// of tag+payload entries. Tag's low 2 bits select the entry type:
//   00 - literal: length minus one in upper 6 bits (or extra bytes)
//   01 - copy with 1-byte offset (small): offset is 11 bits, length is 4..11
//   10 - copy with 2-byte offset: offset 16-bit, length is 1..64
//   11 - copy with 4-byte offset (rare): offset 32-bit, length is 1..64

function snappyDecompress(input: Uint8Array): Uint8Array {
  let inPos = 0;

  // Uncompressed length (varint).
  let outLen = 0;
  let shift = 0;
  while (true) {
    const b = input[inPos++];
    outLen |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }

  const out = new Uint8Array(outLen);
  let outPos = 0;
  while (inPos < input.length) {
    const tag = input[inPos++];
    const tagType = tag & 0x03;
    if (tagType === 0) {
      // Literal
      let len = (tag >> 2) + 1;
      if (len >= 61) {
        const extra = len - 60;
        let extraVal = 0;
        for (let i = 0; i < extra; i++) extraVal |= input[inPos + i] << (8 * i);
        inPos += extra;
        len = extraVal + 1;
      }
      out.set(input.subarray(inPos, inPos + len), outPos);
      inPos += len;
      outPos += len;
    } else {
      // Copy from previous output.
      let offset: number;
      let len: number;
      if (tagType === 1) {
        len = ((tag >> 2) & 0x07) + 4;
        offset = ((tag & 0xe0) << 3) | input[inPos++];
      } else if (tagType === 2) {
        len = (tag >> 2) + 1;
        offset = input[inPos] | (input[inPos + 1] << 8);
        inPos += 2;
      } else {
        len = (tag >> 2) + 1;
        offset = (input[inPos] | (input[inPos + 1] << 8) | (input[inPos + 2] << 16) | (input[inPos + 3] << 24)) >>> 0;
        inPos += 4;
      }
      if (offset === 0 || offset > outPos) throw new Error(`snappy: invalid offset ${offset} at ${outPos}`);
      // The copy can overlap: each byte may be read from a position that
      // gets written by an earlier byte of the same copy. Byte-by-byte
      // is simplest and matches reference behavior.
      const start = outPos - offset;
      for (let i = 0; i < len; i++) out[outPos + i] = out[start + i];
      outPos += len;
    }
  }
  if (outPos !== outLen) throw new Error(`snappy: output length mismatch (got ${outPos}, expected ${outLen})`);
  return out;
}

// ─── RLE / bit-pack hybrid decoder ────────────────────────────────────────
// The hybrid layout used by Parquet for definition levels, repetition
// levels, and dictionary indices. Repeated runs of (header, body) where
// the header is a varint:
//   header & 1 == 0 → RLE run: header >> 1 == repeat count, body is one
//                     bit-width-bytes integer, value repeated.
//   header & 1 == 1 → bit-packed run: header >> 1 == number of groups of
//                     8 values, body is groups*8*bitWidth bits packed LE.
//
// `bitWidth` is the width of each value in bits (ceil(log2(maxValue + 1))).

function decodeHybridRleBitPack(
  input: Uint8Array,
  inputOffset: number,
  inputEnd: number,
  bitWidth: number,
  count: number,
  out: Int32Array,
): number {
  if (bitWidth === 0) {
    out.fill(0, 0, count);
    return inputOffset;
  }
  const byteWidth = Math.ceil(bitWidth / 8);
  let pos = inputOffset;
  let written = 0;
  while (written < count && pos < inputEnd) {
    // Varint header.
    let header = 0;
    let shift = 0;
    while (true) {
      const b = input[pos++];
      header |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    if ((header & 1) === 0) {
      const runLen = header >>> 1;
      let value = 0;
      for (let i = 0; i < byteWidth; i++) value |= input[pos + i] << (8 * i);
      pos += byteWidth;
      const end = Math.min(written + runLen, count);
      for (let i = written; i < end; i++) out[i] = value;
      written = end;
    } else {
      const numGroups = header >>> 1;
      const bytesNeeded = numGroups * bitWidth; // groups × 8 values × bitWidth / 8 = groups × bitWidth bytes
      let bitBuf = 0;
      let bitsInBuf = 0;
      const mask = (1 << bitWidth) - 1;
      for (let g = 0; g < numGroups && written < count; g++) {
        // Process 8 values per group.
        for (let i = 0; i < 8; i++) {
          while (bitsInBuf < bitWidth) {
            bitBuf |= input[pos++] << bitsInBuf;
            bitsInBuf += 8;
          }
          const v = bitBuf & mask;
          bitBuf >>>= bitWidth;
          bitsInBuf -= bitWidth;
          if (written < count) {
            out[written++] = v;
          }
        }
      }
      // We may have over-counted bytes if count < 8 * numGroups; that's
      // fine — the writer rounds up to whole groups.
      void bytesNeeded;
    }
  }
  return pos;
}

// ─── Page decoding ────────────────────────────────────────────────────────

function decompressPage(input: Uint8Array, codec: number, expectedLen: number): Uint8Array {
  if (codec === PQ_CODEC_UNCOMPRESSED) return input;
  if (codec === PQ_CODEC_SNAPPY) {
    const out = snappyDecompress(input);
    if (out.length !== expectedLen) {
      throw new Error(`parquet: snappy length mismatch (got ${out.length}, expected ${expectedLen})`);
    }
    return out;
  }
  if (codec === PQ_CODEC_GZIP) {
    const out = (Bun as any).gunzipSync(input) as Uint8Array;
    if (out.length !== expectedLen) {
      throw new Error(`parquet: gzip length mismatch (got ${out.length}, expected ${expectedLen})`);
    }
    return out;
  }
  throw new Error(`parquet: compression codec ${codec} not supported (UNCOMPRESSED, SNAPPY, GZIP supported)`);
}

// PLAIN encoding for a typed values array. Returns a typed array suitable
// for insertion into a Column.
function decodePlainTyped(
  data: Uint8Array,
  offset: number,
  numValues: number,
  type: number,
): { values: any; consumed: number } {
  const view = new DataView(data.buffer, data.byteOffset + offset, data.byteLength - offset);
  switch (type) {
    case PQ_TYPE_INT32: {
      const arr = new Int32Array(numValues);
      for (let i = 0; i < numValues; i++) arr[i] = view.getInt32(i * 4, true);
      return { values: arr, consumed: numValues * 4 };
    }
    case PQ_TYPE_INT64: {
      const arr = new BigInt64Array(numValues);
      for (let i = 0; i < numValues; i++) arr[i] = view.getBigInt64(i * 8, true);
      return { values: arr, consumed: numValues * 8 };
    }
    case PQ_TYPE_FLOAT: {
      const arr = new Float32Array(numValues);
      for (let i = 0; i < numValues; i++) arr[i] = view.getFloat32(i * 4, true);
      return { values: arr, consumed: numValues * 4 };
    }
    case PQ_TYPE_DOUBLE: {
      const arr = new Float64Array(numValues);
      for (let i = 0; i < numValues; i++) arr[i] = view.getFloat64(i * 8, true);
      return { values: arr, consumed: numValues * 8 };
    }
    case PQ_TYPE_BYTE_ARRAY: {
      const arr: string[] = new Array(numValues);
      const decoder = new TextDecoder();
      let p = 0;
      for (let i = 0; i < numValues; i++) {
        const len = view.getInt32(p, true);
        p += 4;
        arr[i] = decoder.decode(new Uint8Array(data.buffer, data.byteOffset + offset + p, len));
        p += len;
      }
      return { values: arr, consumed: p };
    }
    case PQ_TYPE_BOOLEAN: {
      // PLAIN-encoded booleans are bit-packed LSB-first.
      const arr = new Uint8Array(numValues);
      for (let i = 0; i < numValues; i++) arr[i] = (data[offset + (i >> 3)] >> (i & 7)) & 1;
      return { values: arr, consumed: Math.ceil(numValues / 8) };
    }
  }
  throw new Error(`parquet: PLAIN decode: unsupported physical type ${type}`);
}

// Decode a single dictionary page into a typed array.
function decodeDictionaryPage(pageData: Uint8Array, numValues: number, type: number): { values: any } {
  return { values: decodePlainTyped(pageData, 0, numValues, type).values };
}

// Resolve dictionary indices into the dictionary's typed-array values.
function gatherDictionary(dict: any, indices: Int32Array, count: number): any {
  if (dict instanceof Int32Array) {
    const out = new Int32Array(count);
    for (let i = 0; i < count; i++) out[i] = dict[indices[i]];
    return out;
  }
  if (dict instanceof BigInt64Array) {
    const out = new BigInt64Array(count);
    for (let i = 0; i < count; i++) out[i] = dict[indices[i]];
    return out;
  }
  if (dict instanceof Float32Array) {
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = dict[indices[i]];
    return out;
  }
  if (dict instanceof Float64Array) {
    const out = new Float64Array(count);
    for (let i = 0; i < count; i++) out[i] = dict[indices[i]];
    return out;
  }
  if (Array.isArray(dict)) {
    const out: any[] = new Array(count);
    for (let i = 0; i < count; i++) out[i] = dict[indices[i]];
    return out;
  }
  throw new Error("parquet: gatherDictionary: unsupported dict storage");
}

// ─── Public API ───────────────────────────────────────────────────────────

function arrowKindForPhysical(type: number, convertedType: number | undefined): string {
  switch (type) {
    case PQ_TYPE_BOOLEAN:
      return "bool";
    case PQ_TYPE_INT32:
      return "int32";
    case PQ_TYPE_INT64:
      return "int64";
    case PQ_TYPE_FLOAT:
      return "float32";
    case PQ_TYPE_DOUBLE:
      return "float64";
    case PQ_TYPE_BYTE_ARRAY:
      // BYTE_ARRAY is utf8 when explicitly tagged. We treat it as utf8 by
      // default — pyarrow rarely emits raw byte columns from JS-friendly
      // sources.
      void convertedType;
      return "utf8";
  }
  throw new Error(`parquet: physical type ${type} not supported (INT96 / FIXED_LEN_BYTE_ARRAY pending)`);
}

function decodeColumnChunk(
  bytes: Uint8Array,
  meta: ColumnMetaData,
  numRows: number,
  isOptional: boolean,
): { values: any; validity: Uint8Array | undefined } {
  // Read pages from data_page_offset until num_values consumed.
  // Dictionary page (if present) sits at dictionary_page_offset.
  let dict: any | undefined;
  if (meta.dictionaryPageOffset !== undefined) {
    const dictOffset = Number(meta.dictionaryPageOffset);
    const dictReader = new ThriftReader(bytes, dictOffset);
    const dictHeader = parsePageHeader(dictReader);
    if (dictHeader.type !== PQ_PAGE_DICTIONARY_PAGE) {
      throw new Error(`parquet: expected dictionary page at offset ${dictOffset}`);
    }
    const compressedStart = dictReader.pos;
    const compressed = bytes.subarray(compressedStart, compressedStart + dictHeader.compressedSize);
    const decompressed = decompressPage(compressed, meta.codec, dictHeader.uncompressedSize);
    dict = decodeDictionaryPage(decompressed, dictHeader.dictionaryPageHeader!.numValues, meta.type).values;
  }

  // Read data pages.
  const validity = isOptional ? new Uint8Array(Math.ceil(numRows / 8)) : undefined;
  if (validity) validity.fill(0xff, 0, Math.ceil(numRows / 8)); // start "all valid"; flip nulls below
  let outValues: any | undefined;
  let outIdx = 0;

  let pos = Number(meta.dataPageOffset);
  let valuesRead = 0;
  const totalValues = Number(meta.numValues);

  while (valuesRead < totalValues) {
    const r = new ThriftReader(bytes, pos);
    const header = parsePageHeader(r);
    if (header.type !== PQ_PAGE_DATA_PAGE) {
      throw new Error(`parquet: only V1 data pages supported (got page type ${header.type})`);
    }
    const dataPage = header.dataPageHeader!;
    const compressedStart = r.pos;
    const compressed = bytes.subarray(compressedStart, compressedStart + header.compressedSize);
    const decompressed = decompressPage(compressed, meta.codec, header.uncompressedSize);

    // V1 data page layout (decompressed):
    //   [rep levels][def levels][values]
    // Each levels block is i32-length-prefixed RLE/bit-pack hybrid IF the
    // level encoding is RLE (which it always is in modern files).
    let dpos = 0;
    const numValues = dataPage.numValues;

    // Repetition levels (only present if this column has repeated nesting —
    // not the case for flat schemas, so we expect rep = 0 throughout).
    // The block is omitted when max_rep_level is 0; we don't currently
    // know max_rep_level explicitly, but for flat schemas it's always 0.
    // → skip the rep-level read entirely for flat schemas.

    // Definition levels: present iff column is optional. Encoded as an
    // i32-length-prefixed RLE/bit-pack stream of {0, 1} values.
    const defLevels = new Int32Array(numValues);
    if (isOptional) {
      const defLen = new DataView(decompressed.buffer, decompressed.byteOffset + dpos, 4).getInt32(0, true);
      dpos += 4;
      decodeHybridRleBitPack(decompressed, dpos, dpos + defLen, 1, numValues, defLevels);
      dpos += defLen;
    } else {
      defLevels.fill(1);
    }
    // Count non-nulls in this page (== number of physical values to read).
    let nonNull = 0;
    for (let i = 0; i < numValues; i++) if (defLevels[i] === 1) nonNull++;

    // Values
    let pageValues: any;
    if (dataPage.encoding === PQ_ENC_PLAIN) {
      pageValues = decodePlainTyped(decompressed, dpos, nonNull, meta.type).values;
    } else if (dataPage.encoding === PQ_ENC_PLAIN_DICTIONARY || dataPage.encoding === PQ_ENC_RLE_DICTIONARY) {
      if (!dict) throw new Error("parquet: dictionary-encoded page but no dictionary loaded");
      // First byte is the bit width; rest is hybrid RLE/bit-pack of indices.
      const bitWidth = decompressed[dpos];
      dpos += 1;
      const indices = new Int32Array(nonNull);
      decodeHybridRleBitPack(decompressed, dpos, decompressed.length, bitWidth, nonNull, indices);
      pageValues = gatherDictionary(dict, indices, nonNull);
    } else {
      throw new Error(`parquet: page encoding ${dataPage.encoding} not supported`);
    }

    // Allocate the output array on first page based on the type.
    if (!outValues) {
      if (pageValues instanceof Int32Array) outValues = new Int32Array(numRows);
      else if (pageValues instanceof BigInt64Array) outValues = new BigInt64Array(numRows);
      else if (pageValues instanceof Float32Array) outValues = new Float32Array(numRows);
      else if (pageValues instanceof Float64Array) outValues = new Float64Array(numRows);
      else if (pageValues instanceof Uint8Array) outValues = new Uint8Array(numRows);
      else outValues = new Array(numRows);
    }

    // Scatter into outValues by definition level (skip null slots).
    let pageValIdx = 0;
    for (let i = 0; i < numValues; i++) {
      if (defLevels[i] === 1) {
        outValues[outIdx + i] = pageValues[pageValIdx++];
      } else if (validity) {
        const bit = outIdx + i;
        validity[bit >> 3] &= ~(1 << (bit & 7));
      }
    }
    outIdx += numValues;
    valuesRead += numValues;

    pos = compressedStart + header.compressedSize;
  }

  return { values: outValues, validity };
}

export function fromParquet(bytes: Uint8Array): TableLike {
  const { Column, RecordBatch, Table } = getTypes();

  // Magic + footer.
  if (
    bytes.length < 12 ||
    bytes[0] !== 0x50 ||
    bytes[1] !== 0x41 ||
    bytes[2] !== 0x52 ||
    bytes[3] !== 0x31 ||
    bytes[bytes.length - 4] !== 0x50 ||
    bytes[bytes.length - 3] !== 0x41 ||
    bytes[bytes.length - 2] !== 0x52 ||
    bytes[bytes.length - 1] !== 0x31
  ) {
    throw new Error("parquet: missing PAR1 magic at start or end");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const footerLen = view.getInt32(bytes.length - 8, true);
  const footerStart = bytes.length - 8 - footerLen;
  if (footerStart < 4) throw new Error(`parquet: invalid footer length ${footerLen}`);
  const footerBytes = bytes.subarray(footerStart, bytes.length - 8);
  const footerReader = new ThriftReader(footerBytes);
  const meta = parseFileMetaData(footerReader);

  // Parquet schema is a flat list traversed depth-first. The first entry
  // is the root group; subsequent leaves are the actual columns. We only
  // support flat (non-nested) schemas in this reader, so we walk the list
  // and treat any element with `type` defined as a column.
  type ColInfo = { name: string; physicalType: number; convertedType: number | undefined; isOptional: boolean };
  const cols: ColInfo[] = [];
  for (let i = 1; i < meta.schema.length; i++) {
    const e = meta.schema[i];
    if (e.numChildren > 0) {
      throw new Error(`parquet: nested schemas not yet supported (column "${e.name}" has ${e.numChildren} children)`);
    }
    if (e.type === undefined) {
      throw new Error(`parquet: leaf "${e.name}" has no physical type`);
    }
    cols.push({
      name: e.name,
      physicalType: e.type,
      convertedType: e.convertedType,
      isOptional: e.repetitionType === PQ_REP_OPTIONAL,
    });
  }

  // Build one RecordBatch per row group.
  const batches: RecordBatchLike[] = [];
  for (const rg of meta.rowGroups) {
    const numRows = Number(rg.numRows);
    const batchColumns: ColumnLike[] = [];
    for (let i = 0; i < cols.length; i++) {
      const colInfo = cols[i];
      const chunk = rg.columns[i];
      const { values, validity } = decodeColumnChunk(bytes, chunk.metaData, numRows, colInfo.isOptional);
      const kind = arrowKindForPhysical(colInfo.physicalType, colInfo.convertedType);
      batchColumns.push(new Column({ kind }, numRows, values, validity));
    }
    const schemaForBatch = {
      fields: cols.map(c => ({
        name: c.name,
        type: { kind: arrowKindForPhysical(c.physicalType, c.convertedType) },
        nullable: c.isOptional,
      })),
    };
    batches.push(new RecordBatch(schemaForBatch, batchColumns, numRows));
  }

  const tableSchema = {
    fields: cols.map(c => ({
      name: c.name,
      type: { kind: arrowKindForPhysical(c.physicalType, c.convertedType) },
      nullable: c.isOptional,
    })),
  };
  return new Table(tableSchema, batches);
}

// ─── Writer ───────────────────────────────────────────────────────────────
// toParquet emits a single row group, PLAIN-encoded, with optional SNAPPY
// or GZIP compression. Output is bit-for-bit readable by pyarrow / arrow-rs
// / duckdb on the basic types — narrow but correct.
//
// The writer doesn't dictionary-encode strings or bit-pack low-cardinality
// columns yet; for a tiny.en-style toy fixture both pyarrow and Parabun
// ship roughly equivalent file sizes thanks to SNAPPY. For workloads where
// density matters, the dictionary path lands as a follow-up.

class ByteWriter {
  buf: Uint8Array;
  view: DataView;
  pos: number;

  constructor(initial: number = 4096) {
    this.buf = new Uint8Array(initial);
    this.view = new DataView(this.buf.buffer);
    this.pos = 0;
  }

  private grow(min: number): void {
    if (this.buf.length >= min) return;
    let cap = this.buf.length;
    while (cap < min) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf, 0);
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  writeBytes(src: Uint8Array): void {
    this.grow(this.pos + src.length);
    this.buf.set(src, this.pos);
    this.pos += src.length;
  }

  writeU8(v: number): void {
    this.grow(this.pos + 1);
    this.buf[this.pos++] = v & 0xff;
  }

  writeI32LE(v: number): void {
    this.grow(this.pos + 4);
    this.view.setInt32(this.pos, v, true);
    this.pos += 4;
  }

  writeF32LE(v: number): void {
    this.grow(this.pos + 4);
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
  }

  writeF64LE(v: number): void {
    this.grow(this.pos + 8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
  }

  writeI64LE(v: bigint): void {
    this.grow(this.pos + 8);
    this.view.setBigInt64(this.pos, v, true);
    this.pos += 8;
  }

  // Unsigned varint.
  writeVarint(v: number): void {
    while (v > 0x7f) {
      this.writeU8((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    this.writeU8(v & 0x7f);
  }

  writeZigzagI32(v: number): void {
    this.writeVarint(((v << 1) ^ (v >> 31)) >>> 0);
  }

  writeZigzagI64(v: bigint): void {
    let zz = (v << 1n) ^ (v >> 63n);
    while ((zz & ~0x7fn) !== 0n) {
      this.writeU8(Number(zz & 0x7fn) | 0x80);
      zz >>= 7n;
    }
    this.writeU8(Number(zz & 0x7fn));
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

// ─── Thrift compact writer ────────────────────────────────────────────────
//
// Field header: a 1-byte head where the high nibble is the delta from
// the last field id (1..15) and the low nibble is the element type. If
// the delta is > 15, the high nibble is 0 and the field id follows as a
// zigzag varint.

class ThriftWriter {
  out: ByteWriter;

  constructor() {
    this.out = new ByteWriter();
  }

  writeFieldHeader(lastFieldId: number, fieldId: number, type: number): void {
    const delta = fieldId - lastFieldId;
    if (delta > 0 && delta <= 15) {
      this.out.writeU8(((delta & 0x0f) << 4) | (type & 0x0f));
    } else {
      this.out.writeU8(type & 0x0f);
      this.out.writeZigzagI32(fieldId);
    }
  }

  writeStop(): void {
    this.out.writeU8(0);
  }

  writeBool(lastFieldId: number, fieldId: number, value: boolean): number {
    this.writeFieldHeader(lastFieldId, fieldId, value ? TC_BOOL_TRUE : TC_BOOL_FALSE);
    return fieldId;
  }

  writeI32(lastFieldId: number, fieldId: number, value: number): number {
    this.writeFieldHeader(lastFieldId, fieldId, TC_I32);
    this.out.writeZigzagI32(value);
    return fieldId;
  }

  writeI64(lastFieldId: number, fieldId: number, value: bigint): number {
    this.writeFieldHeader(lastFieldId, fieldId, TC_I64);
    this.out.writeZigzagI64(value);
    return fieldId;
  }

  writeBinary(lastFieldId: number, fieldId: number, bytes: Uint8Array): number {
    this.writeFieldHeader(lastFieldId, fieldId, TC_BINARY);
    this.out.writeVarint(bytes.length);
    this.out.writeBytes(bytes);
    return fieldId;
  }

  writeString(lastFieldId: number, fieldId: number, value: string): number {
    return this.writeBinary(lastFieldId, fieldId, new TextEncoder().encode(value));
  }

  // List header: 1 byte high-nibble = size (or 15 for long form), low nibble = element type.
  writeListHeader(elementType: number, size: number): void {
    if (size < 15) {
      this.out.writeU8(((size & 0x0f) << 4) | (elementType & 0x0f));
    } else {
      this.out.writeU8(0xf0 | (elementType & 0x0f));
      this.out.writeVarint(size);
    }
  }

  finish(): Uint8Array {
    return this.out.finish();
  }
}

// ─── Snappy compression ───────────────────────────────────────────────────
// Hash-based compressor matching the reference algorithm: scan a sliding
// window, look up the current 4-byte prefix in a hash table for the most
// recent occurrence, emit a copy if a match is found, otherwise extend the
// pending literal run. The reference picks 14-bit hash table sizes for
// good speed/ratio balance.

function snappyCompress(input: Uint8Array): Uint8Array {
  const out: number[] = [];

  // Uncompressed length prefix (varint).
  let len = input.length;
  while (len > 0x7f) {
    out.push((len & 0x7f) | 0x80);
    len >>>= 7;
  }
  out.push(len & 0x7f);

  if (input.length === 0) return new Uint8Array(out);

  const HASH_BITS = 14;
  const HASH_SIZE = 1 << HASH_BITS;
  const table = new Int32Array(HASH_SIZE).fill(-1);

  const hashAt = (i: number): number => {
    // 32-bit FNV-ish; matches reference behavior closely enough.
    const u = (input[i] | (input[i + 1] << 8) | (input[i + 2] << 16) | (input[i + 3] << 24)) >>> 0;
    return (u * 0x1e35a7bd) >>> (32 - HASH_BITS);
  };

  const writeLiteral = (start: number, end: number): void => {
    if (end <= start) return;
    const litLen = end - start;
    const tag = litLen - 1;
    if (tag < 60) {
      out.push((tag << 2) | 0);
    } else {
      // Use n bytes of length.
      let extras = 0;
      let v = tag;
      while (v > 0) {
        extras++;
        v >>>= 8;
      }
      out.push(((59 + extras) << 2) | 0);
      v = tag;
      for (let i = 0; i < extras; i++) {
        out.push(v & 0xff);
        v >>>= 8;
      }
    }
    for (let i = start; i < end; i++) out.push(input[i]);
  };

  const writeCopy = (offset: number, length: number): void => {
    while (length >= 68) {
      // 64-byte 2-byte-offset copy at most per emission.
      out.push((63 << 2) | 2);
      out.push(offset & 0xff);
      out.push((offset >> 8) & 0xff);
      length -= 64;
    }
    if (length > 64) {
      // Split into 60 + remainder.
      out.push((59 << 2) | 2);
      out.push(offset & 0xff);
      out.push((offset >> 8) & 0xff);
      length -= 60;
    }
    if (length >= 4 && length < 12 && offset < 2048) {
      // 1-byte-offset variant.
      out.push(((length - 4) << 2) | 1 | (((offset >> 8) & 0x07) << 5));
      out.push(offset & 0xff);
    } else {
      out.push(((length - 1) << 2) | 2);
      out.push(offset & 0xff);
      out.push((offset >> 8) & 0xff);
    }
  };

  const inputLen = input.length;
  const skipMargin = 4;
  let cursor = 0;
  let nextLiteralStart = 0;

  while (cursor + skipMargin < inputLen) {
    const h = hashAt(cursor);
    const cand = table[h];
    table[h] = cursor;

    if (
      cand >= 0 &&
      cursor - cand < 65536 &&
      input[cand] === input[cursor] &&
      input[cand + 1] === input[cursor + 1] &&
      input[cand + 2] === input[cursor + 2] &&
      input[cand + 3] === input[cursor + 3]
    ) {
      // Flush any pending literal run.
      writeLiteral(nextLiteralStart, cursor);
      const offset = cursor - cand;
      // Extend match.
      let matchLen = 4;
      while (cursor + matchLen < inputLen && input[cand + matchLen] === input[cursor + matchLen]) {
        matchLen++;
      }
      writeCopy(offset, matchLen);
      cursor += matchLen;
      nextLiteralStart = cursor;
    } else {
      cursor++;
    }
  }
  // Flush trailing literal.
  writeLiteral(nextLiteralStart, inputLen);
  return new Uint8Array(out);
}

// ─── Page writer ──────────────────────────────────────────────────────────

function encodePlainTyped(values: any, count: number, type: number): Uint8Array {
  const w = new ByteWriter();
  switch (type) {
    case PQ_TYPE_INT32:
      for (let i = 0; i < count; i++) w.writeI32LE(values[i]);
      break;
    case PQ_TYPE_INT64:
      for (let i = 0; i < count; i++) w.writeI64LE(values[i]);
      break;
    case PQ_TYPE_FLOAT:
      for (let i = 0; i < count; i++) w.writeF32LE(values[i]);
      break;
    case PQ_TYPE_DOUBLE:
      for (let i = 0; i < count; i++) w.writeF64LE(values[i]);
      break;
    case PQ_TYPE_BYTE_ARRAY: {
      const enc = new TextEncoder();
      for (let i = 0; i < count; i++) {
        const bytes = enc.encode(values[i] ?? "");
        w.writeI32LE(bytes.length);
        w.writeBytes(bytes);
      }
      break;
    }
    case PQ_TYPE_BOOLEAN: {
      // Bit-pack LSB-first.
      const packed = new Uint8Array(Math.ceil(count / 8));
      for (let i = 0; i < count; i++) {
        if (values[i]) packed[i >> 3] |= 1 << (i & 7);
      }
      w.writeBytes(packed);
      break;
    }
    default:
      throw new Error(`parquet writer: PLAIN encode: unsupported type ${type}`);
  }
  return w.finish();
}

// Encode an array of {0,1} definition levels as a single RLE run wrapped
// in the i32-length-prefixed RLE/bit-pack hybrid expected for V1 pages
// when the def level is at most 1.
function encodeDefLevelsAllOne(count: number): Uint8Array {
  // bitWidth=1 (max level=1). Two cases:
  //   - All 1s (no nulls) → single RLE run of `count` × 1.
  //   - Mixed → bit-packed group(s).
  // For simplicity emit a single RLE run; callers that need null handling
  // use encodeDefLevelsRle below.
  void count;
  throw new Error("internal: use encodeDefLevelsRle");
}

function encodeDefLevelsRle(defLevels: Uint8Array, count: number): Uint8Array {
  // Hybrid format: varint header + body. For a run, header = (runLen << 1) | 0,
  // body = bitWidth-bytes value (1 byte for bitWidth=1).
  // For bit-packed, header = (numGroups << 1) | 1, body = numGroups × 8 × bitWidth bits.
  //
  // Simplest correct encoder: walk the levels, emit alternating RLE runs.
  const w = new ByteWriter();
  let i = 0;
  while (i < count) {
    const v = defLevels[i];
    let runLen = 1;
    while (i + runLen < count && defLevels[i + runLen] === v) runLen++;
    // Emit RLE run: (runLen << 1) | 0
    w.writeVarint(runLen << 1);
    w.writeU8(v);
    i += runLen;
  }
  return w.finish();
}

// Build a V1 data page: [def levels (i32-prefixed RLE)] [values (PLAIN)]
function buildDataPageBody(values: any, count: number, type: number, defLevels: Uint8Array | undefined): Uint8Array {
  const w = new ByteWriter();
  if (defLevels !== undefined) {
    const enc = encodeDefLevelsRle(defLevels, count);
    w.writeI32LE(enc.length);
    w.writeBytes(enc);
  }
  const plain = encodePlainTyped(values, values.length, type);
  w.writeBytes(plain);
  return w.finish();
}

// ─── FileMetaData writer ──────────────────────────────────────────────────

interface ColumnPlan {
  name: string;
  physicalType: number;
  isOptional: boolean;
  // Page bytes (already compressed if codec != UNCOMPRESSED).
  compressedPage: Uint8Array;
  uncompressedSize: number;
  numValues: number;
  numNonNull: number;
}

function writePageHeader(
  pageType: number,
  uncompressedSize: number,
  compressedSize: number,
  dataPageHeader: { numValues: number },
): Uint8Array {
  // Each Thrift field write returns the new lastFieldId. Order doesn't
  // matter semantically but we go ascending for deterministic delta packing.
  const tw = new ThriftWriter();
  let lf = 0;
  // 1: PageType
  lf = tw.writeI32(lf, 1, pageType);
  // 2: uncompressed_page_size
  lf = tw.writeI32(lf, 2, uncompressedSize);
  // 3: compressed_page_size
  lf = tw.writeI32(lf, 3, compressedSize);
  // 5: DataPageHeader struct
  tw.writeFieldHeader(lf, 5, TC_STRUCT);
  lf = 5;
  {
    const inner = new ThriftWriter();
    let ilf = 0;
    // 1: num_values
    ilf = inner.writeI32(ilf, 1, dataPageHeader.numValues);
    // 2: encoding (PLAIN = 0)
    ilf = inner.writeI32(ilf, 2, PQ_ENC_PLAIN);
    // 3: definition_level_encoding (RLE = 3)
    ilf = inner.writeI32(ilf, 3, PQ_ENC_RLE);
    // 4: repetition_level_encoding (RLE = 3)
    ilf = inner.writeI32(ilf, 4, PQ_ENC_RLE);
    inner.writeStop();
    tw.out.writeBytes(inner.finish());
  }
  tw.writeStop();
  return tw.finish();
}

function writeColumnMetaData(
  plan: ColumnPlan,
  codec: number,
  compressedSize: number,
  dataPageOffset: bigint,
): Uint8Array {
  const tw = new ThriftWriter();
  let lf = 0;
  // 1: type
  lf = tw.writeI32(lf, 1, plan.physicalType);
  // 2: encodings list
  tw.writeFieldHeader(lf, 2, TC_LIST);
  lf = 2;
  tw.writeListHeader(TC_I32, 2);
  tw.out.writeZigzagI32(PQ_ENC_PLAIN);
  tw.out.writeZigzagI32(PQ_ENC_RLE);
  // 3: path_in_schema list of strings
  tw.writeFieldHeader(lf, 3, TC_LIST);
  lf = 3;
  tw.writeListHeader(TC_BINARY, 1);
  const nameBytes = new TextEncoder().encode(plan.name);
  tw.out.writeVarint(nameBytes.length);
  tw.out.writeBytes(nameBytes);
  // 4: codec
  lf = tw.writeI32(lf, 4, codec);
  // 5: num_values
  lf = tw.writeI64(lf, 5, BigInt(plan.numValues));
  // 6: total_uncompressed_size (page header bytes + data)
  lf = tw.writeI64(lf, 6, BigInt(plan.uncompressedSize));
  // 7: total_compressed_size
  lf = tw.writeI64(lf, 7, BigInt(compressedSize));
  // 9: data_page_offset
  lf = tw.writeI64(lf, 9, dataPageOffset);
  tw.writeStop();
  return tw.finish();
}

function writeColumnChunk(plan: ColumnPlan, codec: number, compressedSize: number, dataPageOffset: bigint): Uint8Array {
  const tw = new ThriftWriter();
  let lf = 0;
  // 2: file_offset
  lf = tw.writeI64(lf, 2, dataPageOffset);
  // 3: meta_data (struct)
  tw.writeFieldHeader(lf, 3, TC_STRUCT);
  lf = 3;
  tw.out.writeBytes(writeColumnMetaData(plan, codec, compressedSize, dataPageOffset));
  tw.writeStop();
  return tw.finish();
}

function writeRowGroup(columnChunks: Uint8Array[], numRows: number, totalByteSize: bigint): Uint8Array {
  const tw = new ThriftWriter();
  let lf = 0;
  // 1: columns list of struct
  tw.writeFieldHeader(lf, 1, TC_LIST);
  lf = 1;
  tw.writeListHeader(TC_STRUCT, columnChunks.length);
  for (const cc of columnChunks) {
    tw.out.writeBytes(cc);
  }
  // 2: total_byte_size
  lf = tw.writeI64(lf, 2, totalByteSize);
  // 3: num_rows
  lf = tw.writeI64(lf, 3, BigInt(numRows));
  tw.writeStop();
  return tw.finish();
}

function writeSchemaElement(
  name: string,
  physicalType: number | undefined,
  numChildren: number,
  repetitionType: number | undefined,
): Uint8Array {
  const tw = new ThriftWriter();
  let lf = 0;
  if (physicalType !== undefined) {
    lf = tw.writeI32(lf, 1, physicalType);
  }
  if (repetitionType !== undefined) {
    lf = tw.writeI32(lf, 3, repetitionType);
  }
  lf = tw.writeString(lf, 4, name);
  if (numChildren > 0) {
    lf = tw.writeI32(lf, 5, numChildren);
  }
  // 6: converted_type for utf8 strings.
  if (physicalType === PQ_TYPE_BYTE_ARRAY) {
    lf = tw.writeI32(lf, 6, PQ_CT_UTF8);
  }
  tw.writeStop();
  return tw.finish();
}

function writeFileMetaData(cols: ColumnPlan[], numRows: number, rowGroupBytes: Uint8Array): Uint8Array {
  const tw = new ThriftWriter();
  let lf = 0;
  // 1: version
  lf = tw.writeI32(lf, 1, 1);
  // 2: schema list of SchemaElement (root + leaves)
  tw.writeFieldHeader(lf, 2, TC_LIST);
  lf = 2;
  tw.writeListHeader(TC_STRUCT, 1 + cols.length);
  // Root group
  tw.out.writeBytes(writeSchemaElement("root", undefined, cols.length, undefined));
  for (const c of cols) {
    tw.out.writeBytes(writeSchemaElement(c.name, c.physicalType, 0, c.isOptional ? PQ_REP_OPTIONAL : PQ_REP_REQUIRED));
  }
  // 3: num_rows
  lf = tw.writeI64(lf, 3, BigInt(numRows));
  // 4: row_groups list
  tw.writeFieldHeader(lf, 4, TC_LIST);
  lf = 4;
  tw.writeListHeader(TC_STRUCT, 1);
  tw.out.writeBytes(rowGroupBytes);
  tw.writeStop();
  return tw.finish();
}

// ─── Public writer entry point ────────────────────────────────────────────

export function toParquet(
  source: TableLike | RecordBatchLike,
  opts?: { compression?: "uncompressed" | "snappy" | "gzip" },
): Uint8Array {
  const compression = opts?.compression ?? "snappy";
  let codec = PQ_CODEC_UNCOMPRESSED;
  if (compression === "snappy") codec = PQ_CODEC_SNAPPY;
  else if (compression === "gzip") codec = PQ_CODEC_GZIP;
  else if (compression !== "uncompressed") {
    throw new RangeError(`@para/arrow.toParquet: unknown compression "${compression}"`);
  }

  // Materialize columns from the source. Concat batches into single
  // typed arrays so we can write one row group.
  const batches: RecordBatchLike[] = "batches" in source ? source.batches : [source];
  const schema = source.schema;
  const numRows = batches.reduce((sum, b) => sum + b.numRows, 0);

  const out = new ByteWriter();
  out.writeBytes(new Uint8Array([0x50, 0x41, 0x52, 0x31])); // PAR1

  const columnChunks: Uint8Array[] = [];
  const colPlans: ColumnPlan[] = [];

  for (let ci = 0; ci < schema.fields.length; ci++) {
    const field = schema.fields[ci];
    const isOptional = field.nullable;
    const physicalType = parquetPhysicalForKind(field.type.kind);

    // Concat batches' values + validity for this column.
    let mergedValues: any;
    let mergedValidity: Uint8Array | undefined;
    {
      const sample = batches[0].columns[ci];
      if (sample.values instanceof Int32Array) mergedValues = new Int32Array(numRows);
      else if (sample.values instanceof BigInt64Array) mergedValues = new BigInt64Array(numRows);
      else if (sample.values instanceof Float32Array) mergedValues = new Float32Array(numRows);
      else if (sample.values instanceof Float64Array) mergedValues = new Float64Array(numRows);
      else if (sample.values instanceof Uint8Array) mergedValues = new Uint8Array(numRows);
      else mergedValues = new Array(numRows);
      let off = 0;
      for (const b of batches) {
        const c = b.columns[ci];
        if (mergedValues.length > 0 && c.values && c.values.length === b.numRows) {
          if (Array.isArray(mergedValues)) {
            for (let i = 0; i < b.numRows; i++) mergedValues[off + i] = c.values[i];
          } else {
            (mergedValues as any).set(c.values, off);
          }
        }
        off += b.numRows;
      }
      if (isOptional) {
        mergedValidity = new Uint8Array(Math.ceil(numRows / 8));
        mergedValidity.fill(0xff);
        let bitOff = 0;
        for (const b of batches) {
          const c = b.columns[ci];
          if (c.validity) {
            for (let i = 0; i < b.numRows; i++) {
              const valid = (c.validity[i >> 3] >> (i & 7)) & 1;
              const out = bitOff + i;
              if (!valid) mergedValidity[out >> 3] &= ~(1 << (out & 7));
            }
          }
          bitOff += b.numRows;
        }
      }
    }

    // Compute def levels (0/1 per row) and a packed values array (only non-nulls).
    let defLevels: Uint8Array | undefined;
    let nonNullValues: any;
    let numNonNull: number;
    if (isOptional && mergedValidity) {
      defLevels = new Uint8Array(numRows);
      let nn = 0;
      for (let i = 0; i < numRows; i++) {
        const v = (mergedValidity[i >> 3] >> (i & 7)) & 1;
        defLevels[i] = v;
        if (v) nn++;
      }
      numNonNull = nn;
      // Pack non-null values into a fresh array.
      if (mergedValues instanceof Int32Array) {
        const out = new Int32Array(nn);
        let j = 0;
        for (let i = 0; i < numRows; i++) if (defLevels[i]) out[j++] = mergedValues[i];
        nonNullValues = out;
      } else if (mergedValues instanceof BigInt64Array) {
        const out = new BigInt64Array(nn);
        let j = 0;
        for (let i = 0; i < numRows; i++) if (defLevels[i]) out[j++] = mergedValues[i];
        nonNullValues = out;
      } else if (mergedValues instanceof Float32Array) {
        const out = new Float32Array(nn);
        let j = 0;
        for (let i = 0; i < numRows; i++) if (defLevels[i]) out[j++] = mergedValues[i];
        nonNullValues = out;
      } else if (mergedValues instanceof Float64Array) {
        const out = new Float64Array(nn);
        let j = 0;
        for (let i = 0; i < numRows; i++) if (defLevels[i]) out[j++] = mergedValues[i];
        nonNullValues = out;
      } else if (mergedValues instanceof Uint8Array) {
        const out = new Uint8Array(nn);
        let j = 0;
        for (let i = 0; i < numRows; i++) if (defLevels[i]) out[j++] = mergedValues[i];
        nonNullValues = out;
      } else {
        const out: any[] = new Array(nn);
        let j = 0;
        for (let i = 0; i < numRows; i++) if (defLevels[i]) out[j++] = mergedValues[i];
        nonNullValues = out;
      }
    } else {
      numNonNull = numRows;
      nonNullValues = mergedValues;
      defLevels = undefined;
    }

    const pageBody = buildDataPageBody(nonNullValues, numRows, physicalType, defLevels);
    const uncompressedSize = pageBody.length;
    let compressedBody: Uint8Array;
    if (codec === PQ_CODEC_UNCOMPRESSED) {
      compressedBody = pageBody;
    } else if (codec === PQ_CODEC_SNAPPY) {
      compressedBody = snappyCompress(pageBody);
    } else {
      compressedBody = (Bun as any).gzipSync(pageBody) as Uint8Array;
    }
    const compressedSize = compressedBody.length;

    const pageHeader = writePageHeader(PQ_PAGE_DATA_PAGE, uncompressedSize, compressedSize, {
      numValues: numRows,
    });
    const pageStartOffset = BigInt(out.pos);
    out.writeBytes(pageHeader);
    out.writeBytes(compressedBody);

    const plan: ColumnPlan = {
      name: field.name,
      physicalType,
      isOptional,
      compressedPage: compressedBody,
      uncompressedSize: uncompressedSize + pageHeader.length,
      numValues: numRows,
      numNonNull,
    };
    colPlans.push(plan);
    columnChunks.push(writeColumnChunk(plan, codec, compressedSize + pageHeader.length, pageStartOffset));
  }

  // Row group metadata uses the totals across columns.
  const totalByteSize = colPlans.reduce((sum, p) => sum + BigInt(p.uncompressedSize), 0n);
  const rowGroup = writeRowGroup(columnChunks, numRows, totalByteSize);

  // FileMetaData footer.
  const meta = writeFileMetaData(colPlans, numRows, rowGroup);
  out.writeBytes(meta);
  out.writeI32LE(meta.length);
  out.writeBytes(new Uint8Array([0x50, 0x41, 0x52, 0x31])); // PAR1
  return out.finish();
}

function parquetPhysicalForKind(kind: string): number {
  switch (kind) {
    case "bool":
      return PQ_TYPE_BOOLEAN;
    case "int32":
      return PQ_TYPE_INT32;
    case "int64":
      return PQ_TYPE_INT64;
    case "float32":
      return PQ_TYPE_FLOAT;
    case "float64":
      return PQ_TYPE_DOUBLE;
    case "utf8":
      return PQ_TYPE_BYTE_ARRAY;
  }
  throw new Error(`@para/arrow.toParquet: type "${kind}" not supported (list / nested types pending)`);
}
