// Comments inside call args must pass through lowerLeadingDot's arg
// splitter whole. Before this fix the splitter handled strings and
// templates but NOT comments: an apostrophe inside `// can't` opened a
// phantom string that swallowed real code (brackets included) up to the
// next apostrophe, desyncing bracket depth: and the recursion then
// rewrote an innocent later call (`mat(du, …)` came out `mat(d), …`).
// Found by Tilemates' torus-mesh renderer, whose cell mapper carries
// several apostrophed comments between nested calls.
import { test, expect } from "bun:test";
import { lowerParaScript } from "../src/index.ts";

test("apostrophes in comments between nested call args don't desync the splitter", () => {
  const src = `const content = cells.map((c) => {
  // flat quads can't share all four corners
  const bu = cu.map((q) => (q * 1.03) / CW);
  facets.push({
    style: box + mat(bu, bv, n, o),
    // the plate's front faces the other way
    backStyle: box + mat(bu, bv, n, o),
  });
  // the cell's content card
  return { shellStyle: box + mat(du, dv, n, o) };
});`;
  expect(lowerParaScript(src)).toBe(src);
});

test("block comments with quotes in call args pass through whole", () => {
  const src = `f(a, /* don"t ' split, here */ b, g(c, d));`;
  expect(lowerParaScript(src)).toBe(src);
});

test("regex literal with a comma in call args does not split the arg", () => {
  const src = `f(x.replace(/a,b/g, ""), y);`;
  expect(lowerParaScript(src)).toBe(src);
});

test("leading-dot placeholder still lowers when a sibling arg carries a comment", () => {
  const src = `pick(items /* they can't be empty */, .name)`;
  const out = lowerParaScript(src);
  expect(out).toContain("(__x) => __x.name");
});

// Known limitation, pinned: a comment BEFORE the placeholder dot hides it
// (the placeholder check reads the arg's first non-whitespace char). The
// arg must pass through verbatim rather than be mangled.
test("comment directly before a placeholder dot passes through verbatim", () => {
  const src = `pick(items, // it can't be empty
  .name)`;
  expect(lowerParaScript(src)).toBe(src);
});
