declare function lowerInlineSnippets(source: any): any;
export default function paraInlineSnippets(): {
    name: string;
    markup({ content, filename }: {
        content: any;
        filename: any;
    }): {
        code: any;
    } | undefined;
};
export { lowerInlineSnippets };
//# sourceMappingURL=para-inline-snippets.d.ts.map