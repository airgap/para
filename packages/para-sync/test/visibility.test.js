import { describe, expect, test } from "bun:test";
import { defineVisibility, hasVisibilityResolver, visibilityGate } from "../src/index.js";

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
