#!/usr/bin/env node
// stdio MCP server for the Withings Public API (community, read-only data tools, zero dependencies).
// Not made or endorsed by Withings. Reads only the data of the person who authorized it.
// Logs go to stderr and never contain the client secret, authorization codes or tokens.
import { createInterface } from "node:readline";
import { Client, WithingsError } from "./client.mjs";
import { TOOLS } from "./tools.mjs";

export const SERVER_INFO = { name: "personal-health-data", title: "Personal Health Data (community) · Compatible with Withings", version: "0.2.0" };
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export function makeHandler(client = new Client()) {
  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  return async function handle(msg) {
    const { id, method, params } = msg;
    const ok = (result) => ({ jsonrpc: "2.0", id, result });
    const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
    switch (method) {
      case "initialize": {
        const v = PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[0];
        return ok({
          protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO,
          instructions: "Read-only access to the authorizing user's own Withings data via the Withings Public API. Community project, not affiliated with Withings. Dates are YYYY-MM-DD in the user's local time; nulls mean not measured.",
        });
      }
      case "ping": return ok({});
      case "tools/list":
        return ok({ tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })) });
      case "tools/call": {
        const tool = byName.get(params?.name);
        if (!tool) return fail(-32602, `Unknown tool: ${params?.name}`);
        try {
          const result = await tool.run(client, params.arguments || {});
          return ok({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false });
        } catch (e) {
          const text = client.redact(e instanceof WithingsError ? e.message : `Unexpected error: ${e?.message || e}`);
          process.stderr.write(`[personal-health-data] ${params?.name}: ${text}\n`);
          return ok({ content: [{ type: "text", text }], isError: true });
        }
      }
      default:
        if (id === undefined || id === null) return null;   // notifications
        return fail(-32601, `Method not found: ${method}`);
    }
  };
}

export function serve({ input = process.stdin, output = process.stdout, client } = {}) {
  const handle = makeHandler(client);
  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { output.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n"); return; }
    const res = await handle(msg);
    if (res) output.write(JSON.stringify(res) + "\n");
  });
  return rl;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("server/index.mjs")) serve();
