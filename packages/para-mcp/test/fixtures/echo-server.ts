// Minimal MCP server used by the @para/mcp test suite. Registers one
// tool, one resource, and one prompt — exercising every surface end-to-end.

import mcp from "../../src/index";

const server = mcp.serve({ name: "echo-test", version: "0.0.1" });

server.tool(
  "echo",
  {
    description: "Echoes the message back",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
  },
  async args => {
    const msg = String(args.message ?? "");
    return { content: [{ type: "text", text: msg }] };
  },
);

server.tool("fail", { description: "Always errors", inputSchema: { type: "object" } }, async () => {
  throw new mcp.MCPError({ code: -32000, message: "intentional failure" });
});

server.resource("echo://greeting", { name: "greeting", mimeType: "text/plain" }, async uri => ({
  contents: [{ uri, mimeType: "text/plain", text: "hello from echo-test" }],
}));

server.prompt(
  "wave",
  {
    description: "Wave at someone",
    arguments: [{ name: "name", description: "who to wave at", required: true }],
  },
  async args => ({
    description: "A wave",
    messages: [
      {
        role: "user",
        content: { type: "text", text: `wave at ${args.name ?? "world"}` },
      },
    ],
  }),
);

await server.listen("stdio");
