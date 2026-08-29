// Manual smoke check for the MCP server.
//
// Run it from the directory this file is in:
//
//   TRAWLIA_API_KEY=twl_... node smoke.mjs
//   TRAWLIA_BASE_URL=http://127.0.0.1:8099 TRAWLIA_API_KEY=... node smoke.mjs
//
// Deliberately not in CI: it spends real credits against a real API. What it
// proves is the half that unit tests cannot - that the stdio transport
// handshakes, the tools list, a search comes back rendered, and a rejected
// parameter reaches the model as readable text with isError set rather than as
// a stack trace or a silent empty result.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const t = new StdioClientTransport({
  command: "node",
  args: [new URL("server.mjs", import.meta.url).pathname],
  env: { ...process.env },
});
const c = new Client({ name: "test", version: "1" }, { capabilities: {} });
await c.connect(t);

const tools = await c.listTools();
console.log("TOOLS:", tools.tools.map(x => x.name).join(", "));

const r = await c.callTool({ name: "trawlia_search", arguments: { query: "capital of Australia", search_depth: "basic", max_results: 3 } });
console.log("--- SEARCH (isError:" + !!r.isError + ") ---");
console.log(r.content[0].text.slice(0, 700));

const bad = await c.callTool({ name: "trawlia_search", arguments: { query: "x", include_images: true } });
console.log("--- UNSUPPORTED PARAM (isError:" + !!bad.isError + ") ---");
console.log(bad.content[0].text);

const ex = await c.callTool({ name: "trawlia_extract", arguments: { urls: ["https://example.com/"] } });
console.log("--- EXTRACT (isError:" + !!ex.isError + ") ---");
console.log(ex.content[0].text.slice(0, 300));

await c.close();
