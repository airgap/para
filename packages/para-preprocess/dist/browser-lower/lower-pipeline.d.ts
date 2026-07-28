export declare function findPipelineChains(src: any): {
    start: number;
    end: any;
    original: any;
    lowered: any;
}[];
export declare function lowerPipeline(src: any): any;
export default function lowerPipelinePreprocess(): {
    name: string;
    script({ content, filename }: {
        content: any;
        filename: any;
    }): {
        code: any;
    } | undefined;
};
export { lowerPipelinePreprocess };
//# sourceMappingURL=lower-pipeline.d.ts.map