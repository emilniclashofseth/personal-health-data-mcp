// Offline tests: a fake Withings API (no network, no credentials). Tokens and secrets here are dummies.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client, readConfig, resolveRange, defaultTokenFile } from "../server/client.mjs";
import { makeHandler } from "../server/index.mjs";
import { TOOLS, mergeSessions, decodeGroup, nightSleep, dayActivity } from "../server/tools.mjs";
import { startAuthorization, stopListener } from "../server/auth-flow.mjs";

const ID = "dummy-client-id", SECRET = "dummy-client-secret-xyz";
const hex = (c) => c.repeat(40);
const json = (o, status = 200) => new Response(JSON.stringify(o), { status });

async function setup({ routes = [], tokens } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wpd-test-"));
  const tokenFile = path.join(dir, "cfg", "tokens.json");
  if (tokens) { await (await import("node:fs/promises")).mkdir(path.dirname(tokenFile), { recursive: true }); await writeFile(tokenFile, JSON.stringify(tokens)); }
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url); const body = Object.fromEntries(new URLSearchParams(opts.body || ""));
    calls.push({ path: u.pathname, body, auth: opts.headers?.Authorization });
    if (u.pathname === "/v2/oauth2") {
      n++;
      if (body.grant_type === "refresh_token" && body.refresh_token === hex("d")) return json({ status: 503, error: "Invalid refresh_token" });
      return json({ status: 0, body: { userid: 4242, access_token: hex(String.fromCharCode(97 + n)), refresh_token: hex(String.fromCharCode(110 + n)), expires_in: 10800, scope: "user.info,user.metrics,user.activity", token_type: "Bearer" } });
    }
    for (const [re, fn] of routes) if (re.test(u.pathname + "#" + (body.action || ""))) return fn(body, calls);
    return json({ status: 2555, error: "unknown" });
  };
  const env = { WITHINGS_CLIENT_ID: ID, WITHINGS_CLIENT_SECRET: SECRET, WITHINGS_TOKEN_FILE: tokenFile };
  const client = new Client({ env, fetchImpl, pauseMs: 0, wait: async () => {} });
  return { client, calls, tokenFile, env, h: makeHandler(client) };
}
const call = async (h, name, args = {}) => (await h({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).result;
const fresh = () => ({ access_token: hex("1"), refresh_token: hex("2"), expires_in: 10800, obtained_at: Math.floor(Date.now() / 1000), scope: "user.metrics" });

test("config: unexpanded placeholders count as unset; token file is outside the repo", () => {
  const c = readConfig({ WITHINGS_CLIENT_ID: "${WITHINGS_CLIENT_ID}", WITHINGS_CLIENT_SECRET: "", HOME: "/home/u", XDG_CONFIG_HOME: "/home/u/.config" });
  assert.equal(c.clientId, null); assert.equal(c.clientSecret, null);
  assert.equal(c.redirectUri, "http://localhost:8765/callback");
  assert.match(defaultTokenFile({ XDG_CONFIG_HOME: "/x/.config" }), /personal-health-data-mcp[\\/]tokens\.json$/);
});

test("date validation", () => {
  assert.throws(() => resolveRange({ start_date: "2026-02-30", end_date: "2026-03-01" }));
  assert.throws(() => resolveRange({ start_date: "2026-10-05", end_date: "2026-10-01" }));
  assert.throws(() => resolveRange({ start_date: "2024-01-01", end_date: "2026-01-01" }));
  assert.equal(resolveRange({ end_date: "2026-10-23" }, { defaultDays: 30 }).start, "2026-09-24");
});

test("missing credentials give setup help and make no request", async () => {
  const calls = [];
  const h = makeHandler(new Client({ env: {}, fetchImpl: async (u) => { calls.push(u); return json({}); } }));
  const r = await call(h, "get_body_measurements");
  assert.equal(r.isError, true); assert.match(r.content[0].text, /developer\.withings\.com\/dashboard/); assert.equal(calls.length, 0);
});

test("authorization URL asks only for read scopes", async () => {
  const { client } = await setup();
  const a = client.authorizationUrl("st");
  const u = new URL(a.url);
  assert.equal(u.origin + u.pathname, "https://account.withings.com/oauth2_user/authorize2");
  assert.equal(u.searchParams.get("scope"), "user.info,user.metrics,user.activity");
  assert.ok(!/write|user\.sleepevents/.test(u.searchParams.get("scope")));
  assert.equal(u.searchParams.get("state"), "st");
});

test("exchange_code stores tokens with mode 600, without userid, and returns no token", async () => {
  const { h, tokenFile, calls } = await setup();
  const r = await call(h, "exchange_code", { redirect_url_or_code: "https://example.com/cb?code=abc123&state=zzz" });
  assert.equal(r.isError, false, r.content[0].text);
  assert.ok(!r.content[0].text.includes(hex("b")) && !r.content[0].text.includes(hex("o")));
  const saved = JSON.parse(await readFile(tokenFile, "utf8"));
  assert.equal(saved.access_token, hex("b")); assert.equal(saved.userid, undefined);
  if (process.platform !== "win32") {
    assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(tokenFile))).mode & 0o777, 0o700);
  }
  assert.equal(calls[0].body.code, "abc123"); assert.equal(calls[0].body.grant_type, "authorization_code");
});

test("expired access token is refreshed and the rotated refresh token is saved", async () => {
  const old = { ...fresh(), obtained_at: Math.floor(Date.now() / 1000) - 4 * 3600 };
  const { h, tokenFile, calls } = await setup({ tokens: old, routes: [[/measure#getmeas/, () => json({ status: 0, body: { timezone: "Europe/Oslo", measuregrps: [] } })]] });
  const r = await call(h, "get_body_measurements", { start_date: "2026-10-01", end_date: "2026-10-02" });
  assert.equal(r.isError, false, r.content[0].text);
  assert.equal(calls[0].body.grant_type, "refresh_token"); assert.equal(calls[0].body.refresh_token, hex("2"));
  const saved = JSON.parse(await readFile(tokenFile, "utf8"));
  assert.equal(saved.refresh_token, hex("o")); assert.equal(calls[1].auth, `Bearer ${hex("b")}`);
});

test("valid token is reused; status 401 in the body triggers one forced refresh", async () => {
  let m = 0;
  const { h, calls } = await setup({ tokens: fresh(), routes: [[/user#getdevice/, () => (++m === 1 ? json({ status: 401, error: "invalid_token" }) : json({ status: 0, body: { devices: [{ type: "Scale", model: "Body+", battery: "high", deviceid: "secretdev", last_session_date: 1761200000 }] } }))]] });
  const r = await call(h, "list_devices");
  assert.equal(r.isError, false, r.content[0].text);
  assert.deepEqual(calls.map((c) => c.path), ["/v2/user", "/v2/oauth2", "/v2/user"]);
  assert.ok(!r.content[0].text.includes("secretdev"));
  assert.equal(r.structuredContent.items[0].model, "Body+");
});

test("rejected refresh token tells the user to re-authorize", async () => {
  const { h } = await setup({ tokens: { ...fresh(), refresh_token: hex("d"), obtained_at: 1 } });
  const r = await call(h, "list_devices");
  assert.equal(r.isError, true); assert.match(r.content[0].text, /re-authorize/i);
});

test("rate limit (601) and HTTP 5xx are retried", async () => {
  let m = 0;
  const { h, client } = await setup({ tokens: fresh(), routes: [[/v2\/sleep#getsummary/, () => (++m === 1 ? json({ status: 601 }) : m === 2 ? new Response("x", { status: 502 }) : json({ status: 0, body: { series: [], more: false } }))]] });
  const r = await call(h, "get_sleep_summary", { start_date: "2026-10-01", end_date: "2026-10-07" });
  assert.equal(r.isError, false, r.content[0].text); assert.equal(client.stats.throttled, 1); assert.equal(client.stats.retries, 2);
});

test("errors never contain the secret or tokens", async () => {
  const { h } = await setup({ tokens: fresh(), routes: [[/measure#getmeas/, () => json({ status: 2554, error: `bad ${SECRET} ${hex("1")} ${hex("9")}` })]] });
  const r = await call(h, "get_body_measurements", { start_date: "2026-10-01", end_date: "2026-10-02" });
  const t = r.content[0].text;
  assert.equal(r.isError, true);
  assert.ok(!t.includes(SECRET) && !t.includes(hex("1")) && !t.includes(hex("9")), t);
  assert.match(t, /REDACTED/);
});

test("body measurements: units decoded, one row per step-on, nulls kept, paging followed", async () => {
  const t0 = Date.UTC(2026, 9, 20, 5, 30) / 1000;   // 07:30 in Oslo
  const g1 = { grpid: 1, date: t0, category: 1, attrib: 0, deviceid: "d1", model: "Body Scan", measures: [{ type: 1, value: 80123, unit: -3 }] };
  const g2 = { grpid: 2, date: t0 + 20, category: 1, attrib: 0, deviceid: "d1", measures: [{ type: 1, value: 8010, unit: -2 }, { type: 6, value: 18345, unit: -3 }, { type: 76, value: 6200, unit: -2 }, { type: 170, value: 7, unit: 0 }] };
  const g3 = { grpid: 3, date: t0 + 86400, category: 1, attrib: 2, measures: [{ type: 1, value: 799, unit: -1 }] };
  const g4 = { grpid: 4, date: t0, category: 2, measures: [{ type: 1, value: 90, unit: 0 }] };   // objective, not a measure
    const { h, calls } = await setup({ tokens: fresh(), routes: [[/measure#getmeas/, (b) => (!b.offset ? json({ status: 0, body: { timezone: "Europe/Oslo", measuregrps: [g1, g2], more: 1, offset: 2 } }) : json({ status: 0, body: { timezone: "Europe/Oslo", measuregrps: [g3, g4], more: 0 } }))]] });
  const r = await call(h, "get_body_measurements", { start_date: "2026-10-20", end_date: "2026-10-21" });
  assert.equal(r.isError, false, r.content[0].text);
  const s = r.structuredContent;
  assert.equal(calls.filter((c) => c.path === "/measure").length, 2); assert.equal(calls[1].body.offset, "2");
  assert.equal(s.count, 2); assert.equal(s.data_source, "Withings"); assert.equal(s.units.fat_ratio_pct, "%");
  const [a, b] = s.items;
  assert.deepEqual([a.date, a.time_local, a.weight_kg, a.fat_ratio_pct, a.muscle_mass_kg, a.visceral_fat, a.bone_mass_kg, a.measure_groups], ["2026-10-20", "07:30", 80.1, 18.3, 62, 7, null, 2]);
  assert.deepEqual([b.source, b.weight_kg, b.fat_ratio_pct], ["manual", 79.9, null]);
  assert.ok(!JSON.stringify(s).includes("d1"));
  const r2 = await call(h, "get_body_measurements", { start_date: "2026-10-20", end_date: "2026-10-21", include_manual: false });
  assert.equal(r2.structuredContent.count, 1);
});

test("blood pressure, activity and sleep shapes", async () => {
  const t0 = Date.UTC(2026, 9, 20, 18, 0) / 1000;
  const { h } = await setup({ tokens: fresh(), routes: [
    [/measure#getmeas/, () => json({ status: 0, body: { timezone: "Europe/Oslo", measuregrps: [{ date: t0, category: 1, attrib: 0, measures: [{ type: 10, value: 121, unit: 0 }, { type: 9, value: 79, unit: 0 }, { type: 11, value: 61, unit: 0 }] }, { date: t0 + 60, category: 1, measures: [{ type: 11, value: 70, unit: 0 }] }] } })],
    [/v2\/measure#getactivity/, () => json({ status: 0, body: { activities: [{ date: "2026-10-20", steps: 9000, distance: 6543.2, active: 1830, calories: 400.4, totalcalories: 2300, hr_average: null, is_tracker: true }], more: false } })],
    [/v2\/sleep#getsummary/, () => json({ status: 0, body: { series: [{ date: "2026-10-21", timezone: "Europe/Oslo", startdate: Date.UTC(2026, 9, 20, 21, 30) / 1000, enddate: Date.UTC(2026, 9, 21, 5, 0) / 1000, model: 32, data: { total_sleep_time: 24000, deepsleepduration: 4800, sleep_efficiency: 0.89, sleep_score: 78 } }] } })],
  ] });
  const bp = (await call(h, "get_blood_pressure", { start_date: "2026-10-20", end_date: "2026-10-20" })).structuredContent;
  assert.deepEqual([bp.count, bp.items[0].systolic_mmhg, bp.items[0].diastolic_mmhg, bp.items[0].pulse_bpm, bp.items[0].time_local], [1, 121, 79, 61, "20:00"]);
  const act = (await call(h, "get_daily_activity", { start_date: "2026-10-20", end_date: "2026-10-20" })).structuredContent;
  assert.deepEqual([act.items[0].steps, act.items[0].distance_km, act.items[0].active_min, act.items[0].hr_avg, act.items[0].floors], [9000, 6.54, 31, null, null]);
  const sl = (await call(h, "get_sleep_summary", { start_date: "2026-10-21", end_date: "2026-10-21" })).structuredContent;
  assert.deepEqual([sl.items[0].total_sleep_min, sl.items[0].deep_min, sl.items[0].sleep_efficiency_pct, sl.items[0].start_local, sl.items[0].rem_min], [400, 80, 89, "2026-10-20 23:30", null]);
});

test("localhost callback: listener checks state, exchanges, and saves the token", async () => {
  const { client, tokenFile, env } = await setup();
  env.WITHINGS_REDIRECT_URI = "http://localhost:18765/callback";
  const r = await startAuthorization(client, { timeoutMs: 5000 });
  assert.equal(r.listening, true);
  const bad = await fetch("http://127.0.0.1:18765/callback?code=x&state=wrong");
  assert.equal(bad.status, 400);
  const st = new URL(r.authorization_url).searchParams.get("state");
  const ok = await fetch(`http://127.0.0.1:18765/callback?code=good&state=${st}`);
  assert.equal(ok.status, 200);
  assert.equal((await r._result).ok, true);
  assert.ok(JSON.parse(await readFile(tokenFile, "utf8")).refresh_token);
  stopListener();
});

test("MCP handshake, tools/list and annotations", async () => {
  const { h } = await setup();
  const init = await h({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(await h({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const list = await h({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(list.result.tools.map((t) => t.name), TOOLS.map((t) => t.name));
  for (const t of list.result.tools) if (!["start_authorization", "exchange_code"].includes(t.name)) assert.equal(t.annotations.readOnlyHint, true, t.name);
});

test("pure transforms keep nulls", () => {
  assert.equal(nightSleep({ data: {} }).sleep_score, null);
  assert.equal(dayActivity({}).steps, null);
  const g = decodeGroup({ date: 0, measures: [{ type: 999, value: 1, unit: 0 }] }, "UTC", [1]);
  assert.deepEqual(g.vals, {});
  assert.equal(mergeSessions([], [1]).length, 0);
});
