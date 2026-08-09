import { test, expect } from "bun:test";
import { lowerPuiReactivity } from "../src/index.ts";

const lower = (s: string) => lowerPuiReactivity(s, "@lyku/para-ui", false, false);

test("mutate → createIntent with a draft optimistic + a generated call fn (§13.1)", () => {
  const out = lower(`<script lang="ts">
sync cart :: Cart from \`cart:\${id}\`;
mutate addItem of cart {
  optimistic(item) { cart.items = [...cart.items, item]; }
}
</script>`);
  expect(out).toContain("const __m_addItem = createIntent({ replica: __syn_cart, optimistic: (item, __cur) =>");
  expect(out).toContain("let __cart_d = { ...__cur }; __cart_d.items = [...__cart_d.items, item]; return __cart_d;");
  expect(out).toContain("function addItem(item) { __m_addItem.apply(item); }");
  expect(out).toContain(`import { synced, createIntent } from "@lyku/para-sync";`);
  expect(out).not.toMatch(/mutate addItem of/);
});

test("interdependent / += mutations lower correctly (Class-A Like/Unlike)", () => {
  const out = lower(`<script lang="ts">
sync post :: Post from \`post:\${postId}\`;
mutate toggleLike of post {
  optimistic(_) { post.liked = !post.liked; post.likeCount += post.liked ? 1 : -1; }
}
</script>`);
  // the second statement sees the NEW liked: draft-replay preserves that
  expect(out).toContain(
    "let __post_d = { ...__cur }; __post_d.liked = !__post_d.liked; __post_d.likeCount += __post_d.liked ? 1 : -1; return __post_d;"
  );
  expect(out).toContain("function toggleLike(_) { __m_toggleLike.apply(_); }");
});

test("explicit rollback arm (whole-entity restore)", () => {
  const out = lower(`<script lang="ts">
sync doc :: Doc from \`doc:\${id}\`;
mutate rename of doc {
  optimistic(title) { doc.title = title; }
  rollback(snapshot) { doc = snapshot; }
}
</script>`);
  expect(out).toContain("optimistic: (title, __cur) => { let __doc_d = { ...__cur }; __doc_d.title = title; return __doc_d; }");
  expect(out).toContain("rollback: (snapshot, __cur) => { let __doc_d = { ...__cur }; __doc_d = snapshot; return __doc_d; }");
});

test("optional confirm arm is a plain side-effect callback (no draft)", () => {
  const out = lower(`<script lang="ts">
sync doc :: Doc from \`doc:\${id}\`;
mutate save of doc {
  optimistic(_) { doc.dirty = false; }
  confirm(_) { track("saved"); }
}
</script>`);
  expect(out).toContain(`confirm: (_) => { track("saved"); }`);
});

test("a plain object property named `of` is not mistaken for the mutate keyword", () => {
  const out = lower(`<script lang="ts">
const x = { mutate: 1, of: 2 };
</script>`);
  expect(out).toContain("const x = { mutate: 1, of: 2 };");
  expect(out).not.toContain("createIntent");
});
