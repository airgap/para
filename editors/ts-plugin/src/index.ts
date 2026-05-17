/**
 * Parabun TypeScript Language Service Plugin
 *
 * Intercepts source text before the TS type checker sees it,
 * desugaring Parabun syntax (pure, |>, ..!, ..&) into
 * valid TypeScript.  All TS features (go-to-def, completions,
 * hover types, diagnostics) work on the desugared code.
 */

import type tslib from "typescript/lib/tsserverlibrary";
import { containsParabunSyntax, transformParabunToTS } from "./transform";
import { pui2tsx } from "./pui2tsx";

const isPui = (fileName: string): boolean => fileName.endsWith(".pui") && !fileName.includes("node_modules");

function init(modules: { typescript: typeof tslib }) {
  const ts = modules.typescript;

  function create(info: tslib.server.PluginCreateInfo): tslib.LanguageService {
    const log = (msg: string) => info.project.projectService.logger.info(`[parabun] ${msg}`);
    log("plugin loaded");

    const originalHost = info.languageServiceHost;

    const snapshotCache = new Map<string, { version: string; snapshot: tslib.IScriptSnapshot }>();

    const proxiedHost: tslib.LanguageServiceHost = Object.create(originalHost);

    proxiedHost.getScriptSnapshot = (fileName: string): tslib.IScriptSnapshot | undefined => {
      const original = originalHost.getScriptSnapshot(fileName);
      if (!original) return undefined;

      // `.pui` → typed TSX via pui2tsx (preprocess-lower + svelte2tsx).
      // This is the whole transform; the .pts operator-desugar path below
      // does not apply.
      if (isPui(fileName)) {
        const version = originalHost.getScriptVersion(fileName);
        const cached = snapshotCache.get(fileName);
        if (cached && cached.version === version) return cached.snapshot;

        const text = original.getText(0, original.getLength());
        try {
          const { code } = pui2tsx(text, fileName);
          const snapshot = ts.ScriptSnapshot.fromString(code);
          snapshotCache.set(fileName, { version, snapshot });
          log(`pui2tsx ${fileName} (${text.length} → ${code.length} bytes)`);
          return snapshot;
        } catch (e) {
          log(`pui2tsx FAILED ${fileName}: ${(e as Error).message}`);
          // Fall back to a minimal component shim so imports still resolve.
          return ts.ScriptSnapshot.fromString(
            `import type { ComponentType } from "svelte";\nconst c: ComponentType = null as any;\nexport default c;\n`,
          );
        }
      }

      if (
        (!fileName.endsWith(".ts") &&
          !fileName.endsWith(".tsx") &&
          !fileName.endsWith(".pts") &&
          !fileName.endsWith(".ptsx")) ||
        fileName.endsWith(".d.ts") ||
        fileName.includes("node_modules")
      ) {
        return original;
      }

      const version = originalHost.getScriptVersion(fileName);
      const cached = snapshotCache.get(fileName);
      if (cached && cached.version === version) {
        return cached.snapshot;
      }

      const text = original.getText(0, original.getLength());

      if (!containsParabunSyntax(text)) {
        return original;
      }

      const transformed = transformParabunToTS(text);
      const snapshot = ts.ScriptSnapshot.fromString(transformed);
      snapshotCache.set(fileName, { version, snapshot });
      log(`transformed ${fileName} (${text.length} → ${transformed.length} bytes)`);
      return snapshot;
    };

    // `.pui` virtual modules are TSX (svelte2tsx output).
    const originalGetScriptKind = originalHost.getScriptKind?.bind(originalHost);
    proxiedHost.getScriptKind = (fileName: string): tslib.ScriptKind => {
      if (isPui(fileName)) return ts.ScriptKind.TSX;
      return originalGetScriptKind ? originalGetScriptKind(fileName) : ts.ScriptKind.TS;
    };

    // Make `import Foo from "./Foo.pui"` resolve. TS doesn't know the
    // `.pui` extension; we resolve the literal to the on-disk `.pui` path
    // and tell TS to treat it as `.tsx` (its snapshot is svelte2tsx output).
    const originalResolve = originalHost.resolveModuleNameLiterals?.bind(originalHost);
    if (originalResolve) {
      proxiedHost.resolveModuleNameLiterals = (
        moduleLiterals,
        containingFile,
        redirectedReference,
        options,
        ...rest
      ) => {
        const resolved = originalResolve(moduleLiterals, containingFile, redirectedReference, options, ...rest);
        return resolved.map((r, i) => {
          if (r.resolvedModule) return r;
          const spec = moduleLiterals[i].text;
          if (!spec.endsWith(".pui")) return r;
          // Only relative specifiers; bare/aliased .pui imports fall through
          // to the original resolver (paths/baseUrl handled there).
          if (!spec.startsWith(".")) return r;
          const path = require("path") as typeof import("path");
          const resolvedFileName = path.resolve(path.dirname(containingFile), spec).replace(/\\/g, "/");
          if (!originalHost.fileExists?.(resolvedFileName)) return r;
          return {
            resolvedModule: {
              resolvedFileName,
              extension: ts.Extension.Tsx,
              isExternalLibraryImport: false,
            },
          };
        });
      };
    }

    const languageService = ts.createLanguageService(proxiedHost);

    const proxy: tslib.LanguageService = Object.create(null);
    for (const k of Object.keys(info.languageService) as (keyof tslib.LanguageService)[]) {
      const orig = info.languageService[k];
      if (typeof orig === "function") {
        (proxy as any)[k] = (...args: any[]) => {
          return (languageService as any)[k]
            ? (languageService as any)[k](...args)
            : (orig as Function).apply(info.languageService, args);
        };
      }
    }

    return proxy;
  }

  return { create };
}

export = init;
