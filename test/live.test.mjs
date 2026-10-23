// Live, read-only smoke test against YOUR account. Skipped unless WITHINGS_LIVE=1 and you have authorized.
// Prints only counts, never values, ids, secrets or tokens.
import test from "node:test";
import assert from "node:assert/strict";
import { Client, readConfig } from "../server/client.mjs";
import { makeHandler } from "../server/index.mjs";

const cfg = readConfig();
const live = process.env.WITHINGS_LIVE === "1" && cfg.clientId && cfg.clientSecret;
test("live: body measurements (30 days), devices", { skip: !live && "set WITHINGS_LIVE=1, WITHINGS_CLIENT_ID/SECRET and authorize first" }, async () => {
  const client = new Client(); const h = makeHandler(client);
  const call = async (name, args = {}) => {
    const r = await h({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: args } });
    assert.equal(r.result.isError, false, r.result.content[0].text);
    return r.result.structuredContent;
  };
  const body = await call("get_body_measurements");
  const dev = await call("list_devices");
  console.log(JSON.stringify({ weigh_ins_30d: body.count, devices: dev.count, requests: client.stats.requests, refreshes: client.stats.refreshes }));
});
