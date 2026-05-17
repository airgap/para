export interface PlatformEntry {
  sha256: string;
  pkg: string;
}
export interface Manifest {
  version: string;
  platforms: Record<string, PlatformEntry>;
}
export interface ResolvedParabun {
  path: string;
  version: string;
  /** false when resolved via the PARABUN_BIN escape hatch (not hash-verified). */
  verified: boolean;
  source: "env" | "package";
}
export function platformKey(platform?: string, arch?: string): string;
export function resolveParabun(): ResolvedParabun;
export function parabunPath(): string;
export function pinnedVersion(): string;
