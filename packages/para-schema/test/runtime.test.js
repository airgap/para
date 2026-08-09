import { describe, expect, test } from "bun:test";
import { fromSchema } from "../src/runtime.js";

const ok = (r) => r.tag === "Ok";
const err = (r) => (r.tag === "Err" ? r.error : null);

describe("decoration", () => {
	test("spreads the body's keys, hides the added members", () => {
		const s = fromSchema({ type: "object", properties: { a: { type: "string" } }, required: ["a"] });
		expect(s.type).toBe("object");
		expect(s.required).toEqual(["a"]);
		// A spread must yield a plain JSON Schema again. Never drag `parse` into
		// a schema literal that embeds this one.
		expect(Object.keys({ ...s }).sort()).toEqual(["properties", "required", "type"]);
		expect(typeof s.parse).toBe("function");
		expect(typeof s.validate).toBe("function");
		expect(typeof s.is).toBe("function");
		expect(s.schema).toEqual({ type: "object", properties: { a: { type: "string" } }, required: ["a"] });
	});

	test("parse returns the Result shape para-sync gates on", () => {
		const s = fromSchema({ type: "string" });
		expect(s.parse("hi")).toEqual({ tag: "Ok", value: "hi" });
		expect(s.parse(3)).toEqual({ tag: "Err", error: "expected string" });
		expect(s.is("hi")).toBe(true);
		expect(s.is(3)).toBe(false);
	});

	test("field accessors navigate an object schema", () => {
		const s = fromSchema({
			type: "object",
			properties: { profile: { type: "object", properties: { bio: { type: "string", maxLength: 3 } } } },
		});
		expect(s.profile.bio.maxLength).toBe(3);
		expect(ok(s.profile.parse({ bio: "ab" }))).toBe(true);
		expect(err(s.profile.parse({ bio: "abcd" }))).toBe("bio: longer than maxLength 3");
	});

	test("array schemas expose .element", () => {
		const s = fromSchema({ type: "object", properties: { tags: { type: "array", items: { type: "string" } } } });
		expect(s.tags.element.type).toBe("string");
	});
});

describe("strings", () => {
	const s = fromSchema({ type: "string", minLength: 2, maxLength: 5, pattern: "^[a-z]+$" });
	test("accepts in-range", () => expect(ok(s.parse("abc"))).toBe(true));
	test("minLength", () => expect(err(s.parse("a"))).toBe("shorter than minLength 2"));
	test("maxLength", () => expect(err(s.parse("abcdef"))).toBe("longer than maxLength 5"));
	test("pattern", () => expect(err(s.parse("AB"))).toBe("does not match pattern ^[a-z]+$"));
	test("format", () => {
		const e = fromSchema({ type: "string", format: "email" });
		expect(ok(e.parse("a@b.co"))).toBe(true);
		expect(err(e.parse("nope"))).toBe("expected format email");
	});
	test("the pg string aliases are the same arm", () => {
		for (const type of ["varchar", "text", "char"]) {
			const a = fromSchema({ type, maxLength: 2 });
			expect(ok(a.parse("ab"))).toBe(true);
			expect(err(a.parse("abc"))).toBe("longer than maxLength 2");
			expect(err(a.parse(7))).toBe("expected string");
		}
	});
});

describe("integers / bigints", () => {
	test("bigint accepts BigInt (pg driver) and integer Number (JSON)", () => {
		const s = fromSchema({ type: "bigint" });
		expect(ok(s.parse(7n))).toBe(true);
		expect(ok(s.parse(7))).toBe(true);
		expect(err(s.parse(7.5))).toBe("expected integer");
		expect(err(s.parse("7"))).toBe("expected integer");
	});

	test("bounds coerce to the shape of the value, both directions", () => {
		const s = fromSchema({ type: "bigint", minimum: 0n, maximum: 10n });
		expect(ok(s.parse(5n))).toBe(true);
		expect(ok(s.parse(5))).toBe(true); // Number value, BigInt bound
		expect(err(s.parse(-1n))).toBe("below minimum 0");
		expect(err(s.parse(11))).toBe("above maximum 10");
	});

	test("snowflake is the same arm as bigint", () => {
		const s = fromSchema({ type: "snowflake" });
		expect(ok(s.parse(7480751273977841083n))).toBe(true);
		expect(err(s.parse({}))).toBe("expected integer");
	});

	test("exclusive bounds", () => {
		const s = fromSchema({ type: "integer", exclusiveMinimum: 0, exclusiveMaximum: 3 });
		expect(ok(s.parse(1))).toBe(true);
		expect(err(s.parse(0))).toBe("must be > exclusiveMinimum 0");
		expect(err(s.parse(3))).toBe("must be < exclusiveMaximum 3");
	});
});

describe("numbers, booleans, dates", () => {
	test("number rejects a non-number", () => {
		const s = fromSchema({ type: "number", minimum: 1 });
		expect(ok(s.parse(1.5))).toBe(true);
		expect(err(s.parse(0.5))).toBe("below minimum 1");
		expect(err(s.parse("1.5"))).toBe("expected number");
	});

	test("boolean", () => {
		const s = fromSchema({ type: "boolean" });
		expect(ok(s.parse(false))).toBe(true);
		expect(err(s.parse(0))).toBe("expected boolean");
	});

	// The arm ParaBun's validator is missing entirely: `date` is what lockstep
	// emits for every temporal column, so without this a timestamp field is
	// unchecked.
	test("date accepts a Date or an ISO string, rejects junk", () => {
		for (const type of ["date", "timestamp", "timestamptz"]) {
			const s = fromSchema({ type });
			expect(ok(s.parse(new Date()))).toBe(true);
			expect(ok(s.parse("2026-07-13T00:00:00Z"))).toBe(true);
			expect(err(s.parse("not a date"))).toBe("expected timestamp");
			expect(err(s.parse(new Date("garbage")))).toBe("expected timestamp");
			expect(err(s.parse(12345))).toBe("expected timestamp");
		}
	});
});

describe("arrays", () => {
	const s = fromSchema({ type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 });
	test("accepts", () => expect(ok(s.parse(["a"]))).toBe(true));
	test("rejects a non-array", () => expect(err(s.parse("a"))).toBe("expected array"));
	test("minItems", () => expect(err(s.parse([]))).toBe("fewer than minItems 1"));
	test("maxItems", () => expect(err(s.parse(["a", "b", "c"]))).toBe("more than maxItems 2"));
	test("names the offending index", () => expect(err(s.parse(["a", 2]))).toBe("item[1]: expected string"));
});

describe("objects", () => {
	const s = fromSchema({
		properties: { id: { type: "bigint" }, name: { type: "text", maxLength: 3 } },
		required: ["id"],
	});

	// A lockstep record model has no `type: 'object'`: "has properties" implies it.
	test("a lockstep record model (no explicit type) validates as an object", () => {
		expect(ok(s.parse({ id: 1n }))).toBe(true);
		expect(err(s.parse("x"))).toBe("expected object");
		expect(err(s.parse([]))).toBe("expected object");
	});

	test("required is NOT NULL: null and undefined both miss", () => {
		expect(err(s.parse({}))).toBe("missing required field id");
		expect(err(s.parse({ id: null }))).toBe("missing required field id");
		expect(err(s.parse({ id: undefined }))).toBe("missing required field id");
	});

	test("an absent optional is fine; a present one is checked", () => {
		expect(ok(s.parse({ id: 1n }))).toBe(true);
		expect(ok(s.parse({ id: 1n, name: null }))).toBe(true); // nullable column
		expect(err(s.parse({ id: 1n, name: "abcd" }))).toBe("name: longer than maxLength 3");
	});

	test("additionalProperties: false rejects an unknown key", () => {
		const strict = fromSchema({
			type: "object",
			properties: { a: { type: "string" } },
			required: ["a"],
			additionalProperties: false,
		});
		expect(ok(strict.parse({ a: "x" }))).toBe(true);
		expect(err(strict.parse({ a: "x", b: 1 }))).toBe("unexpected property b");
	});
});

describe("enums, consts, unions, opaque", () => {
	test("enum", () => {
		const s = fromSchema({ enum: ["active", "suspended"] });
		expect(ok(s.parse("active"))).toBe(true);
		expect(err(s.parse("nope"))).toBe('expected one of ["active","suspended"]');
	});
	test("const", () => {
		const s = fromSchema({ const: 4 });
		expect(ok(s.parse(4))).toBe(true);
		expect(err(s.parse(5))).toBe("expected 4");
	});
	test("anyOf", () => {
		const s = fromSchema({ anyOf: [{ type: "string" }, { type: "integer" }] });
		expect(ok(s.parse("a"))).toBe(true);
		expect(ok(s.parse(1))).toBe(true);
		expect(err(s.parse(true))).toBe("no anyOf arm matched");
	});
	test("jsonb is opaque", () => {
		const s = fromSchema({ type: "jsonb" });
		expect(ok(s.parse({ anything: [1, 2] }))).toBe(true);
		expect(ok(s.parse(null))).toBe(true);
	});
	test("an unknown type is permissive, as on ParaBun", () => {
		expect(ok(fromSchema({ type: "bytea" }).parse("whatever"))).toBe(true);
	});
});

describe("composition", () => {
	test("an embedded wrapped schema validates itself", () => {
		const inner = fromSchema({ type: "string", maxLength: 2 });
		const outer = fromSchema({ type: "object", properties: { code: inner }, required: ["code"] });
		expect(ok(outer.parse({ code: "ab" }))).toBe(true);
		expect(err(outer.parse({ code: "abc" }))).toBe("code: longer than maxLength 2");
	});

	test("a string $ref throws rather than silently passing", () => {
		const s = fromSchema({ type: "object", properties: { user: { $ref: "#User" } }, required: ["user"] });
		// A reference the portable runtime cannot resolve must never read as valid.
		expect(() => s.parse({ user: { id: 1 } })).toThrow(/unresolved \$ref "#User"/);
	});
});

describe("the hole this package exists to close", () => {
	test("a schema shipped off ParaBun actually rejects bad data", async () => {
		// ParaBun's own browser fallback is `__paraFromSchema = (s) => s`, so this
		// same body would validate NOTHING in a Worker or a browser. Pin the
		// contract: it validates here.
		const workspace = fromSchema({
			type: "object",
			properties: { name: { type: "varchar", maxLength: 120 } },
			required: ["name"],
			additionalProperties: false,
		});
		expect(workspace.parse({ name: "Lyku" })).toEqual({ tag: "Ok", value: { name: "Lyku" } });
		expect(err(workspace.parse({ name: "x".repeat(121) }))).toBe("name: longer than maxLength 120");
		expect(err(workspace.parse({ name: 42 }))).toBe("name: expected string");
		expect(err(workspace.parse({}))).toBe("missing required field name");
		expect(err(workspace.parse(null))).toBe("expected object");
	});
});
