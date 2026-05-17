// Hardcoded module "@para/mcp"
//
// Model Context Protocol client. Two transports for v1: stdio (subprocess
// over newline-delimited JSON-RPC 2.0) and ws (WebSocket text frames,
// each frame one JSON-RPC message).
//
// Surface (LYK-733):
//
//   const conn = await mcp.connect("stdio", "home-assistant-mcp", { args, env });
//   const conn = await mcp.connect("ws", "ws://hub.local:8080/mcp");
//   conn.tools;                   // ToolDescriptor[] — name, description, inputSchema
//   await conn.call(name, args);  // dispatch to the server, returns result
//   await conn.close();           // releases transport; idempotent
//
// Out of scope for v1 (deferred):
//   - Server hosting (separate proposal).
//   - HTTP / SSE transport.
//   - Auth wrapper (OAuth, etc.) — pass credentials through env / args.
//   - Resources / prompts surfaces (only tools/* covered).

const childProcess = require("node:child_process");
import { signal as makeSignal, effect as makeEffect } from "@lyku/para-signals";

// ─── Types ─────────────────────────────────────────────────────────────────

type JsonRpcId = number | string;

type ToolDescriptor = {
  name: string;
  description?: string;
  inputSchema: object;
};

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string; text?: string; blob?: string } };

type ToolCallResult = {
  content: ToolContent[];
  isError?: boolean;
};

type ResourceDescriptor = {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
};

type ResourceContent = {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
};

type ReadResourceResult = {
  contents: ResourceContent[];
};

type PromptArgumentDescriptor = {
  name: string;
  description?: string;
  required?: boolean;
};

type PromptDescriptor = {
  name: string;
  description?: string;
  arguments?: PromptArgumentDescriptor[];
};

type PromptMessage = {
  role: "user" | "assistant" | "system";
  content: ToolContent;
};

type GetPromptResult = {
  description?: string;
  messages: PromptMessage[];
};

type StdioConnectOpts = {
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

type ConnectOpts = {
  /**
   * Override the protocolVersion sent in `initialize`. Defaults to the latest
   * shipping MCP spec version this client was built against.
   */
  protocolVersion?: string;
  /**
   * Override the clientInfo block sent in `initialize`.
   */
  clientInfo?: { name: string; version: string };
};

const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const DEFAULT_CLIENT_INFO = { name: "@para/mcp", version: "0.1.0" } as const;

interface Transport {
  send(msg: object): void;
  onMessage(cb: (msg: any) => void): void;
  onClose(cb: (err?: Error) => void): void;
  close(): Promise<void>;
}

// ─── MCPError ──────────────────────────────────────────────────────────────

class MCPError extends Error {
  code: number;
  data: unknown;
  constructor(err: { code: number; message: string; data?: unknown }) {
    super(`@para/mcp: ${err.message}`);
    this.name = "MCPError";
    this.code = err.code;
    this.data = err.data;
  }
}

// ─── MCPConnection ─────────────────────────────────────────────────────────

type NotificationListener = (params: any) => void;

class MCPConnection {
  #transport: Transport;
  #pending = new Map<JsonRpcId, { resolve: (v: any) => void; reject: (e: any) => void }>();
  #nextId = 1;
  #closed = false;
  // Notification subscribers keyed by method name. Server notifications
  // (no `id`, no response expected) fan out to every listener.
  #notificationListeners = new Map<string, Set<NotificationListener>>();
  // Lifetime signal — true from connect()/construction until close()
  // OR transport-close. Lets consumers react to disconnect without
  // polling. Effects bound via use() auto-tear-down on close.
  #alive = makeSignal(true);
  #boundEffects: Array<() => void> = [];

  // Populated by initialize().
  tools: ToolDescriptor[] = [];
  resources: ResourceDescriptor[] = [];
  prompts: PromptDescriptor[] = [];
  serverInfo: { name?: string; version?: string } | null = null;
  protocolVersion: string | null = null;
  /** Capabilities advertised by the server. */
  serverCapabilities: Record<string, unknown> = {};

  constructor(transport: Transport) {
    this.#transport = transport;
    transport.onMessage(msg => this.#dispatch(msg));
    transport.onClose(err => this.#onTransportClose(err));
  }

  /** Lifetime signal — true while the connection is open. */
  get alive() {
    return this.#alive;
  }

  /**
   * Run an effect bound to this connection's lifetime. Behaves like
   * `signals.effect(fn)` but is automatically disposed when the
   * connection closes — no defensive `if (alive.get())` guards needed.
   */
  use(fn: () => void | (() => void)): () => void {
    const stop = makeEffect(fn);
    this.#boundEffects.push(stop);
    return stop;
  }

  async #request<T = any>(method: string, params?: unknown): Promise<T> {
    if (this.#closed) throw new Error("@para/mcp: connection is closed");
    const id = this.#nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    this.#pending.set(id, { resolve, reject });
    try {
      this.#transport.send({ jsonrpc: "2.0", id, method, params });
    } catch (e) {
      this.#pending.delete(id);
      throw e;
    }
    return promise;
  }

  #notify(method: string, params?: unknown): void {
    if (this.#closed) return;
    try {
      this.#transport.send({ jsonrpc: "2.0", method, params });
    } catch {
      // Notifications are fire-and-forget; ignore transport write failures.
    }
  }

  #dispatch(msg: any): void {
    if (!msg || typeof msg !== "object") return;
    // Response (has id + result/error).
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      if (msg.error) pending.reject(new MCPError(msg.error));
      else pending.resolve(msg.result);
      return;
    }
    // Server notification (method, no id). Built-in handling for the
    // list-changed events refreshes the cached catalog; anything
    // subscribed via `on(method, …)` runs after that.
    if (msg.id === undefined && typeof msg.method === "string") {
      const method: string = msg.method;
      if (method === "notifications/tools/list_changed") {
        this.refreshTools().catch(() => {});
      } else if (method === "notifications/resources/list_changed") {
        this.refreshResources().catch(() => {});
      } else if (method === "notifications/prompts/list_changed") {
        this.refreshPrompts().catch(() => {});
      }
      const listeners = this.#notificationListeners.get(method);
      if (listeners)
        for (const cb of listeners) {
          try {
            cb(msg.params);
          } catch {}
        }
    }
  }

  /**
   * Subscribe to a server-emitted notification (e.g.
   * `"notifications/resources/updated"`). Returns an unsubscribe
   * function. Built-in `notifications/{tools,resources,prompts}/list_changed`
   * events still automatically refresh the cached catalog regardless
   * of any listener.
   */
  on(method: string, cb: NotificationListener): () => void {
    let set = this.#notificationListeners.get(method);
    if (!set) {
      set = new Set();
      this.#notificationListeners.set(method, set);
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
      if (set!.size === 0) this.#notificationListeners.delete(method);
    };
  }

  #onTransportClose(err?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    const cause = err ?? new Error("@para/mcp: transport closed");
    for (const p of this.#pending.values()) p.reject(cause);
    this.#pending.clear();
    this.#flipDeadAndTearDown();
  }

  #flipDeadAndTearDown(): void {
    if (!this.#alive.peek()) return;
    this.#alive.set(false);
    while (this.#boundEffects.length > 0) {
      const stop = this.#boundEffects.pop()!;
      try {
        stop();
      } catch {}
    }
  }

  /**
   * Performs the MCP `initialize` handshake and caches the tool list. Called
   * automatically by `mcp.connect()`; exposed for advanced use where the
   * caller wired the transport themselves.
   */
  async initialize(opts: ConnectOpts = {}): Promise<void> {
    const init = await this.#request<{
      protocolVersion: string;
      capabilities?: Record<string, unknown>;
      serverInfo?: { name: string; version: string };
    }>("initialize", {
      protocolVersion: opts.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
      // Advertise interest in every catalog the spec defines. The server
      // chooses which it actually exposes via its own `capabilities`; we
      // skip prefetching the surfaces it doesn't claim.
      capabilities: { tools: {}, resources: {}, prompts: {} },
      clientInfo: opts.clientInfo ?? DEFAULT_CLIENT_INFO,
    });
    this.protocolVersion = init.protocolVersion;
    this.serverCapabilities = init.capabilities ?? {};
    this.serverInfo = init.serverInfo ?? null;

    // The MCP spec requires the client to send `notifications/initialized`
    // once the handshake is complete. Servers may reject other requests
    // until it arrives.
    this.#notify("notifications/initialized");

    // Prefetch each catalog the server advertises. Errors fall back to
    // an empty cache rather than failing the whole initialize.
    const advertised = (cap: string) => cap in this.serverCapabilities;
    await Promise.all([
      advertised("tools") ? this.refreshTools().catch(() => []) : Promise.resolve([]),
      advertised("resources") ? this.refreshResources().catch(() => []) : Promise.resolve([]),
      advertised("prompts") ? this.refreshPrompts().catch(() => []) : Promise.resolve([]),
    ]);
  }

  // ─── Tools surface ───────────────────────────────────────────────────

  async refreshTools(): Promise<ToolDescriptor[]> {
    const list = await this.#request<{ tools?: ToolDescriptor[] }>("tools/list");
    this.tools = list?.tools ?? [];
    return this.tools;
  }

  /**
   * Invoke a tool by name. Returns the server's `ToolCallResult` shape.
   */
  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    if (typeof name !== "string" || !name) {
      throw new TypeError("@para/mcp: tool name must be a non-empty string");
    }
    return this.#request<ToolCallResult>("tools/call", { name, arguments: args });
  }

  // ─── Resources surface ───────────────────────────────────────────────

  async refreshResources(): Promise<ResourceDescriptor[]> {
    const list = await this.#request<{ resources?: ResourceDescriptor[] }>("resources/list");
    this.resources = list?.resources ?? [];
    return this.resources;
  }

  /**
   * Read a resource by URI. Returns the server's `ReadResourceResult`
   * — `{ contents: [{ uri, text? | blob?, mimeType? }, …] }`.
   */
  async readResource(uri: string): Promise<ReadResourceResult> {
    if (typeof uri !== "string" || !uri) {
      throw new TypeError("@para/mcp: resource uri must be a non-empty string");
    }
    return this.#request<ReadResourceResult>("resources/read", { uri });
  }

  /**
   * Subscribe to change notifications for a single resource URI. The
   * server responds with `notifications/resources/updated` events;
   * subscribe via `on("notifications/resources/updated", cb)` to
   * receive them. Returns an unsubscribe function.
   */
  async subscribeResource(uri: string): Promise<() => Promise<void>> {
    await this.#request("resources/subscribe", { uri });
    return async () => {
      await this.#request("resources/unsubscribe", { uri }).catch(() => {});
    };
  }

  // ─── Prompts surface ─────────────────────────────────────────────────

  async refreshPrompts(): Promise<PromptDescriptor[]> {
    const list = await this.#request<{ prompts?: PromptDescriptor[] }>("prompts/list");
    this.prompts = list?.prompts ?? [];
    return this.prompts;
  }

  /**
   * Render a prompt by name with arguments. Returns the server's
   * `GetPromptResult` shape — `{ description?, messages: PromptMessage[] }`.
   */
  async getPrompt(name: string, args: Record<string, string> = {}): Promise<GetPromptResult> {
    if (typeof name !== "string" || !name) {
      throw new TypeError("@para/mcp: prompt name must be a non-empty string");
    }
    return this.#request<GetPromptResult>("prompts/get", { name, arguments: args });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const p of this.#pending.values()) {
      p.reject(new Error("@para/mcp: connection closed"));
    }
    this.#pending.clear();
    try {
      await this.#transport.close();
    } catch {
      // Best-effort close.
    }
    this.#flipDeadAndTearDown();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

// ─── Stdio transport ───────────────────────────────────────────────────────

function makeStdioTransport(command: string, opts: StdioConnectOpts): Transport {
  const proc = childProcess.spawn(command, opts.args ?? [], {
    env: opts.env ?? process.env,
    cwd: opts.cwd,
    // stderr: "inherit" so server logs surface during dev. stdout/stdin
    // carry the protocol; both are line-buffered.
    stdio: ["pipe", "pipe", "inherit"],
  });

  let onMessage: ((msg: any) => void) | null = null;
  let onClose: ((err?: Error) => void) | null = null;
  let buffer = "";
  let closed = false;

  proc.stdout!.setEncoding("utf8");
  proc.stdout!.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      onMessage?.(msg);
    }
  });

  proc.on("exit", code => {
    if (closed) return;
    closed = true;
    onClose?.(code === 0 ? undefined : new Error(`@para/mcp: stdio server exited with code ${code}`));
  });
  proc.on("error", err => {
    if (closed) return;
    closed = true;
    onClose?.(err);
  });

  return {
    send(msg) {
      if (closed) throw new Error("@para/mcp: stdio transport is closed");
      proc.stdin!.write(JSON.stringify(msg) + "\n");
    },
    onMessage(cb) {
      onMessage = cb;
    },
    onClose(cb) {
      onClose = cb;
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        proc.stdin!.end();
      } catch {}
      // Give the server a chance to exit cleanly; SIGTERM after 2s.
      const exited = new Promise<void>(resolve => proc.once("exit", () => resolve()));
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGTERM");
        } catch {}
      }, 2000);
      await exited;
      clearTimeout(timer);
    },
  };
}

// ─── WebSocket transport ───────────────────────────────────────────────────

function makeWsTransport(url: string): Promise<Transport> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      reject(e);
      return;
    }

    let onMessage: ((msg: any) => void) | null = null;
    let onClose: ((err?: Error) => void) | null = null;
    let opened = false;
    let closed = false;

    ws.addEventListener("open", () => {
      opened = true;
      resolve({
        send(msg) {
          if (closed) throw new Error("@para/mcp: ws transport is closed");
          ws.send(JSON.stringify(msg));
        },
        onMessage(cb) {
          onMessage = cb;
        },
        onClose(cb) {
          onClose = cb;
        },
        async close() {
          if (closed) return;
          closed = true;
          try {
            ws.close();
          } catch {}
        },
      });
    });

    ws.addEventListener("message", e => {
      if (!onMessage) return;
      const data = e.data;
      if (typeof data !== "string") return; // binary frames are not protocol
      try {
        onMessage(JSON.parse(data));
      } catch {
        // ignore malformed frames
      }
    });

    ws.addEventListener("error", () => {
      if (opened) return; // post-open errors surface via "close"
      reject(new Error(`@para/mcp: WebSocket error connecting to ${url}`));
    });

    ws.addEventListener("close", e => {
      if (closed) return;
      closed = true;
      if (!opened) {
        reject(new Error(`@para/mcp: WebSocket closed before open (code=${e.code})`));
        return;
      }
      onClose?.(e.code === 1000 ? undefined : new Error(`@para/mcp: WebSocket closed (code=${e.code})`));
    });
  });
}

// ─── Public connect() ──────────────────────────────────────────────────────

async function connect(
  transport: "stdio",
  command: string,
  opts?: StdioConnectOpts & ConnectOpts,
): Promise<MCPConnection>;
async function connect(transport: "ws", url: string, opts?: ConnectOpts): Promise<MCPConnection>;
async function connect(
  transport: "stdio" | "ws",
  target: string,
  opts: (StdioConnectOpts & ConnectOpts) | ConnectOpts = {},
): Promise<MCPConnection> {
  let t: Transport;
  if (transport === "stdio") {
    t = makeStdioTransport(target, opts as StdioConnectOpts);
  } else if (transport === "ws") {
    t = await makeWsTransport(target);
  } else {
    throw new Error(`@para/mcp: unknown transport "${transport}". Use "stdio" or "ws".`);
  }
  const conn = new MCPConnection(t);
  try {
    await conn.initialize(opts as ConnectOpts);
  } catch (e) {
    await conn.close().catch(() => {});
    throw e;
  }
  return conn;
}

// ─── Server side ───────────────────────────────────────────────────────────
//
// The MCP spec is a symmetric JSON-RPC; the server side handles the
// `initialize` handshake and routes inbound `tools/list`, `tools/call`,
// `resources/list`, `resources/read`, `resources/subscribe`,
// `prompts/list`, `prompts/get` requests to user-registered handlers.
//
// Surface:
//
//   const server = mcp.serve({ name: "weather", version: "0.1.0" });
//   server.tool("get_temp", { description, inputSchema }, async args => ({
//     content: [{ type: "text", text: `${args.location}: 72°F` }],
//   }));
//   server.resource("weather://current", { name, mimeType: "application/json" },
//     async () => ({ contents: [{ uri: "weather://current", text: "{...}" }] }));
//   server.prompt("forecast", { description }, async args => ({
//     messages: [{ role: "user", content: { type: "text", text: "…" } }],
//   }));
//   await server.listen("stdio"); // resolves when the transport closes.
//
// The server is JSON-RPC literal — handlers throw `MCPError` (or any
// Error; non-MCPError gets wrapped as code -32603) to surface a JSON-RPC
// error to the caller.

type ToolHandler = (args: Record<string, unknown>) => ToolCallResult | Promise<ToolCallResult>;
type ResourceHandler = (uri: string) => ReadResourceResult | Promise<ReadResourceResult>;
type PromptHandler = (args: Record<string, string>) => GetPromptResult | Promise<GetPromptResult>;

type ServerOpts = {
  name: string;
  version?: string;
  /** Server's protocol version sent in the initialize response. */
  protocolVersion?: string;
};

class MCPServer {
  #opts: ServerOpts;
  #tools = new Map<string, { descriptor: ToolDescriptor; handler: ToolHandler }>();
  #resources = new Map<string, { descriptor: ResourceDescriptor; handler: ResourceHandler }>();
  #prompts = new Map<string, { descriptor: PromptDescriptor; handler: PromptHandler }>();
  #transport: Transport | null = null;
  #initialized = false;
  #closed = false;
  #closedPromise: Promise<void> | null = null;
  #closedResolve: (() => void) | null = null;
  // Lifetime signal — true from serve() construction until listen()
  // resolves OR close() is called. Effects bound via use() auto-tear-
  // down when the server stops.
  #alive = makeSignal(true);
  #boundEffects: Array<() => void> = [];

  constructor(opts: ServerOpts) {
    if (!opts || typeof opts.name !== "string" || !opts.name) {
      throw new TypeError("@para/mcp: serve() requires { name, version? }");
    }
    this.#opts = { name: opts.name, version: opts.version ?? "0.1.0", protocolVersion: opts.protocolVersion };
  }

  /** Lifetime signal — true while the server is serving requests. */
  get alive() {
    return this.#alive;
  }

  /**
   * Run an effect bound to this server's lifetime. Auto-disposed when
   * the server stops — no defensive `if (alive.get())` guards needed.
   */
  use(fn: () => void | (() => void)): () => void {
    const stop = makeEffect(fn);
    this.#boundEffects.push(stop);
    return stop;
  }

  /**
   * Register a tool. The handler receives the raw arguments object and
   * returns a `ToolCallResult` (or a Promise of one).
   */
  tool(name: string, descriptor: Omit<ToolDescriptor, "name">, handler: ToolHandler): this {
    if (this.#tools.has(name)) throw new Error(`@para/mcp: tool "${name}" already registered`);
    this.#tools.set(name, { descriptor: { name, ...descriptor }, handler });
    if (this.#initialized) this.#notifyListChanged("tools");
    return this;
  }

  /**
   * Register a resource by URI. The handler is called when the client
   * issues `resources/read` for this URI; it must return the resource
   * contents in the `ReadResourceResult` shape.
   */
  resource(uri: string, descriptor: Omit<ResourceDescriptor, "uri">, handler: ResourceHandler): this {
    if (this.#resources.has(uri)) throw new Error(`@para/mcp: resource "${uri}" already registered`);
    this.#resources.set(uri, { descriptor: { uri, ...descriptor }, handler });
    if (this.#initialized) this.#notifyListChanged("resources");
    return this;
  }

  /**
   * Register a prompt. The handler receives the rendered argument map
   * and returns a `GetPromptResult`.
   */
  prompt(name: string, descriptor: Omit<PromptDescriptor, "name">, handler: PromptHandler): this {
    if (this.#prompts.has(name)) throw new Error(`@para/mcp: prompt "${name}" already registered`);
    this.#prompts.set(name, { descriptor: { name, ...descriptor }, handler });
    if (this.#initialized) this.#notifyListChanged("prompts");
    return this;
  }

  /**
   * Push a `notifications/resources/updated` event to the client. Use
   * after the data behind a registered resource has changed.
   */
  notifyResourceUpdated(uri: string): void {
    this.#send({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri } });
  }

  #notifyListChanged(catalog: "tools" | "resources" | "prompts"): void {
    this.#send({ jsonrpc: "2.0", method: `notifications/${catalog}/list_changed` });
  }

  /**
   * Start serving on the given transport. For `"stdio"` the server
   * reads JSON-RPC frames from stdin and writes them to stdout.
   * Returns a Promise that resolves when the transport closes.
   */
  async listen(transportKind: "stdio" | Transport): Promise<void> {
    if (this.#transport) throw new Error("@para/mcp: server is already listening");
    const t = transportKind === "stdio" ? makeStdioServerTransport() : transportKind;
    this.#transport = t;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#closedPromise = promise;
    this.#closedResolve = resolve;
    t.onMessage(msg => this.#dispatch(msg));
    t.onClose(() => {
      if (this.#closed) return;
      this.#closed = true;
      this.#flipDeadAndTearDown();
      this.#closedResolve?.();
    });
    return promise;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#transport?.close();
    } catch {}
    this.#flipDeadAndTearDown();
    this.#closedResolve?.();
  }

  #flipDeadAndTearDown(): void {
    if (!this.#alive.peek()) return;
    this.#alive.set(false);
    while (this.#boundEffects.length > 0) {
      const stop = this.#boundEffects.pop()!;
      try {
        stop();
      } catch {}
    }
  }

  #send(msg: object): void {
    if (this.#closed || !this.#transport) return;
    try {
      this.#transport.send(msg);
    } catch {
      // Best-effort write; if the transport collapses the close handler runs.
    }
  }

  #dispatch(msg: any): void {
    if (!msg || typeof msg !== "object") return;
    // Notifications from the client (no id, no response).
    if (msg.id === undefined && typeof msg.method === "string") {
      if (msg.method === "notifications/initialized") this.#initialized = true;
      return;
    }
    if (msg.id === undefined || typeof msg.method !== "string") return;
    this.#handleRequest(msg).catch(err => {
      this.#send({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: err instanceof MCPError ? err.code : -32603,
          message: err instanceof Error ? err.message : String(err),
        },
      });
    });
  }

  async #handleRequest(msg: { id: JsonRpcId; method: string; params?: any }): Promise<void> {
    const { id, method, params } = msg;
    let result: unknown;
    switch (method) {
      case "initialize":
        result = {
          protocolVersion: this.#opts.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
          capabilities: {
            ...(this.#tools.size > 0 ? { tools: { listChanged: true } } : {}),
            ...(this.#resources.size > 0 ? { resources: { listChanged: true, subscribe: true } } : {}),
            ...(this.#prompts.size > 0 ? { prompts: { listChanged: true } } : {}),
          },
          serverInfo: { name: this.#opts.name, version: this.#opts.version ?? "0.1.0" },
        };
        break;
      case "tools/list":
        result = { tools: [...this.#tools.values()].map(t => t.descriptor) };
        break;
      case "tools/call": {
        const name = params?.name;
        const entry = this.#tools.get(name);
        if (!entry) throw new MCPError({ code: -32602, message: `unknown tool: ${name}` });
        result = await entry.handler(params?.arguments ?? {});
        break;
      }
      case "resources/list":
        result = { resources: [...this.#resources.values()].map(r => r.descriptor) };
        break;
      case "resources/read": {
        const uri = params?.uri;
        const entry = this.#resources.get(uri);
        if (!entry) throw new MCPError({ code: -32602, message: `unknown resource: ${uri}` });
        result = await entry.handler(uri);
        break;
      }
      case "resources/subscribe":
      case "resources/unsubscribe":
        // Subscriptions are tracked client-side only in v1; the server
        // simply accepts them and pushes `notifications/resources/updated`
        // unconditionally when the user calls notifyResourceUpdated().
        result = {};
        break;
      case "prompts/list":
        result = { prompts: [...this.#prompts.values()].map(p => p.descriptor) };
        break;
      case "prompts/get": {
        const name = params?.name;
        const entry = this.#prompts.get(name);
        if (!entry) throw new MCPError({ code: -32602, message: `unknown prompt: ${name}` });
        result = await entry.handler(params?.arguments ?? {});
        break;
      }
      default:
        throw new MCPError({ code: -32601, message: `method not found: ${method}` });
    }
    this.#send({ jsonrpc: "2.0", id, result });
  }
}

// ─── Server-side stdio transport ───────────────────────────────────────────

function makeStdioServerTransport(): Transport {
  let onMessage: ((msg: any) => void) | null = null;
  let onClose: ((err?: Error) => void) | null = null;
  let buffer = "";
  let closed = false;

  process.stdin.setEncoding("utf8");
  const onData = (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      onMessage?.(msg);
    }
  };
  const onEnd = () => {
    if (closed) return;
    closed = true;
    onClose?.();
  };
  process.stdin.on("data", onData);
  process.stdin.on("end", onEnd);

  return {
    send(msg) {
      if (closed) throw new Error("@para/mcp: server stdio transport is closed");
      process.stdout.write(JSON.stringify(msg) + "\n");
    },
    onMessage(cb) {
      onMessage = cb;
    },
    onClose(cb) {
      onClose = cb;
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        process.stdin.off("data", onData);
        process.stdin.off("end", onEnd);
      } catch {}
    },
  };
}

function serve(opts: ServerOpts): MCPServer {
  return new MCPServer(opts);
}

export default {
  connect,
  serve,
  MCPError,
};
