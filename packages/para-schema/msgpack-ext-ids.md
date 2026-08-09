# Para MessagePack Ext-Type Registry

Central registry of application ext type IDs (0–127) used by Para's
schema-driven MessagePack codec and any future Para binary formats.
**Collisions are forever**: reserve here before emitting a new ext type
anywhere in the Para ecosystem (para-schema-recursion-plan.md §5.1).

| ID | Byte | Name | Meaning | Emitter |
|---:|:----:|------|---------|---------|
| 80 | 0x50 ('P') | `REF` | Backreference to a previously-encoded object (payload: msgpack-encoded unsigned int = encounter-order index). Emitted only at refTracking (cyclic) declaration boundaries. | parabun `src/runtime.bun.js` schema codec |

## Collision notes

- **msgpackr** (consumer-injectable in para-sync transports) documents its
  own ext types in the lowercase-letter range: records `0x72`, bundled
  strings `0x62`, plus structured-clone extensions, and the standard
  timestamp ext `-1`. Para IDs stay out of `0x61`–`0x7a` to keep shared
  pipes unambiguous.
- The msgpack byte `0xc1` (never-used per spec) is a separate namespace
  from ext type IDs; if any Para code uses it as an in-band sentinel,
  note it here.

## Reserved for future use

- `identity: preserve` DAG sharing reuses `REF` (plan §5.4): no new ID.
