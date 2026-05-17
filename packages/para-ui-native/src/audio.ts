import { signal } from "@lyku/para-signals";
import type { SourceHandle } from "./source.ts";

// Minimal structural view of the bits of parabun:audio's CaptureStream
// this adapter touches (the full type lives in the runtime).
interface CaptureLike {
  peakLevel: { peek(): number; subscribe(cb: (v: number) => void): () => void };
  close?: () => unknown;
}
type CaptureFn = (opts: Record<string, unknown>) => Promise<CaptureLike>;

export interface AudioMeterOptions {
  /** ALSA device, e.g. "hw:1,0". Omitted → default capture device. */
  device?: string;
  /**
   * Test-only seam: inject a fake `capture`. Default lazily imports the
   * real native `parabun:audio` so this module loads on any runtime
   * (the import only fires when a meter is actually started).
   */
  _capture?: CaptureFn;
}

const defaultCapture: CaptureFn = async opts => {
  const audio = (await import("parabun:audio")).default as { capture: CaptureFn };
  return audio.capture(opts);
};

/**
 * A `source`-convention handle whose value is the live mic peak level
 * (RMS, 0..1) from real ALSA capture. Synchronous by construction:
 * `parabun:audio`'s `capture()` is async, so we return immediately with
 * an internal para signal seeded at 0 and forward the native
 * `peakLevel` signal into it once capture resolves. `dispose()` is
 * race-safe — if it runs before capture resolves, the stream is closed
 * on arrival. Device-unavailable is non-fatal: the meter stays at 0.
 *
 * Usage in a `.pui`:  `source level = audioMeter()`  then  `{level}`.
 */
export function audioMeter(opts: AudioMeterOptions = {}): SourceHandle<number> {
  const level = signal(0);
  const capture = opts._capture ?? defaultCapture;

  let unsub: (() => void) | undefined;
  let stream: CaptureLike | undefined;
  let disposed = false;

  capture({ channels: 1, ...(opts.device ? { device: opts.device } : {}) })
    .then(c => {
      if (disposed) {
        c.close?.();
        return;
      }
      stream = c;
      unsub = c.peakLevel.subscribe(v => level.set(v));
    })
    .catch(() => {
      /* device unavailable / no ALSA — meter stays at 0, not fatal */
    });

  return {
    peek: () => level.peek(),
    subscribe: cb => level.subscribe(cb),
    dispose: () => {
      disposed = true;
      unsub?.();
      stream?.close?.();
    },
  };
}
