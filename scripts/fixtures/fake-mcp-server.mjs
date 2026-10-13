// Fake MCP server (stdio) for scripts/mock-mcp.ts. One JSON-RPC message per line.
import { createInterface } from "node:readline";

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
let clientAnsweredPing = false;
process.stderr.write("fake-mcp: starting (stderr is just logging)\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === "srv-ping" && msg.result) { clientAnsweredPing = true; return; }
  const { id, method, params } = msg;
  if (method === "initialize") {
    send({ id, result: { protocolVersion: process.env.FAKE_PROTO ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
  } else if (method === "tools/list" && !params?.cursor) {
    send({ id: "srv-ping", method: "ping" }); // server → client request
    send({ method: "notifications/message", params: { level: "info", data: "hello" } });
    send({ id, result: { tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } }, annotations: { readOnlyHint: true } }], nextCursor: "p2" } });
  } else if (method === "tools/list") {
    send({ id, result: { tools: [
      { name: "write_note", description: "Write a note", inputSchema: { type: "object", properties: { text: { type: "string" }, fail: { type: "boolean" } } } },
      { name: "crash", description: "Exit abruptly" },
      { name: "env_has_key", description: "Is ARC_API_KEY visible?", annotations: { readOnlyHint: true } },
    ] } });
  } else if (method === "tools/call") {
    const a = params.arguments ?? {};
    if (params.name === "echo") send({ id, result: { content: [{ type: "text", text: `echo: ${a.text}${clientAnsweredPing ? " (pong-ok)" : ""}` }] } });
    else if (params.name === "write_note" && a.fail) send({ id, result: { content: [{ type: "text", text: "disk full" }], isError: true } });
    else if (params.name === "write_note") send({ id, result: { content: [{ type: "text", text: `saved: ${a.text}` }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }] } });
    else if (params.name === "env_has_key") send({ id, result: { content: [{ type: "text", text: process.env.ARC_API_KEY ? "yes" : "no" }] } });
    else if (params.name === "crash") process.exit(3);
    else send({ id, error: { code: -32602, message: `unknown tool ${params.name}` } });
  } else if (id !== undefined) {
    send({ id, error: { code: -32601, message: `no method ${method}` } });
  }
});
