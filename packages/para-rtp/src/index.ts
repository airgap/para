// Hardcoded module "@para/rtp"
//
// Parabun: RFC 3550 RTP packet framing. Pure JS, no native deps. Lets
// Parabun apps build voice/video transport over any wire (Bun.udp,
// WebSocket, raw TCP, …) without dragging in a full WebRTC stack.
//
//   import rtp from "@para/rtp";
//
//   // Sender — wrap an Opus packet in RTP
//   const wire = rtp.pack({
//     payloadType: 111,   // Opus default in many sdp setups
//     sequence: 1234,
//     timestamp: 96000,   // tick at sample rate (48 kHz × ms)
//     ssrc: 0xdeadbeef,
//     marker: false,
//     payload: opusPacket,
//   });
//   await udp.send(wire);
//
//   // Receiver
//   const { sequence, timestamp, payload } = rtp.parse(wire);
//
// Out of scope for v1: SRTP (encryption), RTCP control packets,
// jitter buffer, FEC. The core framing is what every higher-level
// layer builds on; ship it tight first.

// RTP fixed header is always 12 bytes. CSRC identifiers (4 bytes each)
// follow, count given by the CC field (low 4 bits of byte 0). Optional
// extension header follows CSRCs if X bit is set; we round-trip its
// bytes verbatim without interpreting.
const RTP_FIXED_HEADER_BYTES = 12;
const RTP_VERSION = 2;

type PackOptions = {
  /**
   * Payload type — 7-bit value. SDP-negotiated. Common: 0 = G.711 µ-law,
   * 8 = G.711 A-law, 96-127 = dynamic (Opus, VP8, H.264 land here).
   */
  payloadType: number;
  /** 16-bit sequence number. Monotonically increasing per stream. */
  sequence: number;
  /** 32-bit timestamp at the codec's sample rate. */
  timestamp: number;
  /** 32-bit synchronization source identifier — uniquely identifies the stream. */
  ssrc: number;
  /** Marker bit. Codec-specific meaning (e.g., last packet of a frame). Default false. */
  marker?: boolean;
  /** Optional CSRC list (up to 15 entries, each 32-bit). */
  csrcs?: number[];
  /** Codec-specific payload (Opus packet, VP8 frame slice, etc.). */
  payload: Uint8Array;
};

type ParsedPacket = {
  version: number;
  padding: boolean;
  extension: boolean;
  marker: boolean;
  payloadType: number;
  sequence: number;
  timestamp: number;
  ssrc: number;
  csrcs: number[];
  /**
   * Extension header bytes verbatim, if the X bit was set. Includes the
   * 4-byte profile+length prefix per RFC 3550. Empty Uint8Array when X=0.
   */
  extension_data: Uint8Array;
  /** Codec payload, with padding bytes (if any) already stripped. */
  payload: Uint8Array;
};

function validatePackOptions(opts: PackOptions): void {
  if ((opts.payloadType & ~0x7f) !== 0) {
    throw new RangeError("@para/rtp pack: payloadType must fit in 7 bits (0-127)");
  }
  if ((opts.sequence & ~0xffff) !== 0) {
    throw new RangeError("@para/rtp pack: sequence must fit in 16 bits (0-65535)");
  }
  // timestamp + ssrc are 32-bit unsigned. JS bitwise ops treat them as signed
  // 32-bit, so we accept either the signed or unsigned representation as long
  // as it round-trips.
  if (!Number.isInteger(opts.timestamp) || opts.timestamp < 0 || opts.timestamp > 0xffffffff) {
    throw new RangeError("@para/rtp pack: timestamp must fit in 32 bits (0-4294967295)");
  }
  if (!Number.isInteger(opts.ssrc) || opts.ssrc < 0 || opts.ssrc > 0xffffffff) {
    throw new RangeError("@para/rtp pack: ssrc must fit in 32 bits (0-4294967295)");
  }
  if (opts.csrcs !== undefined) {
    if (opts.csrcs.length > 15) {
      throw new RangeError("@para/rtp pack: csrcs has at most 15 entries");
    }
    for (const c of opts.csrcs) {
      if (!Number.isInteger(c) || c < 0 || c > 0xffffffff) {
        throw new RangeError("@para/rtp pack: each csrc must fit in 32 bits");
      }
    }
  }
  if (!(opts.payload instanceof Uint8Array)) {
    throw new TypeError("@para/rtp pack: payload must be a Uint8Array");
  }
}

function pack(opts: PackOptions): Uint8Array {
  validatePackOptions(opts);
  const csrcs = opts.csrcs ?? [];
  const cc = csrcs.length;
  const headerBytes = RTP_FIXED_HEADER_BYTES + cc * 4;
  const total = headerBytes + opts.payload.length;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);

  // Byte 0: V (2 bits) | P (1) | X (1) | CC (4)
  // Pack/parse are decoupled from extensions for v1 — pack never sets X
  // or P. Receivers handle either gracefully via parse().
  buf[0] = (RTP_VERSION << 6) | (cc & 0x0f);
  // Byte 1: M (1 bit) | PT (7 bits)
  buf[1] = (opts.marker ? 0x80 : 0) | (opts.payloadType & 0x7f);
  dv.setUint16(2, opts.sequence, false);
  dv.setUint32(4, opts.timestamp, false);
  dv.setUint32(8, opts.ssrc, false);

  for (let i = 0; i < cc; i++) {
    dv.setUint32(RTP_FIXED_HEADER_BYTES + i * 4, csrcs[i], false);
  }
  if (opts.payload.length > 0) buf.set(opts.payload, headerBytes);
  return buf;
}

function parse(bytes: Uint8Array): ParsedPacket {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("@para/rtp parse: expected Uint8Array");
  }
  if (bytes.length < RTP_FIXED_HEADER_BYTES) {
    throw new RangeError(`@para/rtp parse: packet too short (${bytes.length} < ${RTP_FIXED_HEADER_BYTES})`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const b0 = bytes[0];
  const version = (b0 >> 6) & 0x03;
  if (version !== RTP_VERSION) {
    throw new RangeError(`@para/rtp parse: unsupported RTP version ${version} (only v2 supported)`);
  }
  const padding = (b0 & 0x20) !== 0;
  const extension = (b0 & 0x10) !== 0;
  const cc = b0 & 0x0f;

  const b1 = bytes[1];
  const marker = (b1 & 0x80) !== 0;
  const payloadType = b1 & 0x7f;
  const sequence = dv.getUint16(2, false);
  const timestamp = dv.getUint32(4, false);
  const ssrc = dv.getUint32(8, false);

  let cursor = RTP_FIXED_HEADER_BYTES;
  if (cursor + cc * 4 > bytes.length) {
    throw new RangeError("@para/rtp parse: CSRC list extends past packet end");
  }
  const csrcs: number[] = new Array(cc);
  for (let i = 0; i < cc; i++) {
    csrcs[i] = dv.getUint32(cursor, false);
    cursor += 4;
  }

  let extensionData: Uint8Array;
  if (extension) {
    if (cursor + 4 > bytes.length) {
      throw new RangeError("@para/rtp parse: extension header truncated");
    }
    // Extension structure: 16-bit profile-specific, 16-bit length-in-32-bit-words.
    const extWords = dv.getUint16(cursor + 2, false);
    const extTotalBytes = 4 + extWords * 4;
    if (cursor + extTotalBytes > bytes.length) {
      throw new RangeError("@para/rtp parse: extension data extends past packet end");
    }
    extensionData = bytes.slice(cursor, cursor + extTotalBytes);
    cursor += extTotalBytes;
  } else {
    extensionData = new Uint8Array(0);
  }

  // Payload runs from cursor to end-of-packet, minus padding bytes if P set.
  // Per RFC 3550: when P=1, the LAST byte of the packet contains the count
  // of padding bytes (including itself).
  let payloadEnd = bytes.length;
  if (padding) {
    if (payloadEnd === 0) {
      throw new RangeError("@para/rtp parse: padding flag set but packet has no body");
    }
    const padBytes = bytes[payloadEnd - 1];
    if (padBytes === 0 || padBytes > payloadEnd - cursor) {
      throw new RangeError("@para/rtp parse: padding count is invalid");
    }
    payloadEnd -= padBytes;
  }

  const payload = bytes.slice(cursor, payloadEnd);
  return {
    version,
    padding,
    extension,
    marker,
    payloadType,
    sequence,
    timestamp,
    ssrc,
    csrcs,
    extension_data: extensionData,
    payload,
  };
}

// ─── Jitter buffer ─────────────────────────────────────────────────────────
// Receiver-side primitive: absorbs network jitter, reorders packets that
// arrive out of sequence, and emits a "lost" signal for packets that
// never show up before the buffer's lag threshold runs out.
//
//   const jb = new rtp.JitterBuffer({ maxLag: 5 });
//   network.onmessage = bytes => jb.push(rtp.parse(bytes));
//   setInterval(() => {
//     const next = jb.pop();
//     if (next) decode(next.payload);          // payload arrived in order
//     else handleConcealment();                // gap — lost or not-yet-arrived
//   }, frameDurationMs);
//
// 16-bit sequence wrap-around: RFC 3550 sequence numbers are u16 and wrap
// every 65535 packets. Comparison is "modulo signed" — the diff is sign-
// extended into 16 bits so adjacent sequences compare correctly across
// the wrap boundary.

// Wrap-aware comparison: (a - b) treated as 16-bit signed. Positive →
// `a` is after `b` in the stream. Used for sequence ordering.
function seqDiff(a: number, b: number): number {
  return ((a - b) << 16) >> 16;
}

type JitterBufferOptions = {
  /**
   * Max number of packets the buffer can hold ahead of the expected one
   * before declaring the missing slot lost and advancing. Default 5,
   * which translates to 100 ms at 20 ms voice frames — typical for
   * voice calls. Bigger = better loss tolerance, more added latency.
   */
  maxLag?: number;
};

const signalsMod = require("@lyku/para-signals");

// Structural Signal types — keep this module agnostic of @lyku/para-signals's
// class hierarchy. Same shape as audio.ts / camera.ts / vision.ts.
type Signal<T> = {
  get(): T;
  peek(): T;
  subscribe(cb: (v: T) => void): () => void;
};
type WritableSignal<T> = Signal<T> & { set(v: T): void };

class JitterBuffer {
  readonly maxLag: number;
  #buf = new Map<number, ParsedPacket>();
  #expected: number | null = null;
  #lossCount = 0;
  #deliveredCount = 0;

  // Reactive surface (LYK-744 v1). Only the signals that map to state
  // this primitive actually tracks. `connected` and `jitterMs` from the
  // PLAN-module-signals row need a future Session abstraction (RTP /
  // RTCP correlation, source-arrival timestamp differencing) — neither
  // exists in @para/rtp v1. When a Session class lands, those signals
  // join the surface there, not here.
  #pendingSig: WritableSignal<number>;
  #lossCountSig: WritableSignal<number>;
  #lossRateSig: WritableSignal<number>;

  /** Number of packets buffered, awaiting the next-expected slot to fill. */
  get pendingSignal(): Signal<number> {
    return this.#pendingSig;
  }
  /** Cumulative count of packets declared lost since construction. */
  get lossCountSignal(): Signal<number> {
    return this.#lossCountSig;
  }
  /**
   * Fraction of expected packets that were declared lost over the buffer's
   * lifetime — `lossCount / (lossCount + delivered)`. Updates on every
   * delivered or lost transition. 0 until the first packet is observed.
   */
  get lossRateSignal(): Signal<number> {
    return this.#lossRateSig;
  }

  constructor(opts: JitterBufferOptions = {}) {
    this.maxLag = opts.maxLag ?? 5;
    if (this.maxLag < 1) {
      throw new RangeError("@para/rtp JitterBuffer: maxLag must be >= 1");
    }
    this.#pendingSig = signalsMod.signal(0);
    this.#lossCountSig = signalsMod.signal(0);
    this.#lossRateSig = signalsMod.signal(0);
  }

  #recomputeLossRate(): void {
    const total = this.#lossCount + this.#deliveredCount;
    const rate = total > 0 ? this.#lossCount / total : 0;
    if (rate !== this.#lossRateSig.peek()) this.#lossRateSig.set(rate);
  }

  /**
   * Insert a parsed packet. Late arrivals (sequence < expected) are
   * dropped silently — the consumer has already concealed past them.
   */
  push(packet: ParsedPacket): void {
    if (this.#expected === null) {
      this.#expected = packet.sequence;
    } else if (seqDiff(packet.sequence, this.#expected) < 0) {
      // Late: arrived after the consumer has already moved past this slot.
      return;
    }
    const beforeSize = this.#buf.size;
    this.#buf.set(packet.sequence, packet);
    if (this.#buf.size !== beforeSize) this.#pendingSig.set(this.#buf.size);
  }

  /**
   * Return the next in-order packet, or `null` if the next-expected
   * sequence isn't here yet AND the buffer hasn't gone past its lag
   * threshold (in which case we declare loss and advance).
   */
  pop(): ParsedPacket | null {
    if (this.#expected === null) return null;
    const expected = this.#expected;

    const direct = this.#buf.get(expected);
    if (direct !== undefined) {
      this.#buf.delete(expected);
      this.#expected = (expected + 1) & 0xffff;
      this.#deliveredCount++;
      this.#pendingSig.set(this.#buf.size);
      this.#recomputeLossRate();
      return direct;
    }

    // Expected slot is missing. Count buffered packets that sit ahead
    // of `expected` in sequence order. If we're more than `maxLag`
    // packets ahead, declare the missing slot lost and skip to the
    // smallest buffered sequence past it.
    let smallestAhead = -1;
    let smallestDiff = Infinity;
    for (const seq of this.#buf.keys()) {
      const d = seqDiff(seq, expected);
      if (d > 0 && d < smallestDiff) {
        smallestDiff = d;
        smallestAhead = seq;
      }
    }
    if (smallestAhead < 0) return null; // empty or only-late packets

    // Use buffer fill (count of buffered packets) as the lag proxy.
    if (this.#buf.size > this.maxLag) {
      this.#lossCount++;
      this.#lossCountSig.set(this.#lossCount);
      this.#recomputeLossRate();
      // Skip the missing slot — advance expected to the smallest one we
      // have. Re-enter pop so subsequent contiguous-buffered packets
      // drain in one batch.
      this.#expected = smallestAhead;
      return this.pop();
    }

    return null;
  }

  /** Number of packets currently buffered. */
  get pending(): number {
    return this.#buf.size;
  }

  /** Sequence the buffer is waiting on. `null` until the first push. */
  get nextSequence(): number | null {
    return this.#expected;
  }

  /** Cumulative count of packets declared lost since construction. */
  get lossCount(): number {
    return this.#lossCount;
  }
}

export default {
  pack,
  parse,
  JitterBuffer,
};
