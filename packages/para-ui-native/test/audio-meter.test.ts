import { test, expect } from "bun:test";
import { audioMeter } from "../src/audio.ts";
import { lowerPuiReactivity } from "../../para-preprocess/src/index.ts";
import { readFileSync } from "node:fs";

// A fake CaptureStream matching the structural slice the adapter uses.
function fakeCapture() {
  let subscriber: ((v: number) => void) | undefined;
  let closed = false;
  let resolve!: (c: unknown) => void;
  const promise = new Promise(r => (resolve = r));
  const stream = {
    peakLevel: {
      _v: 0,
      peek() {
        return this._v;
      },
      subscribe(cb: (v: number) => void) {
        subscriber = cb;
        return () => {
          subscriber = undefined;
        };
      },
    },
    close() {
      closed = true;
    },
  };
  return {
    capture: () => promise as Promise<any>,
    ready: () => resolve(stream),
    emit: (v: number) => {
      stream.peakLevel._v = v;
      subscriber?.(v);
    },
    isClosed: () => closed,
    hasSubscriber: () => subscriber !== undefined,
  };
}

test("audioMeter conforms to the source convention (peek/subscribe/dispose)", () => {
  const f = fakeCapture();
  const h = audioMeter({ _capture: f.capture });
  expect(typeof h.peek).toBe("function");
  expect(typeof h.subscribe).toBe("function");
  expect(typeof h.dispose).toBe("function");
  expect(h.peek()).toBe(0); // synchronous, seeded at 0 before capture resolves
  h.dispose();
});

test("native peakLevel forwards into the handle after async capture resolves", async () => {
  const f = fakeCapture();
  const h = audioMeter({ _capture: f.capture });
  const seen: number[] = [];
  const unsub = h.subscribe(v => seen.push(v));

  expect(h.peek()).toBe(0);
  f.ready();
  await Promise.resolve(); // let the capture().then(...) microtask run
  expect(f.hasSubscriber()).toBe(true);

  f.emit(0.42);
  expect(h.peek()).toBe(0.42);
  expect(seen).toContain(0.42);
  unsub();
  h.dispose();
});

test("dispose closes the stream and stops forwarding", async () => {
  const f = fakeCapture();
  const h = audioMeter({ _capture: f.capture });
  f.ready();
  await Promise.resolve();
  h.dispose();
  expect(f.isClosed()).toBe(true);
  expect(f.hasSubscriber()).toBe(false); // unsubscribed from native peakLevel
});

test("race-safe: dispose before capture resolves still closes the arriving stream", async () => {
  const f = fakeCapture();
  const h = audioMeter({ _capture: f.capture });
  h.dispose(); // disposed while capture() still pending
  f.ready();
  await Promise.resolve();
  expect(f.isClosed()).toBe(true);
});

test("device-unavailable is non-fatal: meter stays at 0", async () => {
  const h = audioMeter({ _capture: () => Promise.reject(new Error("no ALSA")) });
  await Promise.resolve();
  await Promise.resolve();
  expect(h.peek()).toBe(0); // no throw, stays 0
  h.dispose();
});

test("AudioMeter.pui lowers: source → bridge+dispose, prop+derived intact", () => {
  const src = readFileSync(new URL("../src/AudioMeter.pui", import.meta.url), "utf8");
  const out = lowerPuiReactivity(src, "@lyku/para-ui", false, false);
  expect(out).toContain(`const __src_level = audioMeter(device ? { device } : {});`);
  expect(out).toContain(`let level = $state(__src_level.peek?.() ?? __src_level);`);
  expect(out).toContain(`$effect.pre(() => __src_level.subscribe?.((__v: typeof level) => { level = __v; }));`);
  expect(out).toContain(`onDestroy(() => __src_level.dispose?.());`);
  expect(out).toContain(`import { onDestroy } from "@lyku/para-ui";`);
  // prop merge + derived survive alongside source
  expect(out).toContain(`$props()`);
  expect(out).toContain(`const pct = $derived(`);
});
