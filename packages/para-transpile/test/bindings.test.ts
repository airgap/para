import { describe, expect, test } from "bun:test";
import { transpile } from "../src/index";

describe("~> reactive assignment binding", () => {
  test("simple assignment binding", () => {
    expect(transpile("name ~> document.title;")).toBe(
      `require("@lyku/para-signals").effect(() => { document.title = name; });`,
    );
  });

  test("expression LHS", () => {
    expect(transpile("count * 2 ~> el.innerHTML;")).toBe(
      `require("@lyku/para-signals").effect(() => { el.innerHTML = count * 2; });`,
    );
  });

  test("complex LHS with logical ops", () => {
    expect(transpile("!items.length || openCount > 0 ~> toast.hidden;")).toBe(
      `require("@lyku/para-signals").effect(() => { toast.hidden = !items.length || openCount > 0; });`,
    );
  });

  test("does not fire inside string", () => {
    expect(transpile(`const s = "a ~> b";`)).toBe(`const s = "a ~> b";`);
  });
});

describe("-> reactive call binding", () => {
  test("simple call binding", () => {
    expect(transpile("count -> console.log;")).toBe(`require("@lyku/para-signals").effect(() => { console.log(count); });`);
  });

  test("template-literal LHS to writer fn", () => {
    expect(transpile("`count=${count}` -> process.stdout.write;")).toBe(
      'require("@lyku/para-signals").effect(() => { process.stdout.write(`count=${count}`); });',
    );
  });

  test("does not match `=>` (arrow)", () => {
    // The arrow should be left alone; only standalone `->` triggers.
    expect(transpile("const f = x => x * 2;")).toBe("const f = x => x * 2;");
  });

  test("does not match `--` (decrement)", () => {
    expect(transpile("count--;")).toBe("count--;");
  });
});
