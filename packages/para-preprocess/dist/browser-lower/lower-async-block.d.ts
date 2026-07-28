export declare function lowerAsyncBlock(src: any): string;
export default function lowerAsyncBlockPreprocess(): {
    name: string;
    script({ content, filename }: {
        content: any;
        filename: any;
    }): {
        code: string;
    } | undefined;
};
export { lowerAsyncBlockPreprocess };
//# sourceMappingURL=lower-async-block.d.ts.map