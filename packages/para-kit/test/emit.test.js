import { describe, expect, test } from "bun:test";
import { emitServerArtifacts, artifactPathFor, endpointTemplate } from "../src/index.js";

const PUI = `<script lang="ts">
import { Stats } from "./models.js";
import { db } from "./db.server.js";
prop orgId: bigint;
sync stats :: Stats from server db.total(orgId) on "stats:bump";
</script>
<p>{stats?.total}</p>`;

describe("emitServerArtifacts: the P9 pure emitter", () => {
  test("artifact path convention", () => {
    expect(artifactPathFor("src/routes/stats/+page.pui")).toBe(
      "src/routes/stats/+page.server-sources.pts"
    );
  });

  test("emits one artifact per server-source .pui + a flat manifest", () => {
    const r = emitServerArtifacts(
      [
        { path: "src/routes/stats/+page.pui", source: PUI },
        { path: "src/routes/plain/+page.pui", source: `<script>let x = 1;</script>` },
      ],
      { manifestPath: "src/lib/para-sync-manifest.js" }
    );
    expect(r.diagnostics).toEqual([]);
    expect(r.artifacts).toHaveLength(1); // the plain page emitted nothing
    expect(r.artifacts[0].path).toBe("src/routes/stats/+page.server-sources.pts");
    expect(r.artifacts[0].code).toContain(`declId: "src/routes/stats/+page.pui#stats"`);
    // Manifest imports are manifest-relative and flatten every artifact.
    expect(r.manifest.code).toContain(
      `import { __paraServerSources as __s0 } from "../routes/stats/+page.server-sources.pts";`
    );
    expect(r.manifest.code).toContain(`export const serverSources = [...__s0];`);
  });

  test("diagnostics carry the file path and fail loudly", () => {
    const r = emitServerArtifacts([
      {
        path: "src/broken.pui",
        source: `<script>\nimport { db } from "./db.server.js";\nsync x :: S from server db.q();\n</script>`,
      },
    ]);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toContain("src/broken.pui:");
    expect(r.diagnostics[0]).toContain("refresh policy");
  });

  test("the endpoint template is write-once wiring, importing the manifest", () => {
    const t = endpointTemplate();
    expect(t).toContain(`from "@lyku/para-kit"`);
    expect(t).toContain(`from "$lib/para-sync-manifest.js"`);
    expect(t).toContain("createServerSourceHost(serverSources");
  });
});
