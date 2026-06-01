import { describe, expect, test } from "bun:test";
import {
  classKeyOf,
  createVisibilityCache,
  defineVisibility,
  hasVisibilityResolver,
  projectByClass,
  visibilityGate,
} from "../src/index.js";

// App-supplied vocabulary (the framework knows none of these words).
const PUBLIC = "public";
const PRIVATE = "private";
const FRIENDS = "friends";

// A fake social graph: owner 1's friends are {2}.
const friendsOf = { 1n: [2n] };
defineVisibility({
  [PUBLIC]: () => true,
  [PRIVATE]: () => false,
  [FRIENDS]: (viewer, owner) =>
    viewer !== undefined && (friendsOf[owner] ?? []).includes(viewer),
});

const record = {
  id: 1n,
  dateOfBirth: "1990-01-01",
  dateOfBirthVisibility: FRIENDS,
  status: "hi",
  statusVisibility: PUBLIC,
  secret: "x",
  secretVisibility: PRIVATE,
};

const gate = visibilityGate({
  ownerOf: (v) => v.id,
  fields: {
    dateOfBirth: "dateOfBirthVisibility",
    status: "statusVisibility",
    secret: "secretVisibility",
  },
});

async function project(viewer, id = 1n) {
  const g = await gate({ requester: viewer, id });
  if (g === true) return true;
  const access = await g.check(record);
  return access.project(record);
}

describe("visibilityGate — domain-free per-field projection", () => {
  test("registry: unknown tag is not resolved (fail-safe)", () => {
    expect(hasVisibilityResolver(FRIENDS)).toBe(true);
    expect(hasVisibilityResolver("subscribers")).toBe(false);
  });

  test("owner sees the full record (gate returns true)", async () => {
    expect(await project(1n)).toBe(true);
  });

  test("a friend sees public + friends fields, not private", async () => {
    const out = await project(2n);
    expect(out.status).toBe("hi"); // public
    expect(out.dateOfBirth).toBe("1990-01-01"); // friends ∋ viewer 2
    expect(out.secret).toBeUndefined(); // private
  });

  test("a stranger sees only public fields", async () => {
    const out = await project(9n);
    expect(out.status).toBe("hi"); // public
    expect(out.dateOfBirth).toBeUndefined(); // friends ∌ 9
    expect(out.secret).toBeUndefined();
  });

  test("logged-out viewer sees only public fields", async () => {
    const out = await project(undefined);
    expect(out.status).toBe("hi");
    expect(out.dateOfBirth).toBeUndefined();
  });

  test("visibility-setting keys are stripped from the projection", async () => {
    const out = await project(2n);
    expect(out.dateOfBirthVisibility).toBeUndefined();
    expect(out.statusVisibility).toBeUndefined();
    expect(out.secretVisibility).toBeUndefined();
  });

  test("classKeyOf buckets viewers by satisfied-tag SET (not by id)", async () => {
    expect(await classKeyOf(1n, 1n)).toBe("self");
    // friend 2 satisfies friends + public → same key regardless of which friend
    expect(await classKeyOf(2n, 1n)).toBe("friends+public");
    // strangers all collapse to the same class → shared cache entry
    expect(await classKeyOf(9n, 1n)).toBe("public");
    expect(await classKeyOf(42n, 1n)).toBe("public");
    expect(await classKeyOf(undefined, 1n)).toBe("public");
  });

  test("projectByClass is pure (no resolver calls) and self is untouched", () => {
    const fields = { dateOfBirth: "dateOfBirthVisibility", secret: "secretVisibility" };
    expect(projectByClass(record, fields, "self")).toBe(record);
    const pub = projectByClass(record, fields, "public");
    expect(pub.dateOfBirth).toBeUndefined();
    expect(pub.dateOfBirthVisibility).toBeUndefined();
    const fr = projectByClass(record, fields, "friends+public");
    expect(fr.dateOfBirth).toBe("1990-01-01");
  });

  describe("createVisibilityCache — per-class, version-stamped", () => {
    const fields = {
      dateOfBirth: "dateOfBirthVisibility",
      status: "statusVisibility",
      secret: "secretVisibility",
    };

    function fakeBackend() {
      const store = new Map();
      let computes = 0;
      return {
        store,
        backend: {
          get: async (k) => store.get(k),
          set: async (k, v) => void store.set(k, v),
        },
        // count distinct (key,class,version) entries actually materialized
        get entries() {
          return store.size;
        },
        bump: () => computes++,
      };
    }

    test("two viewers in the SAME class share ONE cache entry", async () => {
      const fb = fakeBackend();
      const cache = createVisibilityCache({ backend: fb.backend });
      const req = (viewer) => ({ key: "user:1", version: 7, value: record, viewer, owner: 1n, fields });

      const a = await cache.project(req(9n)); // stranger → public
      const b = await cache.project(req(42n)); // stranger → public (same class)
      expect(a).toEqual(b);
      expect(fb.entries).toBe(1); // ONE entry for both strangers, not two
    });

    test("owner is full + uncached; classes are bounded, not per-viewer", async () => {
      const fb = fakeBackend();
      const cache = createVisibilityCache({ backend: fb.backend });
      const req = (viewer) => ({ key: "user:1", version: 7, value: record, viewer, owner: 1n, fields });

      expect(await cache.project(req(1n))).toBe(record); // owner → full
      await cache.project(req(2n)); // friend
      await cache.project(req(9n)); // stranger
      await cache.project(req(50n)); // another stranger (same class as 9)
      await cache.project(req(51n)); // another stranger
      // 4 distinct viewers among non-owners → only 2 realized classes cached
      expect(fb.entries).toBe(2);
    });

    test("a version bump mints NEW keys; relationship churn touches none", async () => {
      const fb = fakeBackend();
      const cache = createVisibilityCache({ backend: fb.backend });
      await cache.project({ key: "user:1", version: 7, value: record, viewer: 9n, owner: 1n, fields });
      await cache.project({ key: "user:1", version: 8, value: record, viewer: 9n, owner: 1n, fields });
      // v7 and v8 are separate entries; the old one is left to LRU-evict.
      expect([...fb.store.keys()].some((k) => k.endsWith(":7"))).toBe(true);
      expect([...fb.store.keys()].some((k) => k.endsWith(":8"))).toBe(true);
    });
  });

  test("an UNREGISTERED tag denies the field (fail-safe)", async () => {
    const g = await visibilityGate({ fields: { x: "xVis" }, ownerOf: (v) => v.id })({
      requester: 2n,
      id: 1n,
    });
    const out = (await g.check({ id: 1n, x: "secret", xVis: "subscribers" })).project({
      id: 1n,
      x: "secret",
      xVis: "subscribers",
    });
    expect(out.x).toBeUndefined(); // unknown tag → denied
  });
});
