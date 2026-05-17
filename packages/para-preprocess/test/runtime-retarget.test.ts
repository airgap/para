// Verifies the `runtime` option flips the import target between the legacy
// `svelte` runtime and the F0 fork `@lyku/para-ui` runtime. Drives the script-tag
// path through parabunPreprocess() directly.

import { describe, expect, test } from "bun:test";
import { parabunPreprocess } from "../src/index";

const callScript = async (
  source: string,
  opts: Parameters<typeof parabunPreprocess>[0] = {},
  filename = "/tmp/test.pui",
) => {
  const pp = parabunPreprocess(opts);
  const script = (pp as { script?: (a: unknown) => unknown }).script!;
  // Svelte's preprocess passes a typed payload — minimal stub here is fine.
  const res = await script({
    content: source,
    attributes: {},
    filename,
    markup: "",
  });
  return res as { code?: string } | undefined;
};

// A .pui script that uses `using` — triggers onDestroy injection, which
// hits the runtime-import emission path.
const PUI_SCRIPT = `
using sub = subscribe();
let count = 0;
`;

describe("runtime retarget", () => {
  test("default runtime is @lyku/para-ui", async () => {
    const out = await callScript(PUI_SCRIPT);
    expect(out?.code).toContain('from "@lyku/para-ui"');
    expect(out?.code).not.toContain('from "svelte"');
  });

  test('explicit runtime: "@lyku/para-ui" emits @lyku/para-ui import', async () => {
    const out = await callScript(PUI_SCRIPT, { runtime: "@lyku/para-ui" });
    expect(out?.code).toContain('from "@lyku/para-ui"');
  });

  test('explicit runtime: "svelte" emits legacy svelte import', async () => {
    const out = await callScript(PUI_SCRIPT, { runtime: "svelte" });
    expect(out?.code).toContain('from "svelte"');
    expect(out?.code).not.toContain('from "@lyku/para-ui"');
  });

  test("dedup honors either runtime spelling on hand-authored imports", async () => {
    // If the script already imports onDestroy from @lyku/para-ui, default-runtime
    // emission must NOT add a duplicate `from "svelte"` import for onDestroy.
    const withExisting = `
import { onDestroy } from "@lyku/para-ui";
${PUI_SCRIPT}
`;
    const out = await callScript(withExisting, { runtime: "svelte" });
    // We asked for svelte runtime but onDestroy already came from @lyku/para-ui —
    // dedup should suppress the duplicate.
    const occurrences = (out?.code ?? "").split('from "svelte"').length - 1;
    expect(occurrences).toBe(0);
  });
});
