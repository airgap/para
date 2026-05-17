import * as vscode from "vscode";
import { execFileSync } from "node:child_process";
import { LanguageClient, LanguageClientOptions, ServerOptions } from "vscode-languageclient/node";

let client: LanguageClient | undefined;
let log: vscode.OutputChannel;

const pureDecoration = vscode.window.createTextEditorDecorationType({
  backgroundColor: "rgba(0, 180, 80, 0.06)",
  isWholeLine: true,
});

const pureCallDecoration = vscode.window.createTextEditorDecorationType({
  color: "rgba(0, 180, 80, 1)",
  fontStyle: "italic",
});

/** Find the end of a brace-delimited body starting from a { character,
 *  skipping braces inside strings, template literals, and comments. */
function findBodyEnd(text: string, openBraceOffset: number): number {
  let depth = 0;
  let i = openBraceOffset;
  const len = text.length;

  while (i < len) {
    const ch = text[i];

    // Line comment
    if (ch === "/" && i + 1 < len && text[i + 1] === "/") {
      i = text.indexOf("\n", i);
      if (i === -1) return len;
      i++;
      continue;
    }

    // Block comment
    if (ch === "/" && i + 1 < len && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i === -1) return len;
      i += 2;
      continue;
    }

    // Single-quoted string
    if (ch === "'") {
      i++;
      while (i < len && text[i] !== "'") {
        if (text[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }

    // Double-quoted string
    if (ch === '"') {
      i++;
      while (i < len && text[i] !== '"') {
        if (text[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }

    // Template literal
    if (ch === "`") {
      i++;
      let tmplDepth = 0;
      while (i < len) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === "`" && tmplDepth === 0) {
          i++;
          break;
        }
        if (text[i] === "$" && i + 1 < len && text[i + 1] === "{") {
          tmplDepth++;
          i += 2;
          continue;
        }
        if (text[i] === "}" && tmplDepth > 0) {
          tmplDepth--;
          i++;
          continue;
        }
        i++;
      }
      continue;
    }

    if (ch === "{") {
      depth++;
      i++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) return i;
      i++;
      continue;
    }

    i++;
  }

  return len;
}

/** Find the end of an arrow expression body (no braces — terminated by
 *  a semicolon, closing paren/bracket at depth 0, or end of statement). */
function findArrowExprEnd(text: string, startOffset: number): number {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let i = startOffset;
  const len = text.length;

  while (i < len) {
    const ch = text[i];

    // Skip strings / comments (same as above)
    if (ch === "/" && i + 1 < len && text[i + 1] === "/") {
      i = text.indexOf("\n", i);
      if (i === -1) return len;
      i++;
      continue;
    }
    if (ch === "/" && i + 1 < len && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i === -1) return len;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const q = ch;
      i++;
      while (i < len && text[i] !== q) {
        if (text[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "`") {
      i++;
      let td = 0;
      while (i < len) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === "`" && td === 0) {
          i++;
          break;
        }
        if (text[i] === "$" && i + 1 < len && text[i + 1] === "{") {
          td++;
          i += 2;
          continue;
        }
        if (text[i] === "}" && td > 0) {
          td--;
          i++;
          continue;
        }
        i++;
      }
      continue;
    }

    if (ch === "(") {
      parenDepth++;
      i++;
      continue;
    }
    if (ch === ")") {
      if (parenDepth === 0) return i - 1;
      parenDepth--;
      i++;
      continue;
    }
    if (ch === "[") {
      bracketDepth++;
      i++;
      continue;
    }
    if (ch === "]") {
      if (bracketDepth === 0) return i - 1;
      bracketDepth--;
      i++;
      continue;
    }
    if (ch === "{") {
      braceDepth++;
      i++;
      continue;
    }
    if (ch === "}") {
      if (braceDepth === 0) return i - 1;
      braceDepth--;
      i++;
      continue;
    }

    // Semicolon or comma at top level ends the expression
    if ((ch === ";" || ch === ",") && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      return i - 1;
    }

    i++;
  }

  return len - 1;
}

/** Find the offset where the function body begins, skipping params, type
 *  params, and return type annotations. Returns the offset of the body's
 *  opening `{` or the first non-whitespace char after `=>`. Returns -1 on failure. */
function findFunctionBodyStart(text: string, from: number): number {
  let i = from;
  const len = text.length;

  // Skip whitespace
  while (i < len && /\s/.test(text[i])) i++;

  // Skip type params <...>
  if (i < len && text[i] === "<") {
    let depth = 1;
    i++;
    while (i < len && depth > 0) {
      if (text[i] === "<") depth++;
      else if (text[i] === ">") depth--;
      else if (text[i] === "'" || text[i] === '"' || text[i] === "`") {
        const q = text[i];
        i++;
        while (i < len && text[i] !== q) {
          if (text[i] === "\\") i++;
          i++;
        }
      }
      i++;
    }
    while (i < len && /\s/.test(text[i])) i++;
  }

  // If we see an identifier (single-param arrow: pure x => ...), find =>
  if (i < len && /[a-zA-Z_$]/.test(text[i]) && text[i] !== "{") {
    // Could be function name or single-param arrow — scan for ( or =>
    const scan = text.substring(i);
    const arrowMatch = scan.match(/^\w+\s*=>\s*/);
    if (arrowMatch) {
      const bodyOff = i + arrowMatch[0].length;
      return bodyOff;
    }
    // Function name — skip it
    while (i < len && /\w/.test(text[i])) i++;
    while (i < len && /\s/.test(text[i])) i++;
  }

  // Skip params (...)
  if (i < len && text[i] === "(") {
    let depth = 1;
    i++;
    while (i < len && depth > 0) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
      else if (text[i] === "'" || text[i] === '"' || text[i] === "`") {
        const q = text[i];
        i++;
        while (i < len && text[i] !== q) {
          if (text[i] === "\\") i++;
          i++;
        }
      }
      i++;
    }
    while (i < len && /\s/.test(text[i])) i++;
  }

  // Skip return type annotation `: Type`
  if (i < len && text[i] === ":") {
    i++; // skip ':'
    // Walk forward until we find `{` or `=>` at depth 0
    let depth = 0;
    while (i < len) {
      const ch = text[i];
      if (ch === "'" || ch === '"' || ch === "`") {
        const q = ch;
        i++;
        while (i < len && text[i] !== q) {
          if (text[i] === "\\") i++;
          i++;
        }
        i++;
        continue;
      }
      if (ch === "(" || ch === "<" || ch === "[") {
        depth++;
        i++;
        continue;
      }
      if (ch === ")" || ch === ">" || ch === "]") {
        depth--;
        i++;
        continue;
      }
      if (ch === "{") {
        if (depth === 0) {
          // Check if this is a type literal `{ ... }` by looking for `:` or `;` before `}`
          // Scan ahead to see if there's a matching `}` followed by `{` or `=>`
          const closeBrace = findBodyEnd(text, i);
          const after = text.substring(closeBrace + 1).match(/^\s*(=>|{)/);
          if (after) {
            // This `{` is part of the type — skip to matching `}`
            i = closeBrace + 1;
            continue;
          }
          // This is the body `{`
          return i;
        }
        depth++;
        i++;
        continue;
      }
      if (ch === "}") {
        depth--;
        i++;
        continue;
      }
      if (depth === 0 && ch === "=" && i + 1 < len && text[i + 1] === ">") {
        i += 2;
        while (i < len && /\s/.test(text[i])) i++;
        return i;
      }
      i++;
    }
    return -1;
  }

  // => arrow
  if (i + 1 < len && text[i] === "=" && text[i + 1] === ">") {
    i += 2;
    while (i < len && /\s/.test(text[i])) i++;
    return i;
  }

  // Direct `{` body
  if (i < len && text[i] === "{") return i;

  return -1;
}

function isParabunEditor(editor: vscode.TextEditor): boolean {
  const lang = editor.document.languageId;
  return (
    lang === "parabun-ts" ||
    lang === "parabun-tsx" ||
    lang === "parabun-js" ||
    lang === "parabun-jsx" ||
    lang === "parabun-ui"
  );
}

function updatePureDecorations(editor: vscode.TextEditor) {
  if (!isParabunEditor(editor)) {
    editor.setDecorations(pureDecoration, []);
    return;
  }

  const text = editor.document.getText();
  const ranges: vscode.Range[] = [];
  const nameRanges: vscode.Range[] = [];

  // Match pure function/arrow declarations. The `(` / `<` cases use a
  // lookahead so `m[0]` ends at `pure` (or `pure async`) — findFunctionBodyStart
  // needs to see the full signature starting at `<` or `(`, not midway through
  // its param list.
  const pureRe = /\b(pure)\s+(?:async\s+)?(?:fun(?:ction)?\b|(?=<[\w\s,=]+>\s*\()|(?=\()|\w+\s*=>)/g;
  let m: RegExpExecArray | null;

  while ((m = pureRe.exec(text)) !== null) {
    const startOffset = m.index;

    // Extract the definition name
    const before = text.substring(0, m.index);
    // "const foo = pure ..." / "let foo = pure ..." / "const foo = <T> pure ..."
    // The optional `<...>` block tolerates a multi-line generic-parameter
    // header written before pure (e.g. `const foo = <T, U extends V> pure (...)`).
    const constMatch = before.match(/(?:const|let|var)\s+(\w+)\s*=\s*(?:<[\s\S]*?>\s*)?$/);
    // "pure function foo" or "pure async function foo"
    const fnMatch = text.substring(m.index).match(/^pure\s+(?:async\s+)?fun(?:ction)?\s+(\w+)/);
    const defName = fnMatch?.[1] ?? constMatch?.[1];
    if (defName) {
      let nameOffset: number;
      if (fnMatch?.[1]) {
        nameOffset = m.index + text.substring(m.index).indexOf(fnMatch[1], 5);
      } else {
        nameOffset = before.lastIndexOf(defName);
      }
      const nameStart = editor.document.positionAt(nameOffset);
      const nameEnd = editor.document.positionAt(nameOffset + defName.length);
      nameRanges.push(new vscode.Range(nameStart, nameEnd));
    }
    // Find the body start by skipping the signature (params + return type)
    let endOffset: number;
    const sigStart = m.index + m[0].length;
    const bodyStart = findFunctionBodyStart(text, sigStart);

    if (bodyStart !== -1 && text[bodyStart] === "{") {
      endOffset = findBodyEnd(text, bodyStart);
    } else if (bodyStart !== -1) {
      // Arrow expression body (no braces after =>)
      endOffset = findArrowExprEnd(text, bodyStart);
    } else {
      // Fallback: just highlight the line
      endOffset = text.indexOf("\n", m.index);
      if (endOffset === -1) endOffset = text.length - 1;
    }

    const startPos = editor.document.positionAt(startOffset);
    const endPos = editor.document.positionAt(endOffset);
    ranges.push(new vscode.Range(startPos.line, 0, endPos.line, editor.document.lineAt(endPos.line).text.length));
  }

  log.appendLine(`  found ${ranges.length} pure ranges, ${nameRanges.length} def names`);
  editor.setDecorations(pureDecoration, ranges);

  // Decorate pure function call sites (and definition names)
  updatePureCallDecorations(editor, nameRanges);
}

function collectLocalPureFnNames(text: string): Set<string> {
  const fns = new Set<string>();

  const declRe = /\bpure\s+(?:async\s+)?fun(?:ction)?\s+(\w+)/g;
  for (const m of text.matchAll(declRe)) fns.add(m[1]);

  // Whole-file scan tolerates a multi-line generic-parameter header between
  // `=` and `pure` (e.g. `const foo = <T, U extends ...> pure (...) => ...`),
  // which the per-line regex couldn't see.
  const exprRe = /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:<[\s\S]*?>\s*)?pure[\s<(]/g;
  for (const m of text.matchAll(exprRe)) fns.add(m[1]);

  return fns;
}

const KW_RE =
  /^(?:if|else|for|while|switch|case|return|throw|new|typeof|void|delete|in|of|do|try|catch|finally|import|export|default|class|function|fun|async|await|yield|const|let|var|true|false|null|undefined|pure)$/;

function findCallSiteRanges(
  editor: vscode.TextEditor,
  pureFns: Set<string>,
  defNameRanges: vscode.Range[],
): vscode.Range[] {
  const ranges: vscode.Range[] = [];
  if (pureFns.size === 0) return ranges;
  const text = editor.document.getText();
  const callRe = /\b(\w+)\s*(?:\(|<[\w\s,=<>\[\]|&]+>\s*\()/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(text)) !== null) {
    const name = m[1];
    if (pureFns.has(name) && !KW_RE.test(name)) {
      const start = editor.document.positionAt(m.index);
      const end = editor.document.positionAt(m.index + name.length);
      const range = new vscode.Range(start, end);
      if (!defNameRanges.some(d => d.contains(range))) {
        ranges.push(range);
      }
    }
  }
  return ranges;
}

async function updatePureCallDecorations(editor: vscode.TextEditor, defNameRanges: vscode.Range[]) {
  if (!isParabunEditor(editor)) {
    editor.setDecorations(pureCallDecoration, []);
    return;
  }

  // Always start with local-only detection (works without LSP)
  const text = editor.document.getText();
  const localFns = collectLocalPureFnNames(text);
  let callRanges = findCallSiteRanges(editor, localFns, defNameRanges);
  let allRanges = [...defNameRanges, ...callRanges];
  editor.setDecorations(pureCallDecoration, allRanges);

  // Then try LSP for cross-file resolution (may add more)
  if (client) {
    try {
      const resp = await client.sendRequest<{ names: string[] }>("parabun/pureFunctions", {
        textDocument: { uri: editor.document.uri.toString() },
      });
      const allFns = new Set(resp.names);
      if (allFns.size > localFns.size) {
        callRanges = findCallSiteRanges(editor, allFns, defNameRanges);
        allRanges = [...defNameRanges, ...callRanges];
        editor.setDecorations(pureCallDecoration, allRanges);
      }
      log.appendLine(`  pure names: ${allFns.size} (${localFns.size} local), ${allRanges.length} decorations`);
    } catch (e: any) {
      log.appendLine(`  LSP pureFunctions request failed (using local): ${e?.message ?? e}`);
    }
  } else {
    log.appendLine(`  LSP not ready, using ${localFns.size} local pure fns, ${allRanges.length} decorations`);
  }
}

// Returns the parabun binary's --revision output (e.g. "1.3.14-canary.1+abcdef0"
// for release, "1.3.14-debug+abcdef0" for debug). Empty string if the binary
// can't be found or doesn't respond. Synchronous + capped at 5 s — runs once
// at extension activation, not on hot paths.
function parabunRevision(lspPath: string): string {
  try {
    return execFileSync(lspPath, ["--revision"], { encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return "";
  }
}

export function activate(context: vscode.ExtensionContext) {
  log = vscode.window.createOutputChannel("Parabun Extension");
  log.appendLine("Parabun extension activating...");

  const config = vscode.workspace.getConfiguration("parabun");
  const lspPath = config.get<string>("lsp.path", "parabun");
  const lspScript = context.asAbsolutePath("server/parabun-lsp.ts");

  // Refuse to start against a debug-build parabun. The ASAN + tracing
  // overhead in debug makes the LSP unusable — typescript module load
  // alone takes ~10 s (vs 100 ms release), and cold semantic-diagnostic
  // latency on @lyku-sized graphs goes from ~4 s release to ~40 s
  // debug. Better to fail loudly with a clear message than to silently
  // ship a broken-feeling extension.
  const revision = parabunRevision(lspPath);
  if (revision.includes("-debug")) {
    const msg =
      `Parabun LSP refusing to start: \`${lspPath}\` is a debug build (${revision}). ` +
      `Debug builds are 10-100x slower than release and make the LSP unusable. ` +
      `Either: (1) point \`/usr/local/bin/parabun\` at a release build ` +
      `(\`sudo ln -sf /raid/parabun/build/release/bun /usr/local/bin/parabun\`), ` +
      `or (2) set "parabun.lsp.path" in your VS Code settings to an absolute path ` +
      `to a release-built parabun binary.`;
    log.appendLine(msg);
    vscode.window.showErrorMessage(msg);
    return;
  }
  if (revision) log.appendLine(`Parabun binary: ${revision}`);

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const serverOptions: ServerOptions = {
    command: lspPath,
    args: ["run", lspScript, "--stdio"],
    options: {
      cwd: workspaceFolder,
      env: { ...process.env, BUN_DEBUG_QUIET_LOGS: "1" },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "parabun-ts" },
      { scheme: "file", language: "parabun-tsx" },
      { scheme: "file", language: "parabun-js" },
      { scheme: "file", language: "parabun-jsx" },
      // .svelte files with `<script lang="pts|parabun|pjs">` blocks get
      // parabun-LSP diagnostics on the script regions; the rest of the file
      // (template/CSS) is left for the Svelte LSP (if installed) to handle.
      // Both LSPs co-exist on the same document; each only publishes
      // diagnostics for the parts it understands.
      { scheme: "file", language: "svelte" },
      // .pui files are claimed exclusively by parabun-LSP. The file
      // extension is the marker; bare `<script>` and `<script lang="ts">` are
      // also treated as parabun-flavored. svelte-LSP does NOT claim .pui
      // (different language ID), so there's no diagnostic duplication.
      { scheme: "file", language: "parabun-ui" },
    ],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.{pts,ptsx,pjs,pjsx,svelte,pui}"),
    },
  };

  const outputChannel = vscode.window.createOutputChannel("Parabun LSP");
  clientOptions.outputChannel = outputChannel;

  client = new LanguageClient("parabun-lsp", "Parabun Language Server", serverOptions, clientOptions);

  client.start().then(
    () => {
      outputChannel.appendLine("LSP server started successfully");
      // Re-trigger decorations now that LSP is ready for cross-file resolution
      for (const editor of vscode.window.visibleTextEditors) {
        updatePureDecorations(editor);
      }
    },
    err => {
      outputChannel.appendLine(`LSP server failed to start: ${err}`);
      vscode.window.showErrorMessage(`Parabun LSP failed: ${err.message || err}`);
    },
  );

  // Pure function green highlight
  for (const editor of vscode.window.visibleTextEditors) {
    updatePureDecorations(editor);
  }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor) updatePureDecorations(editor);
    }),
    vscode.workspace.onDidChangeTextDocument(event => {
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document === event.document) updatePureDecorations(editor);
      }
    }),
  );
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
