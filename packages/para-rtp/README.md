# @para/rtp

RFC 3550 RTP packet pack/parse + sequence-aware jitter buffer. Pure JS, no native deps. Lets apps build voice/video transport over any wire (UDP, WebSocket, raw TCP) without a full WebRTC stack.

```js
import rtp from "@para/rtp";

// Sender — wrap an Opus packet
const wire = rtp.pack({
  payloadType: 111,    // Opus default in many SDP setups
  sequence: 1234,
  timestamp: 96000,    // tick at sample rate (48 kHz × ms)
  ssrc: 0xdeadbeef,
  marker: false,
  payload: opusPacket,
});
await udp.send(wire);

// Receiver
const { sequence, timestamp, payload } = rtp.parse(wire);

// Jitter buffer — sequence-aware reorder over a configurable depth
const jb = rtp.JitterBuffer({ depth: 8 });
jb.push(packet);
const ready = jb.drainReady();
```

Three reactive `@lyku/para-signals` Signals on the buffer instance — wire them into a UI without polling.

## Out of scope (v1)

- SRTP encryption
- RTCP control packets
- Forward error correction (FEC)
- Rate-adaptive depth

The core framing is what every higher-level layer builds on; ship it tight first.

## Status

`private:true / 0.0.0-dev` — pending the workspace split. See [parabun.script.dev](https://parabun.script.dev) for the runtime-bundled story today.
