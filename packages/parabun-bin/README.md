# @lyku/parabun-bin

Resolver for the **pinned `parabun` release binary**. This is the
mechanism half of the Para ↔ ParaBun boundary contract (P2: see
`/raid/para-design/para-parabun-boundary.md`, decision 1).

## The pin is the lockfile

This package's installed **version** is the pin. Bumping it (and
committing the lockfile change) is the deliberate, reviewed act of
moving the boundary to a new parabun parser release. No floating
"latest": that is invariant **B2**.

## Usage

```js
import { resolveParabun, parabunPath } from "@lyku/parabun-bin";

const { path, version, verified, source } = resolveParabun();
// path: absolute path to the parabun binary
// verified: false only when resolved via the PARABUN_BIN escape hatch
```

The `parity` project and `para-preprocess`'s pinned-binary test wiring
consume this instead of hardcoding a binary path.

## Resolution order

1. **`PARABUN_BIN`** env var: an explicit absolute path. Trusted, **not**
   hash-verified (`verified: false`). The deliberate escape hatch: local
   dev, a freshly-built binary, or the stand-in **before Jenkins
   publishes the real per-platform packages**.
2. The matching per-platform optional dependency, **sha256-verified**
   against `manifest.json`. A mismatch throws: the boundary refuses to
   run a binary it did not vouch for (invariant **B1** integrity).
3. Throw: actionable, names the platform and both remedies.

## The per-platform package contract (Jenkins must honor, P2-c)

On release (gated by the existing `PUBLISH_RELEASE` Jenkins param),
parabun's pipeline must, for each supported platform:

- Publish `@lyku/parabun-bin-<os>-<arch>` (`linux-x64`, `darwin-x64`,
  `darwin-arm64`, …) containing the release binary at **`bin/parabun`**,
  with `package.json` `"os"` / `"cpu"` set so npm installs only the
  matching one, and `bin/parabun` in `files`.
- Publish `@lyku/parabun-bin` itself with `manifest.json` **baked**:
  `version` = the parabun release, and one `platforms[<key>]` entry per
  platform = `{ sha256: <hash of that bin/parabun>, pkg:
  "@lyku/parabun-bin-<os>-<arch>" }`.
- Bump all four package versions in lockstep to the same `<release>`
  string, and the `optionalDependencies` ranges here to match.
- Publish to the **@lyku registry only**: never an oven-sh / upstream
  Bun target.

The committed `manifest.json` here is a **scaffold placeholder** with
`platforms: {}` on purpose: until Jenkins bakes real entries,
`resolveParabun()` fails loud and forces `PARABUN_BIN`, so nothing can
silently run an unpinned binary.
