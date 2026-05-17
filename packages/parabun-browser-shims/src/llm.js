// Browser shim for `parabun:llm`. The upstream is a from-scratch GGUF +
// Llama runtime with CUDA kernels. Browser-side inference is doable —
// WebGPU compute shaders can run the matVec/attention kernels, but
// that's a substantial port. V1 of this shim throws on load with a
// clear explanation; applications should import `parabun:llm` lazily and
// degrade to an API-hosted inference path.
//
// TODO: a `ParabunWebLLM` module that ports the Q4_K / Q6_K kernels
// to WGSL and reuses the tokenizer / sampler code unchanged.

const NOT_IMPL_MSG =
  "parabun-browser-shims: parabun:llm has no browser backend wired yet. " +
  "Use the CUDA/Metal native module via parabun in a server/Electron " +
  "context, or route requests to a remote inference endpoint.";

function notImplemented(name) {
  return () => {
    throw new Error(`${NOT_IMPL_MSG} (called ${name})`);
  };
}

class LLM {
  static load() {
    throw new Error(`${NOT_IMPL_MSG} (called LLM.load)`);
  }
}

const stub = {
  LLM,
  loadGGUF: notImplemented("loadGGUF"),
  GGUFFile: notImplemented("GGUFFile"),
  GGML_TYPE_F32: 0,
  GGML_TYPE_F16: 1,
  GGML_TYPE_Q8_0: 8,
  GGML_TYPE_Q2_K: 10,
  GGML_TYPE_Q3_K: 11,
  GGML_TYPE_Q4_K: 12,
  GGML_TYPE_Q5_K: 13,
  GGML_TYPE_Q6_K: 14,
  LlamaModel: notImplemented("LlamaModel"),
  KVCache: notImplemented("KVCache"),
  llamaFromGGUF: notImplemented("llamaFromGGUF"),
  argmax: notImplemented("argmax"),
  Sampler: notImplemented("Sampler"),
  sample: notImplemented("sample"),
  LlamaTokenizer: notImplemented("LlamaTokenizer"),
  tokenizerFromGGUF: notImplemented("tokenizerFromGGUF"),
  parseGBNF: notImplemented("parseGBNF"),
  compileSchema: notImplemented("compileSchema"),
  Grammar: notImplemented("Grammar"),
};

export { LLM };
export default stub;
