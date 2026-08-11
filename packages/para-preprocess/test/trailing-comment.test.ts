// Trailing `// comments` on single-line declaration forms. The decl regexes
// end `\s*;?\s*$`, so before stripDeclTail a comment left the `;` mid-capture
// and rode into the emitted wrapper: `$state([]; // note)`: commenting out
// the close paren. Found by the first .pui app written outside this repo
// (a `signal pending = []; // { x, y, … }` line). Every line-based form is
// covered here; `derived` scans with derivedInitEnd and stops at the `;`, so
// its semicolon form was never affected (pinned below anyway).
import { test, expect } from "bun:test";
import { lowerPuiReactivity, stripDeclTail } from "../src/index.ts";

const lower = (s: string) => lowerPuiReactivity(s, "@lyku/para-ui", false, false);
const script = (body: string) => `<script lang="ts">\n${body}\n</script>`;

test("stripDeclTail: comment cut, string literals respected, `;` dropped", () => {
  expect(stripDeclTail("[];     // { x, y, letter }")).toBe("[]");
  expect(stripDeclTail("5; // note")).toBe("5");
  expect(stripDeclTail("a / b; // divide")).toBe("a / b");
  expect(stripDeclTail("'http://x.com'")).toBe("'http://x.com'");
  expect(stripDeclTail('"a // not a comment"; // real one')).toBe('"a // not a comment"');
  expect(stripDeclTail("`t ${x} //nope`")).toBe("`t ${x} //nope`");
  expect(stripDeclTail("plain")).toBe("plain");
});

test("signal with a trailing comment lowers clean", () => {
  const out = lower(script("signal pending = [];     // { x, y, letter, blank }"));
  expect(out).toContain("let pending = $state([]);");
  expect(out).not.toContain("// { x, y");
});

test("signal assignment-rewrite with a trailing comment lowers clean", () => {
  const out = lower(script(
    "signal n = 0;\nsignalOf(n);\nn = 5; // bump",
  ));
  expect(out).toContain("__sig_n.set(5);");
  expect(out).not.toContain("set(5; // bump");
});

test("prop with a trailing comment lowers clean", () => {
  const out = lower(script("prop room: string = 'local'; // the table id"));
  expect(out).toContain("let { room = 'local' }: { room?: string } = $props();");
});

test("using / source / async signal with trailing comments lower clean", () => {
  const out = lower(script(
    "using res = open(); // handle\n" +
    "source level = meter(); // native\n" +
    "async signal user = api.get(id); // fetch",
  ));
  expect(out).toContain("const res = open(); onDestroy(");
  expect(out).toContain("const __src_level = meter(); ");
  expect(out).toContain("promiseSignal(() => (api.get(id)));");
  expect(out).not.toContain("open(); // handle;");
  expect(out).not.toContain("(meter(); //");
  expect(out).not.toContain("api.get(id); // fetch))");
});

test("string literals containing // survive every form", () => {
  const out = lower(script(
    "signal url = 'http://a.b';\nprop link: string = \"https://c.d\";",
  ));
  expect(out).toContain("$state('http://a.b')");
  expect(out).toContain('link = "https://c.d"');
});

test("derived semicolon form with trailing comment stays clean (scanner path)", () => {
  const out = lower(script("derived twice = n * 2; // doubled"));
  expect(out).toContain("const twice = $derived(n * 2);");
  expect(out).not.toContain("$derived(n * 2; //");
});
