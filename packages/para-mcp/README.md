# @para/mcp

A Model Context Protocol implementation — **client and server**, both shapes of the spec. Two transports:

- **stdio** — subprocess over newline-delimited JSON-RPC 2.0
- **ws** — WebSocket text frames (client only)

## Client

```js
import mcp from "@para/mcp";

await using conn = await mcp.connect("stdio", "node", {
  args: ["./my-mcp-server.js"],
});

console.log(conn.tools);     // ToolDescriptor[]
console.log(conn.resources); // ResourceDescriptor[]
console.log(conn.prompts);   // PromptDescriptor[]

// Tools
const r = await conn.call("read_file", { path: "/etc/hostname" });

// Resources
const res = await conn.readResource("file:///etc/hostname");

// Prompts
const p = await conn.getPrompt("summarize", { length: "short" });

// Server-pushed notifications
const off = conn.on("notifications/resources/updated", ({ uri }) => {
  console.log("resource changed:", uri);
});
const unsubscribe = await conn.subscribeResource("file:///watched");
// later…
await unsubscribe();
off();
```

The `tools` / `resources` / `prompts` arrays are populated by `connect()` and refreshed automatically when the server emits `notifications/{tools,resources,prompts}/list_changed`. Call `refreshTools()` / `refreshResources()` / `refreshPrompts()` to force a manual refresh.

### Composing with `@para/assistant`

The connection is structurally compatible with `@para/assistant`'s `tools:` option — the assistant flattens every tool the connection exposes into its own catalog and routes calls back through `conn.call`.

```js
import assistant from "@para/assistant";
const bot = assistant.create({ llm, tools: [conn] });
```

## Server

```js
import mcp from "@para/mcp";

const server = mcp.serve({ name: "weather", version: "0.1.0" });

server.tool(
  "get_temp",
  {
    description: "Current temperature for a US ZIP",
    inputSchema: {
      type: "object",
      properties: { zip: { type: "string" } },
      required: ["zip"],
    },
  },
  async ({ zip }) => ({
    content: [{ type: "text", text: `${zip}: 72°F` }],
  }),
);

server.resource(
  "weather://current",
  { name: "current", mimeType: "application/json" },
  async uri => ({
    contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ tempF: 72 }) }],
  }),
);

server.prompt(
  "forecast",
  {
    description: "Generate a forecast paragraph",
    arguments: [{ name: "location", required: true }],
  },
  async ({ location }) => ({
    messages: [{ role: "user", content: { type: "text", text: `Write a forecast for ${location}` } }],
  }),
);

// Resolves when the transport closes (stdin EOF, or whatever).
await server.listen("stdio");
```

The server advertises `tools` / `resources` / `prompts` capabilities only when at least one of each is registered, so a tools-only server doesn't claim resource support. `tool()` / `resource()` / `prompt()` registered after `listen()` automatically push the corresponding `notifications/.../list_changed` event to the connected client.

To push a `notifications/resources/updated` event after the data behind a registered resource has changed:

```js
server.notifyResourceUpdated("weather://current");
```

### Throwing from handlers

Throw `mcp.MCPError({ code, message, data? })` to send a specific JSON-RPC error code to the client. Any other throw is wrapped as `-32603 (Internal error)` with the error's message string.

## Out of scope

- HTTP / SSE transports (the WebSocket transport covers most server-push cases)
- OAuth wrappers — pass credentials through `env` / `args` on stdio, or in the WS URL
- Sampling (server-initiated `sampling/createMessage` requests)
- Completions (`completion/complete`)

## Requires

`node:child_process` for the stdio client transport. `process.stdin` / `process.stdout` for the stdio server transport. Works on Node, Bun, Deno, ParaBun. Browser-only environments are client + WS only.

## Status

`private:true / 0.0.0-dev` — pending the workspace split. See [parabun.script.dev](https://parabun.script.dev) for the runtime-bundled story today.
