import { describe, expect, test } from "bun:test";
import csv from "../src/index";

const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
};

describe("parseCsv basics", () => {
  test("default headers + type inference", async () => {
    const rows = await collect(csv.parseCsv("id,name,score\n1,ada,9.5\n2,grace,8.5\n"));
    expect(rows).toEqual([
      { id: 1, name: "ada", score: 9.5 },
      { id: 2, name: "grace", score: 8.5 },
    ]);
  });

  test("headers:false yields arrays", async () => {
    const rows = await collect(csv.parseCsv("a,b\n1,2\n", { headers: false, typeInference: false }));
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  test("doubled-quote escape preserves quote inside quoted field", async () => {
    const rows = await collect(csv.parseCsv('a,b\n"x","q""r"\n', { typeInference: false }));
    expect(rows).toEqual([{ a: "x", b: 'q"r' }]);
  });

  test("multi-line quoted field", async () => {
    const rows = await collect(csv.parseCsv('a,b\n"line1\nline2",x\n', { typeInference: false }));
    expect(rows).toEqual([{ a: "line1\nline2", b: "x" }]);
  });

  test("CRLF and lone CR both terminate rows", async () => {
    const rows = await collect(csv.parseCsv("a,b\r\n1,2\r3,4\r\n", { typeInference: false }));
    expect(rows).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });
});

describe("dialect: BOM / comment / trim / skipEmptyLines / escape", () => {
  test("UTF-8 BOM stripped from first header", async () => {
    const rows = await collect(csv.parseCsv("﻿a,b\n1,2\n"));
    expect(rows).toEqual([{ a: 1, b: 2 }]);
  });

  test("comment lines skipped", async () => {
    const rows = await collect(csv.parseCsv("# top comment\nfoo,bar\n# mid comment\n1,2\n", { comment: "#" }));
    expect(rows).toEqual([{ foo: 1, bar: 2 }]);
  });

  test("trim applies to unquoted cells but not quoted", async () => {
    const rows = await collect(
      csv.parseCsv('a,b\n  hi  ,  3  \n"  pad  ",  4  \n', { trim: true, typeInference: false }),
    );
    expect(rows).toEqual([
      { a: "hi", b: "3" },
      { a: "  pad  ", b: "4" },
    ]);
  });

  test("skipEmptyLines defaults to true", async () => {
    const rows = await collect(csv.parseCsv("a,b\n1,2\n\n\n3,4\n"));
    expect(rows).toEqual([
      { a: 1, b: 2 },
      { a: 3, b: 4 },
    ]);
  });

  test("skipEmptyLines:false surfaces blank rows", async () => {
    const rows = await collect(
      csv.parseCsv("1,2\n\n3,4\n", { headers: false, skipEmptyLines: false, typeInference: false }),
    );
    expect(rows).toEqual([["1", "2"], [], ["3", "4"]]);
  });

  test("backslash escape (escape !== quote)", async () => {
    const rows = await collect(csv.parseCsv('a,b\n"x\\"y","z"\n', { escape: "\\", typeInference: false }));
    expect(rows).toEqual([{ a: 'x"y', b: "z" }]);
  });

  test("unterminated quoted field throws", async () => {
    await expect(collect(csv.parseCsv('a,b\n"open,'))).rejects.toThrow(/unterminated/);
  });
});

describe("delimiter auto-detect", () => {
  test('delimiter:"" picks comma', async () => {
    const rows = await collect(csv.parseCsv("a,b,c\n1,2,3\n", { delimiter: "" }));
    expect(rows).toEqual([{ a: 1, b: 2, c: 3 }]);
  });

  test('delimiter:"" picks tab for TSV', async () => {
    const rows = await collect(csv.parseCsv("a\tb\tc\n1\t2\t3\n", { delimiter: "" }));
    expect(rows).toEqual([{ a: 1, b: 2, c: 3 }]);
  });

  test('delimiter:"" picks semicolon', async () => {
    const rows = await collect(csv.parseCsv("a;b;c\n1;2;3\n", { delimiter: "" }));
    expect(rows).toEqual([{ a: 1, b: 2, c: 3 }]);
  });

  test('delimiter:"" picks pipe', async () => {
    const rows = await collect(csv.parseCsv("a|b|c\n1|2|3\n", { delimiter: "" }));
    expect(rows).toEqual([{ a: 1, b: 2, c: 3 }]);
  });

  test("auto-detect ignores delimiter chars inside quoted regions", async () => {
    // The header has ZERO commas outside quotes — only the embedded
    // ",,,,," inside the quoted cell — and four real tabs. Auto-detect
    // should pick tab.
    const rows = await collect(csv.parseCsv('a\t"b,,,,,c"\td\te\n1\t2\t3\t4\n', { delimiter: "" }));
    expect(rows).toEqual([{ a: 1, "b,,,,,c": 2, d: 3, e: 4 }]);
  });

  test("auto-detect skips comment lines before sampling", async () => {
    const rows = await collect(csv.parseCsv("# notes\na;b\n1;2\n", { delimiter: "", comment: "#" }));
    expect(rows).toEqual([{ a: 1, b: 2 }]);
  });
});

describe("transformHeader / transform", () => {
  test("transformHeader rewrites object keys", async () => {
    const rows = await collect(
      csv.parseCsv("First Name,Last Name\nada,lovelace\n", {
        transformHeader: h => h.toLowerCase().replace(/\s+/g, "_"),
        typeInference: false,
      }),
    );
    expect(rows).toEqual([{ first_name: "ada", last_name: "lovelace" }]);
  });

  test("transform rewrites cell values per column name", async () => {
    const rows = await collect(
      csv.parseCsv("name,score\nada,9.5\n", {
        transform: (v, col) => (col === "name" ? v.toUpperCase() : v),
        typeInference: false,
      }),
    );
    expect(rows).toEqual([{ name: "ADA", score: "9.5" }]);
  });

  test("transform receives column index when headers:false", async () => {
    const seen: Array<[string, number]> = [];
    await collect(
      csv.parseCsv("x,y\n", {
        headers: false,
        typeInference: false,
        transform: (v, col) => {
          seen.push([v, col as number]);
          return v;
        },
      }),
    );
    expect(seen).toEqual([
      ["x", 0],
      ["y", 1],
    ]);
  });

  test("transform runs before typeInference", async () => {
    const rows = await collect(csv.parseCsv("n\n5\n", { transform: v => `${v}.5` }));
    expect(rows).toEqual([{ n: 5.5 }]);
  });
});

describe("maxRows", () => {
  test("parseCsv stops after maxRows data rows", async () => {
    const rows = await collect(csv.parseCsv("a\n1\n2\n3\n4\n", { maxRows: 2 }));
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
  });

  test("parseColumns honors maxRows", async () => {
    const cols = await csv.parseColumns("v\n1\n2\n3\n4\n", {
      schema: { v: "i32" },
      maxRows: 2,
    });
    expect(Array.from(cols.v)).toEqual([1, 2]);
  });

  test("reduceColumns honors maxRows", async () => {
    const stats = await csv.reduceColumns("v\n1\n2\n3\n4\n", {
      schema: { v: "f64" },
      reducers: { v: ["count", "sum"] as const },
      maxRows: 3,
    });
    expect(stats.v).toEqual({ count: 3, sum: 6 });
  });

  test("parseBatches honors maxRows mid-batch", async () => {
    const batches: number[][] = [];
    for await (const b of csv.parseBatches("v\n1\n2\n3\n4\n5\n", {
      schema: { v: "i32" },
      batchSize: 2,
      maxRows: 3,
    })) {
      batches.push(Array.from(b.v));
    }
    expect(batches).toEqual([[1, 2], [3]]);
  });
});

describe("parseColumns / parseBatches / reduceColumns", () => {
  test("parseColumns produces typed arrays", async () => {
    const cols = await csv.parseColumns("ts,v\n100,1.5\n200,2.5\n", {
      schema: { ts: "f64", v: "f32" },
    });
    expect(cols.ts).toBeInstanceOf(Float64Array);
    expect(cols.v).toBeInstanceOf(Float32Array);
    expect(Array.from(cols.ts)).toEqual([100, 200]);
  });

  test("parseColumns transformHeader maps schema lookup", async () => {
    const cols = await csv.parseColumns("Sensor ID,Temperature\n7,21.5\n", {
      schema: { sensor_id: "i32", temperature: "f32" },
      transformHeader: h => h.toLowerCase().replace(/\s+/g, "_"),
    });
    expect(Array.from(cols.sensor_id)).toEqual([7]);
  });

  test("parseBatches yields fixed-size + tight-fit final batch", async () => {
    const seenLengths: number[] = [];
    for await (const b of csv.parseBatches("v\n1\n2\n3\n4\n5\n", {
      schema: { v: "i32" },
      batchSize: 2,
    })) {
      seenLengths.push(b.v.length);
    }
    expect(seenLengths).toEqual([2, 2, 1]);
  });

  test("reduceColumns aggregates count/sum/min/max/mean/stddev", async () => {
    const stats = await csv.reduceColumns("x\n1\n2\n3\n4\n5\n", {
      schema: { x: "f64" },
      reducers: { x: ["count", "sum", "min", "max", "mean", "stddev"] as const },
    });
    expect(stats.x.count).toBe(5);
    expect(stats.x.sum).toBe(15);
    expect(stats.x.min).toBe(1);
    expect(stats.x.max).toBe(5);
    expect(stats.x.mean).toBe(3);
    // stddev of 1..5 (sample) ≈ 1.5811
    expect(stats.x.stddev).toBeCloseTo(1.5811, 3);
  });
});

describe("stringify", () => {
  test("object rows infer header row from key union", () => {
    const out = csv.stringify([
      { a: 1, b: "hi" },
      { a: 2, b: "there" },
    ]);
    expect(out).toBe("a,b\r\n1,hi\r\n2,there");
  });

  test("array rows omit header row by default", () => {
    const out = csv.stringify([
      [1, 2],
      [3, 4],
    ]);
    expect(out).toBe("1,2\r\n3,4");
  });

  test("array rows + explicit headers", () => {
    const out = csv.stringify(
      [
        [1, 2],
        [3, 4],
      ],
      { headers: ["x", "y"] },
    );
    expect(out).toBe("x,y\r\n1,2\r\n3,4");
  });

  test("quotes commas, quotes, and newlines", () => {
    const out = csv.stringify([{ a: "x,y", b: 'q"r', c: "lf\nin" }]);
    expect(out).toBe('a,b,c\r\n"x,y","q""r","lf\nin"');
  });

  test("backslash escape mode", () => {
    const out = csv.stringify([{ a: 'q"r' }], { escape: "\\" });
    expect(out).toBe('a\r\n"q\\"r"');
  });

  test("null / undefined become empty cells", () => {
    const out = csv.stringify([{ a: null, b: undefined, c: 0 }]);
    expect(out).toBe("a,b,c\r\n,,0");
  });

  test("Date stringifies as ISO 8601", () => {
    const d = new Date("2026-01-01T00:00:00.000Z");
    const out = csv.stringify([{ ts: d }]);
    expect(out).toBe("ts\r\n2026-01-01T00:00:00.000Z");
  });

  test("custom newline", () => {
    const out = csv.stringify([{ a: 1 }, { a: 2 }], { newline: "\n" });
    expect(out).toBe("a\n1\n2");
  });

  test("BOM prefix", () => {
    const out = csv.stringify([{ a: 1 }], { bom: true });
    expect(out).toBe("﻿a\r\n1");
  });

  test("round-trips through parseCsv", async () => {
    const original = [
      { id: 1, name: "Ada, Lovelace", note: 'said "hi"' },
      { id: 2, name: "Grace", note: "ok" },
    ];
    const text = csv.stringify(original);
    const back = await collect(csv.parseCsv(text));
    expect(back).toEqual(original);
  });
});
