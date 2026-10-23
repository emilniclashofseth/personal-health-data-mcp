// Offline tests: a fake Withings API (no network, no credentials). Tokens and secrets here are dummies.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client, callbackKey, readConfig, readEnvFile, resolveRange, defaultTokenFile } from "../server/client.mjs";
import { makeHandler } from "../server/index.mjs";
import { TOOLS, mergeSessions, decodeGroup, nightSleep, dayActivity } from "../server/tools.mjs";
import { startAuthorization, stopListener, pendingState } from "../server/auth-flow.mjs";

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
  assert.equal(c.redirectUriSource, "default");
  const cPh = readConfig({ WITHINGS_REDIRECT_URI: "${WITHINGS_REDIRECT_URI}", WITHINGS_CLIENT_ID: ID, WITHINGS_CLIENT_SECRET: SECRET });
  assert.equal(cPh.redirectUriSource, "default");
  assert.match(cPh.redirectWarning, /redirect_uri_mismatch/);
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
  const r = await call(h, "exchange_code", { redirect_url_or_code: "http://localhost:8765/callback?code=abc123&state=zzz" });
  assert.equal(r.isError, false, r.content[0].text);
  assert.ok(!r.content[0].text.includes(hex("b")) && !r.content[0].text.includes(hex("o")));
  const saved = JSON.parse(await readFile(tokenFile, "utf8"));
  assert.equal(saved.access_token, hex("b")); assert.equal(saved.userid, undefined);
  assert.equal(saved.redirect_uri, "http://localhost:8765/callback");
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
  assert.match(init.result.instructions, /setup_guide/);
  assert.match(init.result.instructions, /redirect_warning/);
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

test("WITHINGS_ENV_FILE: values read without shell expansion; explicit env wins; unknown keys ignored", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wpd-env-"));
  const f = path.join(dir, "withings.env");
  await writeFile(f, `# my Withings app\nexport WITHINGS_CLIENT_ID=${ID}\nWITHINGS_CLIENT_SECRET="${SECRET}"\nWITHINGS_REDIRECT_URI='http://localhost:9999/cb'\nWITHINGS_TOKEN_FILE=${dir}/t.json\nPATH=/evil\nOTHER=$HOME\n`, { mode: 0o600 });
  const c = readConfig({ WITHINGS_ENV_FILE: f });
  assert.deepEqual([c.clientId, c.clientSecret, c.redirectUri, c.tokenFile, c.envFileError], [ID, SECRET, "http://localhost:9999/cb", `${dir}/t.json`, null]);
  assert.equal(c.redirectUriSource, "env_file");
  assert.equal(readEnvFile(f).values.PATH, undefined);
  // Cursor-style unexpanded placeholders count as unset, so the file fills them; a real env value wins.
  const c2 = readConfig({ WITHINGS_ENV_FILE: f, WITHINGS_CLIENT_ID: "${WITHINGS_CLIENT_ID}", WITHINGS_REDIRECT_URI: "http://localhost:8765/callback" });
  assert.deepEqual([c2.clientId, c2.redirectUri], [ID, "http://localhost:8765/callback"]);
  assert.equal(c2.redirectUriSource, "environment");
  assert.match(c2.configStaleWarning, /localhost:9999\/cb/);
  assert.match(c2.configStaleWarning, /restart/);
  // Secret from the file is used for token requests and redacted from errors.
  const calls = [];
  const client = new Client({ env: { WITHINGS_ENV_FILE: f }, pauseMs: 0, wait: async () => {}, fetchImpl: async (u, o) => { calls.push(Object.fromEntries(new URLSearchParams(o.body))); return json({ status: 503, error: `bad ${SECRET}` }); } });
  const r = await call(makeHandler(client), "exchange_code", { redirect_url_or_code: "abc" });
  assert.equal(calls[0].client_secret, SECRET);
  assert.equal(r.isError, true); assert.ok(!r.content[0].text.includes(SECRET));
});

test("WITHINGS_ENV_FILE missing: setup help names the file, no request", async () => {
  const calls = [];
  const h = makeHandler(new Client({ env: { WITHINGS_ENV_FILE: "/nonexistent/withings.env" }, fetchImpl: async (u) => { calls.push(u); return json({}); } }));
  const r = await call(h, "list_devices");
  assert.equal(r.isError, true); assert.match(r.content[0].text, /WITHINGS_ENV_FILE .* could not be read \(ENOENT\)/); assert.equal(calls.length, 0);
  const st = (await call(h, "auth_status")).structuredContent;
  assert.equal(st.client_configured, false); assert.match(st.env_file_problem, /ENOENT/); assert.match(st.next_step, /WITHINGS_ENV_FILE/);
});

test("setup help is client-neutral", async () => {
  const { SETUP_HELP } = await import("../server/client.mjs");
  assert.match(SETUP_HELP, /MCP client/); assert.match(SETUP_HELP, /WITHINGS_ENV_FILE/);
});

test("auth_status separates requested scopes from what Withings granted (user.sleepevents explained)", async () => {
  const { h } = await setup({ tokens: { ...fresh(), scope: "user.info,user.metrics,user.activity,user.sleepevents" } });
  const st = (await call(h, "auth_status")).structuredContent;
  assert.deepEqual(st.requested_scopes, ["user.info", "user.metrics", "user.activity"]);
  assert.deepEqual(st.granted_scopes, ["user.info", "user.metrics", "user.activity", "user.sleepevents"]);
  assert.match(st.extra_granted_scopes["user.sleepevents"], /notifications/);
  const list = await h({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const sa = list.result.tools.find((t) => t.name === "start_authorization").description;
  assert.match(sa, /user\.info, user\.metrics, user\.activity/); assert.match(sa, /user\.sleepevents/);
});

test("get_sleep_summary with no nights returns a hint pointing at list_devices", async () => {
  const { h } = await setup({ tokens: fresh(), routes: [[/v2\/sleep#getsummary/, () => json({ status: 0, body: { series: [], more: false } })]] });
  const r = await call(h, "get_sleep_summary", { start_date: "2026-10-01", end_date: "2026-10-07" });
  assert.equal(r.isError, false); assert.equal(r.structuredContent.count, 0); assert.match(r.structuredContent.hint, /list_devices/);
});

test("remote browser: localhost listener pending, exchange_code with the pasted URL finishes and stops the listener", async () => {
  const { client, h, tokenFile, env } = await setup();
  env.WITHINGS_REDIRECT_URI = "http://localhost:18766/callback";
  const r = await startAuthorization(client, { timeoutMs: 5000 });
  assert.equal(r.listening, true); assert.match(r.next_step, /another computer/);
  const st = new URL(r.authorization_url).searchParams.get("state");
  const bad = await call(h, "exchange_code", { redirect_url_or_code: `http://localhost:18766/callback?code=x&state=wrong` });
  assert.equal(bad.isError, true); assert.match(bad.content[0].text, /state/);
  const ok = await call(h, "exchange_code", { redirect_url_or_code: `http://localhost:18766/callback?code=good&state=${st}` });
  assert.equal(ok.isError, false, ok.content[0].text);
  assert.ok(JSON.parse(await readFile(tokenFile, "utf8")).refresh_token);
  assert.equal(pendingState(), null);
  await assert.rejects(fetch("http://127.0.0.1:18766/callback"));   // listener closed
});

test("failed code exchange explains the redirect URI it used (mismatch troubleshooting)", async () => {
  const calls = [];
  const env = { WITHINGS_CLIENT_ID: ID, WITHINGS_CLIENT_SECRET: SECRET, WITHINGS_REDIRECT_URI: "https://example.com/cb" };
  const h = makeHandler(new Client({ env, pauseMs: 0, wait: async () => {}, fetchImpl: async (u, o) => { calls.push(o); return json({ status: 503, error: "Invalid Params: invalid redirect_uri" }); } }));
  const r = await call(h, "exchange_code", { redirect_url_or_code: "abc" });
  assert.equal(r.isError, true); assert.match(r.content[0].text, /redirect_uri=https:\/\/example\.com\/cb/); assert.match(r.content[0].text, /character for character/);
  assert.match(r.content[0].text, /rejected the callback URL/);
  assert.ok(!r.content[0].text.includes(SECRET) && !r.content[0].text.includes("abc"));
});

test("invalid code and redirect mismatch get different advice; HTTP error pages are explained too", async () => {
  const mk = (body, status = 200) => makeHandler(new Client({
    env: { WITHINGS_CLIENT_ID: ID, WITHINGS_CLIENT_SECRET: SECRET, WITHINGS_REDIRECT_URI: "https://example.com/cb", WITHINGS_TOKEN_FILE: path.join(os.tmpdir(), "no-such-tokens.json") },
    pauseMs: 0, wait: async () => {},
    fetchImpl: async () => new Response(JSON.stringify(body), { status }),
  }));
  const badCode = await call(mk({ status: 304, error: "The authorization code is absent or incorrect" }), "exchange_code", { redirect_url_or_code: "abc" });
  assert.equal(badCode.isError, true);
  assert.match(badCode.content[0].text, /rejected the authorization code/);
  assert.match(badCode.content[0].text, /30 seconds/);
  assert.doesNotMatch(badCode.content[0].text, /rejected the callback URL/);
  const mismatch = await call(mk({ status: 293, error: "The callback URL is either absent or incorrect" }), "exchange_code", { redirect_url_or_code: "abc" });
  assert.match(mismatch.content[0].text, /rejected the callback URL/);
  assert.match(mismatch.content[0].text, /redirect_uri=https:\/\/example\.com\/cb/);
  assert.match(mismatch.content[0].text, /character for character/);
  const http = await call(mk({ error: "redirect_uri_mismatch: The redirect URI provided is missing or does not match partner callback url" }, 400), "exchange_code", { redirect_url_or_code: "abc" });
  assert.match(http.content[0].text, /redirect_uri_mismatch/);
  assert.match(http.content[0].text, /character for character/);
  assert.ok(!http.content[0].text.includes(SECRET));
});

test("pasted callback guard accepts browser normalization and still rejects a real mismatch", async () => {
  assert.equal(callbackKey("https://example.com"), "https://example.com/");
  assert.equal(callbackKey("https://example.com/"), "https://example.com/");
  assert.equal(callbackKey("https://Example.com/cb"), "https://example.com/cb");
  assert.equal(callbackKey("https://example.com:443/cb"), "https://example.com/cb");
  assert.equal(callbackKey("http://example.com:80/cb"), "http://example.com/cb");
  assert.equal(callbackKey("http://localhost:8765/callback/"), "http://localhost:8765/callback/");
  assert.notEqual(callbackKey("http://localhost:8765/callback"), callbackKey("http://localhost:8765/callback/"));
  assert.notEqual(callbackKey("http://localhost:8765/callback"), callbackKey("http://127.0.0.1:8765/callback"));
  assert.equal(callbackKey("not a url"), null);

  const accept = [
    ["https://example.com", "https://example.com/?code=abc&state=s"],
    ["https://example.com/cb", "https://Example.com/cb?code=abc&state=s"],
    ["https://example.com/cb", "https://example.com:443/cb?code=abc&state=s"],
    ["http://example.com/cb", "http://example.com:80/cb?code=abc&state=s"],
    ["https://Example.com/cb", "https://example.com/cb?code=abc&state=s"],
  ];
  for (const [redirect, pasted] of accept) {
    let sent = null;
    const dir = await mkdtemp(path.join(os.tmpdir(), "wpd-norm-"));
    const h = makeHandler(new Client({
      env: { WITHINGS_CLIENT_ID: ID, WITHINGS_CLIENT_SECRET: SECRET, WITHINGS_REDIRECT_URI: redirect, WITHINGS_TOKEN_FILE: path.join(dir, "t.json") },
      pauseMs: 0, wait: async () => {},
      fetchImpl: async (u, o) => { sent = Object.fromEntries(new URLSearchParams(o.body)); return json({ status: 0, body: { access_token: hex("a"), refresh_token: hex("n"), expires_in: 10800, scope: "user.info" } }); },
    }));
    const r = await call(h, "exchange_code", { redirect_url_or_code: pasted });
    assert.equal(r.isError, false, `${redirect} vs ${pasted}: ${r.content[0].text}`);
    assert.equal(sent.redirect_uri, redirect);
    assert.equal(sent.code, "abc");
    assert.ok(!r.content[0].text.includes("abc"));
  }

  const reject = [
    ["http://localhost:8765/callback", "http://localhost:8765/callback/?code=other-code&state=z"],
    ["http://localhost:8765/callback", "http://127.0.0.1:8765/callback?code=other-code&state=z"],
    ["https://example.com/cb", "https://example.com:8443/cb?code=other-code&state=z"],
  ];
  for (const [redirect, pasted] of reject) {
    let n = 0;
    const h = makeHandler(new Client({
      env: { WITHINGS_CLIENT_ID: ID, WITHINGS_CLIENT_SECRET: SECRET, WITHINGS_REDIRECT_URI: redirect, WITHINGS_TOKEN_FILE: path.join(os.tmpdir(), "no-such-tokens.json") },
      pauseMs: 0, wait: async () => {}, fetchImpl: async () => { n++; return json({ status: 0, body: {} }); },
    }));
    const r = await call(h, "exchange_code", { redirect_url_or_code: pasted });
    assert.equal(r.isError, true, redirect);
    assert.equal(n, 0);
    assert.match(r.content[0].text, /was not sent/);
    assert.ok(!r.content[0].text.includes("other-code"));
  }

  let n = 0; let sent = null;
  const dir = await mkdtemp(path.join(os.tmpdir(), "wpd-skip-"));
  const skip = makeHandler(new Client({
    env: { WITHINGS_CLIENT_ID: ID, WITHINGS_CLIENT_SECRET: SECRET, WITHINGS_REDIRECT_URI: "not a url", WITHINGS_TOKEN_FILE: path.join(dir, "t.json") },
    pauseMs: 0, wait: async () => {},
    fetchImpl: async (u, o) => { n++; sent = Object.fromEntries(new URLSearchParams(o.body)); return json({ status: 0, body: { access_token: hex("a"), refresh_token: hex("n"), expires_in: 10800 } }); },
  }));
  const skipped = await call(skip, "exchange_code", { redirect_url_or_code: "https://example.com/cb?code=abc&state=s" });
  assert.equal(skipped.isError, false, skipped.content[0].text);
  assert.equal(n, 1);
  assert.equal(sent.redirect_uri, "not a url");
});

test("a pasted callback that differs is rejected before any request and the code is not echoed", async () => {
  let n = 0;
  const h = makeHandler(new Client({
    env: { WITHINGS_CLIENT_ID: ID, WITHINGS_CLIENT_SECRET: SECRET, WITHINGS_REDIRECT_URI: "http://localhost:8765/callback", WITHINGS_TOKEN_FILE: path.join(os.tmpdir(), "no-such-tokens.json") },
    pauseMs: 0, wait: async () => {}, fetchImpl: async () => { n++; return json({ status: 0, body: {} }); },
  }));
  const r = await call(h, "exchange_code", { redirect_url_or_code: "https://mine.example/cb?code=super-secret-code&state=z" });
  assert.equal(r.isError, true);
  assert.equal(n, 0);
  assert.match(r.content[0].text, /https:\/\/mine\.example\/cb/);
  assert.match(r.content[0].text, /http:\/\/localhost:8765\/callback/);
  assert.match(r.content[0].text, /was not sent/);
  assert.ok(!r.content[0].text.includes("super-secret-code"));
  const slash = await call(h, "exchange_code", { redirect_url_or_code: "http://localhost:8765/callback/?code=other-code&state=z" });
  assert.equal(slash.isError, true);
  assert.match(slash.content[0].text, /callback\//);
  assert.equal(n, 0);
});

test("env file redirect is re-read on the next call; a set environment variable overrides it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wpd-reread-"));
  const f = path.join(dir, "withings.env");
  await writeFile(f, `WITHINGS_CLIENT_ID=${ID}\nWITHINGS_CLIENT_SECRET=${SECRET}\nWITHINGS_TOKEN_FILE=${dir}/none.json\n`);
  const env = { WITHINGS_ENV_FILE: f };
  const client = new Client({ env, pauseMs: 0, wait: async () => {}, fetchImpl: async () => json({ status: 0, body: {} }) });
  let st = await client.status();
  assert.equal(st.redirect_uri_source, "default");
  assert.equal(st.redirect_uri_defaulted, true);
  assert.equal(st.config_stale_warning, null);
  assert.ok(!JSON.stringify(st).includes(SECRET));
  await writeFile(f, `WITHINGS_CLIENT_ID=${ID}\nWITHINGS_CLIENT_SECRET=${SECRET}\nWITHINGS_TOKEN_FILE=${dir}/none.json\nWITHINGS_REDIRECT_URI=https://example.com/cb\n`);
  st = await client.status();
  assert.equal(st.redirect_uri, "https://example.com/cb");
  assert.equal(st.redirect_uri_source, "env_file");
  assert.equal(st.redirect_uri_defaulted, false);
  assert.match(st.config_note, /re-read/);
  env.WITHINGS_REDIRECT_URI = "http://localhost:8765/callback";
  st = await client.status();
  assert.equal(st.redirect_uri, "http://localhost:8765/callback");
  assert.equal(st.redirect_uri_source, "environment");
  assert.match(st.config_stale_warning, /https:\/\/example\.com\/cb/);
  assert.match(st.config_stale_warning, /restart/);
  assert.match(st.process_started_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("saved token records the redirect; a later change is flagged; refresh keeps the original", async () => {
  const { client, h, env, tokenFile } = await setup({ routes: [[/user#getdevice/, () => json({ status: 0, body: { devices: [] } })]] });
  const ex = await call(h, "exchange_code", { redirect_url_or_code: "http://localhost:8765/callback?code=abc123&state=z" });
  assert.equal(ex.isError, false, ex.content[0].text);
  let saved = JSON.parse(await readFile(tokenFile, "utf8"));
  assert.equal(saved.redirect_uri, "http://localhost:8765/callback");
  assert.equal(saved.userid, undefined);
  env.WITHINGS_REDIRECT_URI = "https://example.com/cb";
  const st = (await call(h, "auth_status")).structuredContent;
  assert.equal(st.redirect_changed_since_authorization, true);
  assert.equal(st.redirect_action, "differs_from_saved_token");
  assert.equal(st.setup_step, "redirect_attention");
  assert.match(st.redirect_changed_warning, /https:\/\/example\.com\/cb/);
  assert.match(st.redirect_changed_warning, /http:\/\/localhost:8765\/callback/);
  saved.obtained_at = 1;
  await writeFile(tokenFile, JSON.stringify(saved));
  client.tokens = null;
  const listed = await call(h, "list_devices");
  assert.equal(listed.isError, false, listed.content[0].text);
  saved = JSON.parse(await readFile(tokenFile, "utf8"));
  assert.equal(saved.redirect_uri, "http://localhost:8765/callback");
  assert.ok(!JSON.stringify(st).includes(SECRET));
});

test("old token files without a recorded redirect do not raise a mismatch", async () => {
  const { h } = await setup({ tokens: fresh() });
  const st = (await call(h, "auth_status")).structuredContent;
  assert.equal(st.token_redirect_uri, null);
  assert.equal(st.redirect_changed_since_authorization, false);
  assert.equal(st.redirect_changed_warning, null);
  assert.equal(st.setup_step, "confirm");
  assert.deepEqual(st.missing, []);
});

test("stale client id or secret names the variable and never the value", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wpd-stale-"));
  const f = path.join(dir, "withings.env");
  const fileId = "file-client-id-should-not-leak";
  const fileSecret = "file-secret-should-not-leak";
  const envId = "env-client-id-should-not-leak";
  const envSecret = "env-secret-should-not-leak";
  await writeFile(f, `WITHINGS_CLIENT_ID=${fileId}\nWITHINGS_CLIENT_SECRET=${fileSecret}\nWITHINGS_REDIRECT_URI=https://example.com/from-file\nWITHINGS_TOKEN_FILE=${dir}/none.json\n`);
  const env = { WITHINGS_ENV_FILE: f, WITHINGS_CLIENT_ID: envId, WITHINGS_CLIENT_SECRET: envSecret, WITHINGS_REDIRECT_URI: "https://example.com/from-env" };
  const h = makeHandler(new Client({ env, pauseMs: 0, wait: async () => {}, fetchImpl: async () => json({}) }));
  const st = (await call(h, "auth_status")).structuredContent;
  const guide = (await call(h, "setup_guide")).structuredContent;
  for (const blob of [JSON.stringify(st), JSON.stringify(guide)]) {
    assert.match(blob, /WITHINGS_CLIENT_ID/);
    assert.match(blob, /WITHINGS_CLIENT_SECRET/);
    assert.match(blob, /restart/);
    assert.ok(!blob.includes(fileId) && !blob.includes(envId) && !blob.includes(fileSecret) && !blob.includes(envSecret), blob);
  }
  assert.match(st.config_stale_warning, /https:\/\/example\.com\/from-env/);
  assert.match(st.config_stale_warning, /https:\/\/example\.com\/from-file/);
  assert.equal(st.redirect_action, "restart_to_pick_up_config");
});

test("setup_guide is an ordered walkthrough and never echoes secrets or the client id", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wpd-guide-"));
  const h = makeHandler(new Client({
    env: { WITHINGS_CLIENT_ID: "${WITHINGS_CLIENT_ID}", WITHINGS_CLIENT_SECRET: "", WITHINGS_REDIRECT_URI: "${WITHINGS_REDIRECT_URI}", WITHINGS_TOKEN_FILE: path.join(dir, "none.json") },
    fetchImpl: async () => json({}),
  }));
  const r = await call(h, "setup_guide");
  assert.equal(r.isError, false, r.content[0].text);
  const s = r.structuredContent;
  assert.equal(s.default_callback, "http://localhost:8765/callback");
  assert.equal(s.callback_in_use, "http://localhost:8765/callback");
  assert.equal(s.redirect_uri_defaulted, true);
  assert.equal(s.guide_path, "docs/SETUP-WITHINGS.md");
  assert.deepEqual(s.steps.map((x) => x.id), ["withings_account", "create_app", "register_callback", "copy_credentials", "save_credentials_locally", "start_authorization", "finish_authorization", "confirm"]);
  assert.equal(s.current_step, "withings_account");
  assert.deepEqual(s.missing, ["client_id", "client_secret", "token"]);
  assert.equal(s.checks.redirect_uri, "default");
  assert.equal(s.steps[0].done, null);
  assert.match(s.steps[2].instruction, /http:\/\/localhost:8765\/callback/);
  assert.match(s.tone, /copy-pasting/);
  assert.match(s.tone, /10–15 minutes/);
  const finish = s.steps.find((x) => x.id === "finish_authorization").instruction;
  assert.match(finish, /assistant's computer/);
  assert.match(finish, /paste it back to the assistant right away/);
  assert.match(s.if_this_error.map((e) => e.id).join(","), /redirect_uri_mismatch/);
  const blob = JSON.stringify(s);
  assert.ok(!blob.includes(SECRET) && !blob.includes(ID));
});

test("auth_status and start_authorization warn before Withings when the callback was defaulted", async () => {
  const { h } = await setup();
  const st = (await call(h, "auth_status")).structuredContent;
  assert.equal(st.redirect_uri_defaulted, true);
  assert.equal(st.redirect_uri_source, "default");
  assert.equal(st.setup_step, "start_authorization");
  assert.deepEqual(st.missing, ["token"]);
  assert.equal(st.checks.client_secret, "set");
  assert.equal(st.redirect_action, "register_this_exact_url");
  assert.match(st.redirect_warning, /partner callback url/);
  assert.match(st.next_instruction, /Before anyone opens Withings/);
  assert.ok(!JSON.stringify(st).includes(SECRET) && !JSON.stringify(st).includes(ID));
  try {
    const r = await call(h, "start_authorization");
    assert.equal(r.isError, false, r.content[0].text);
    const s = r.structuredContent;
    assert.equal(s.listening, true);
    assert.equal(s.redirect_uri_defaulted, true);
    assert.equal(new URL(s.authorization_url).searchParams.get("redirect_uri"), "http://localhost:8765/callback");
    assert.match(s.next_step, /Callback check before you open Withings/);
    assert.match(s.redirect_warning, /character for character/);
    assert.ok(!JSON.stringify(s).includes(SECRET));
  } finally { stopListener(); }
});

test("cli status reports a defaulted redirect and no secrets", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wpd-cli-"));
  const f = path.join(dir, "withings.env");
  await writeFile(f, `WITHINGS_CLIENT_ID=${ID}\nWITHINGS_CLIENT_SECRET=${SECRET}\nWITHINGS_TOKEN_FILE=${dir}/none.json\n`);
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const proc = spawn(process.execPath, ["server/cli.mjs", "status"], { cwd: root, env: { PATH: process.env.PATH, HOME: dir, WITHINGS_ENV_FILE: f } });
  let out = "", err = "";
  proc.stdout.on("data", (d) => { out += d; });
  proc.stderr.on("data", (d) => { err += d; });
  const code = await new Promise((resolve) => proc.on("close", resolve));
  assert.equal(code, 0, err + out);
  assert.ok(!out.includes(SECRET) && !err.includes(SECRET));
  const j = JSON.parse(out);
  assert.equal(j.redirect_uri_defaulted, true);
  assert.equal(j.redirect_uri, "http://localhost:8765/callback");
  assert.equal(j.setup_step, "start_authorization");
  assert.match(j.next_instruction, /Before anyone opens Withings/);
});
