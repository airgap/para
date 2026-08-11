/**
 * Lower Para `match SUBJECT { p1 => r1, p2 => r2, _ => default }` to an
 * equivalent JS expression. The all-literal-patterns case is what the
 * demos use; we lower to a `((__pm) => __pm === p1 ? r1 : __pm === p2
 * ? r2 : default)(SUBJECT)` ternary chain. Non-literal patterns
 * (Ok/Err/Some/None, destructure, guards) would need the parabun
 * zig-side lowering: out of scope for the browser live-compile
 * pipeline, which is what the editable demos use.
 *
 * Brace-aware: subjects can be complex expressions ending at `{`; each
 * arm is split on top-level commas (depth-tracked across `{}/[]/()`
 * and through string/template literals). Strings, template literals,
 * and `// + /* … *\/` comments are skipped so a `match` literal inside
 * a string isn't mis-rewritten.
 */
declare function lowerMatch(src: any): string;
/**
 * Svelte preprocess that lowers `match` in `<script>` blocks of .pui
 * files. Runs BEFORE parabunPreprocess in svelte.config.js so the
 * (still-published-as-stub-only) match keyword is gone by the time
 * Bun.Transpiler / Svelte's parser sees the source.
 */
export default function lowerMatchPreprocess(): {
    name: string;
    script({ content, filename }: {
        content: any;
        filename: any;
    }): {
        code: string;
    } | undefined;
};
export { lowerMatch };
//# sourceMappingURL=lower-match.d.ts.map