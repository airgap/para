# Parabun for VS Code

Language support for **Parabun** (`.pts` / `.pjs`) files — a Bun fork with pure functions, error chaining, and pipeline operators.

## Features

- Syntax highlighting for `.pts` (Parabun TypeScript) and `.pjs` (Parabun JavaScript)
- `pure` keyword highlighted as a storage modifier
- Parabun operators: `..!` (catch), `..&` (finally), `|>` (pipeline), `..` / `..=` (ranges)
- Full TypeScript/JavaScript grammar support (Parabun is a superset)

## Parabun Syntax

```pts
// Pure functions — visually distinct, compile-time enforced
pure function add(a: number, b: number): number {
  return a + b;
}

// Error chaining: desugars to .catch() / .finally()
const result = await fetch('/api') ..! console.error ..& cleanup;

// Pipeline: desugars to function application
const doubled = [1, 2, 3] |> JSON.stringify;
```

## Installation

Copy this folder to `~/.vscode/extensions/parabun/` or run:

```bash
cd /path/to/parabun/editors/vscode/parabun
code --install-extension .
```

## Theme Customization

Add to your `settings.json` to customize `pure` keyword color:

```json
"editor.tokenColorCustomizations": {
  "textMateRules": [
    {
      "scope": "storage.modifier.pure.parabun",
      "settings": {
        "foreground": "#7dcfff",
        "fontStyle": "italic"
      }
    },
    {
      "scope": "keyword.operator.pipeline.parabun",
      "settings": {
        "foreground": "#bb9af7"
      }
    }
  ]
}
```
