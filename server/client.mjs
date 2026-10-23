// Withings Public API client: OAuth 2.0 (authorization code + rotating refresh token), POST with retry.
// Community code, not made or endorsed by Withings. Never logs the client secret, codes or tokens.
import { randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, unlinkSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const API = "https://wbsapi.withings.net";
export const AUTHORIZE_URL = "https://account.withings.com/oauth2_user/authorize2";
export const DASHBOARD = "https://developer.withings.com/dashboard/";
export const DEFAULT_REDIRECT = "http://localhost:8765/callback";
// Read-only scopes only. user.info = devices; user.metrics = body/BP; user.activity = activity + sleep. Never write scopes.
export const SCOPES = ["user.info", "user.metrics", "user.activity"];
// Scopes Withings may add to the grant on its own. user.sleepevents only drives sleep-event notifications (webhooks),
// which this plugin never subscribes to; it is read-only either way.
export const KNOWN_EXTRA_SCOPES = { "user.sleepevents": "Added by Withings to the grant; only used for sleep-event notifications (webhooks), which this plugin does not use. Read-only." };
const REFRESH_MARGIN_MS = 10 * 60e3;
const HEX40_RE = /\b[0-9a-f]{40}\b/gi;   // Withings access/refresh tokens and codes are 40-hex strings

export const SETUP_HELP =
  "Withings is not set up yet. 1) Create a Withings developer app at " + DASHBOARD + " (Public API integration, " +
  "Public Cloud) with the callback URL " + DEFAULT_REDIRECT + " (or another URL you control). 2) Give its client id and " +
  "secret to this MCP server through your MCP client's settings for it: either WITHINGS_CLIENT_ID and " +
  "WITHINGS_CLIENT_SECRET, or WITHINGS_ENV_FILE=<absolute path to a file with those KEY=value lines>. Restart or reload " +
  "the server afterwards (for example in Cursor: Plugins -> Personal Health Data (community) -> Configure, then reload " +
  "the window). 3) Run the start_authorization tool (or `node server/cli.mjs authorize`) once and approve access in " +
  "the browser. Never paste the secret into chat.";

export class WithingsError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

const unset = (v) => { const s = (v || "").trim(); return !s || /^\$\{.*\}$/.test(s) ? null : s; };

// Names WITHINGS_ENV_FILE may set. Anything else in the file is ignored.
export const ENV_FILE_KEYS = ["WITHINGS_CLIENT_ID", "WITHINGS_CLIENT_SECRET", "WITHINGS_REDIRECT_URI", "WITHINGS_TOKEN_FILE"];

/**
 * Parse a dotenv-style file (KEY=value per line; blank lines, `# comments` and an `export ` prefix allowed; values may
 * be wrapped in single or double quotes). No shell expansion. Returns { values, error }. Never throws.
 */
export function readEnvFile(file) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch (e) { return { values: {}, error: `WITHINGS_ENV_FILE (${file}) could not be read (${e.code || "error"}).` }; }
  const values = {};
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const i = line.indexOf("=");
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) v = v.slice(1, -1);
    if (ENV_FILE_KEYS.includes(k)) values[k] = v;
  }
  return { values, error: null };
}

/** Explicit environment variables win; WITHINGS_ENV_FILE fills whatever is unset (keeps secrets out of client configs). */
export function readConfig(env = process.env) {
  const envFile = unset(env.WITHINGS_ENV_FILE);
  const file = envFile ? readEnvFile(envFile) : { values: {}, error: null };
  const get = (k) => unset(env[k]) || unset(file.values[k]);
  return {
    clientId: get("WITHINGS_CLIENT_ID"),
    clientSecret: get("WITHINGS_CLIENT_SECRET"),
    redirectUri: get("WITHINGS_REDIRECT_URI") || DEFAULT_REDIRECT,
    tokenFile: get("WITHINGS_TOKEN_FILE") || defaultTokenFile(env),
    envFile, envFileError: file.error,
  };
}

// ~/.config/personal-health-data-mcp/tokens.json (XDG), %APPDATA%\personal-health-data-mcp\tokens.json on Windows.
export function defaultTokenFile(env = process.env) {
  const base = process.platform === "win32" ? (env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"))
    : (unset(env.XDG_CONFIG_HOME) || path.join(os.homedir(), ".config"));
  return path.join(base, "personal-health-data-mcp", "tokens.json");
}

// ---- token store (file outside the repo, dir 700, file 600, atomic writes, simple cross-process lock)
export async function loadTokens(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch (e) { if (e.code === "ENOENT") return null; throw new WithingsError(`Token file is unreadable (${e.code || "invalid JSON"}). Re-authorize.`, 0); }
}
export async function saveTokens(file, tok) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(tok), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}
async function withLock(file, fn, { wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const lock = `${file}.lock`;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let i = 0; ; i++) {
    try { closeSync(openSync(lock, "wx", 0o600)); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > 60e3) { unlinkSync(lock); continue; } } catch { /* gone */ }
      if (i > 100) throw new WithingsError("Token file is locked by another process; try again.", 0);
      await wait(100);
    }
  }
  try { return await fn(); } finally { try { unlinkSync(lock); } catch { /* ignore */ } }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Client {
  constructor({ env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now(), pauseMs = 200, maxRetries = 3, wait = sleep } = {}) {
    this.env = env; this.fetch = fetchImpl; this.now = now; this.pauseMs = pauseMs; this.maxRetries = maxRetries; this.wait = wait;
    this.tokens = null; this.lastCall = 0; this.pending = null;
    this.stats = { requests: 0, refreshes: 0, throttled: 0, retries: 0 };
  }
  get config() { return readConfig(this.env); }

  redact(text) {
    let s = String(text ?? "");
    const { clientId, clientSecret } = this.config;
    for (const [v, tag] of [[clientSecret, "SECRET"], [clientId, "CLIENT_ID"], [this.tokens?.access_token, "TOKEN"], [this.tokens?.refresh_token, "TOKEN"]])
      if (v) s = s.split(v).join(`[REDACTED_${tag}]`);
    return s.replace(HEX40_RE, "[REDACTED_TOKEN]");
  }

  requireApp() {
    const c = this.config;
    if (!c.clientId || !c.clientSecret) throw new WithingsError(c.envFileError ? `${c.envFileError} ${SETUP_HELP}` : SETUP_HELP, 0);
    return c;
  }

  // ---- OAuth
  authorizationUrl(state = randomBytes(12).toString("hex")) {
    const c = this.requireApp();
    const q = new URLSearchParams({ response_type: "code", client_id: c.clientId, scope: SCOPES.join(","), redirect_uri: c.redirectUri, state });
    return { url: `${AUTHORIZE_URL}?${q}`, state, redirect_uri: c.redirectUri, scopes: SCOPES };
  }

  async rawPost(p, params, headers = {}) {
    for (let attempt = 0; ; attempt++) {
      const gap = this.now() - this.lastCall;
      if (gap < this.pauseMs) await this.wait(this.pauseMs - gap);
      this.lastCall = this.now(); this.stats.requests++;
      let res;
      try {
        res = await this.fetch(API + p, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", ...headers }, body: new URLSearchParams(params).toString() });
      } catch (e) {
        if (attempt < this.maxRetries) { this.stats.retries++; await this.wait(1000 * 2 ** attempt); continue; }
        throw new WithingsError(`Network error calling ${p}: ${this.redact(e.message)}`, 0);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        if (res.status === 429) this.stats.throttled++;
        this.stats.retries++; await this.wait(Math.min(2000 * 2 ** attempt, 30000)); continue;
      }
      const text = await res.text();
      if (!res.ok) throw new WithingsError(`POST ${p} failed: HTTP ${res.status}. ${this.redact(text).slice(0, 200)}`.trim(), res.status);
      let j; try { j = JSON.parse(text); } catch { throw new WithingsError(`POST ${p}: response was not JSON.`, res.status); }
      // Withings rate limit is reported in the body (status 601).
      if (j?.status === 601 && attempt < this.maxRetries) { this.stats.throttled++; this.stats.retries++; await this.wait(Math.min(5000 * 2 ** attempt, 60000)); continue; }
      return j;
    }
  }

  async tokenRequest(params) {
    const c = this.requireApp();
    const r = await this.rawPost("/v2/oauth2", { action: "requesttoken", client_id: c.clientId, client_secret: c.clientSecret, ...params });
    const b = r?.body || {};
    if (r?.status !== 0 || !b.access_token || !b.refresh_token) {
      const why = params.grant_type === "authorization_code"
        ? ` The code may have expired (Withings codes are valid for 30 seconds and single-use, and must be exchanged by the same server process that started the authorization), or the callback URL does not match. This server used redirect_uri=${params.redirect_uri}; it must equal, character for character, a Callback URL registered in your Withings app and the one used when the authorization started. Start the authorization again.`
        : " The refresh token was rejected (expired after a year, revoked in the Withings app, or replaced by another process). Run start_authorization again to re-authorize.";
      throw new WithingsError(`Withings token request failed (status ${r?.status}${r?.error ? `: ${this.redact(r.error)}` : ""}).${why}`, r?.status ?? 0);
    }
    // userid is deliberately not stored: tools never need it.
    return { access_token: b.access_token, refresh_token: b.refresh_token, expires_in: Number(b.expires_in) || 10800, scope: b.scope ?? null, token_type: b.token_type ?? "Bearer", obtained_at: Math.floor(this.now() / 1000) };
  }

  /** Exchange an authorization code (or the full redirect URL containing it) for tokens and store them. */
  async exchangeCode(codeOrUrl, { expectedState } = {}) {
    let code = String(codeOrUrl || "").trim(), state = null;
    if (/[?&]code=/.test(code)) { const u = new URL(code, "http://x"); code = u.searchParams.get("code") || ""; state = u.searchParams.get("state"); }
    if (!code) throw new WithingsError("No authorization code found. Paste the code or the whole URL you were redirected to.", 0);
    if (expectedState && state && state !== expectedState) throw new WithingsError("The state in the redirect does not match this authorization request. Start again.", 0);
    const tok = await this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: this.config.redirectUri });
    const file = this.config.tokenFile;
    await withLock(file, () => saveTokens(file, tok), { wait: this.wait });
    this.tokens = tok;
    return { ok: true, token_file: file, scope: tok.scope, access_expires_in_s: tok.expires_in };
  }

  expiresAt(t = this.tokens) { return t ? (Number(t.obtained_at) + Number(t.expires_in)) * 1000 : 0; }

  async accessToken({ force = false } = {}) {
    this.requireApp();
    if (!force && this.tokens?.access_token && this.expiresAt() - this.now() > REFRESH_MARGIN_MS) return this.tokens.access_token;
    if (this.pending) return this.pending;
    const file = this.config.tokenFile;
    this.pending = withLock(file, async () => {
      const t = await loadTokens(file);   // re-read under the lock: another process may have rotated it already
      if (!force && t?.access_token && this.expiresAt(t) - this.now() > REFRESH_MARGIN_MS) { this.tokens = t; return t.access_token; }
      if (!t?.refresh_token) throw new WithingsError(`Not authorized yet (no token file at ${file}). ` + SETUP_HELP, 0);
      this.stats.refreshes++;
      const nt = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token });
      await saveTokens(file, nt);   // the refresh token rotates: always persist the new pair at once
      this.tokens = nt;
      return nt.access_token;
    }, { wait: this.wait }).finally(() => { this.pending = null; });
    return this.pending;
  }

  /** Authenticated data call. Returns body. Handles one forced refresh on an invalid-token status. */
  async call(p, params) {
    let refreshed = false;
    for (;;) {
      const tok = await this.accessToken({ force: refreshed });
      const r = await this.rawPost(p, params, { Authorization: `Bearer ${tok}` });
      if ((r?.status === 401 || r?.status === 343) && !refreshed) { refreshed = true; continue; }
      if (r?.status === 0) return r.body || {};
      if (r?.status === 100) return {};   // "no data"
      const why = r?.status === 601 ? " Rate limited by Withings; wait a minute and use a shorter range." :
        r?.status === 401 || r?.status === 343 ? " Access was rejected: re-authorize with start_authorization." : "";
      throw new WithingsError(`Withings ${p} ${params.action} failed (status ${r?.status}${r?.error ? `: ${this.redact(r.error)}` : ""}).${why}`, r?.status ?? 0);
    }
  }

  /** Follows Withings' more/offset paging. */
  async paged(p, params, key, maxPages = 50) {
    const out = []; let offset;
    for (let i = 0; i < maxPages; i++) {
      const b = await this.call(p, offset ? { ...params, offset } : params);
      out.push(...(b[key] || []));
      if (!b.more || !b.offset) return { items: out, body: b };
      offset = b.offset;
    }
    return { items: out, body: {}, truncated: true };
  }

  async status() {
    const c = this.config;
    const t = await loadTokens(c.tokenFile).catch(() => null);
    const granted = t?.scope ? String(t.scope).split(/[,\s]+/).filter(Boolean) : null;
    const extra = granted ? granted.filter((x) => !SCOPES.includes(x)) : [];
    return {
      client_configured: Boolean(c.clientId && c.clientSecret), env_file: c.envFile ?? null, env_file_problem: c.envFileError ?? null,
      redirect_uri: c.redirectUri, token_file: c.tokenFile,
      authorized: Boolean(t?.refresh_token),
      requested_scopes: SCOPES, granted_scopes: granted,
      extra_granted_scopes: extra.length ? Object.fromEntries(extra.map((x) => [x, KNOWN_EXTRA_SCOPES[x] ?? "Granted by Withings but not requested or used by this plugin."])) : null,
      access_token_valid_for_min: t ? Math.max(0, Math.round((this.expiresAt(t) - this.now()) / 60e3)) : null,
      last_token_at: t?.obtained_at ? new Date(t.obtained_at * 1000).toISOString() : null,
      refresh_token_expires_about: t?.obtained_at ? new Date((t.obtained_at + 365 * 86400) * 1000).toISOString().slice(0, 10) : null,
    };
  }
}

// ---- dates
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isoDay(d) { return d.toISOString().slice(0, 10); }
export function addDays(s, n) { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return isoDay(d); }
export function localToday() {
  const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function resolveRange(args = {}, { defaultDays = 7, maxDays = 366 } = {}) {
  const end = args.end_date || localToday();
  const start = args.start_date || addDays(end, -(defaultDays - 1));
  for (const [n, v] of [["start_date", start], ["end_date", end]])
    if (!DATE_RE.test(v) || Number.isNaN(Date.parse(v + "T00:00:00Z")) || isoDay(new Date(v + "T00:00:00Z")) !== v) throw new WithingsError(`${n} must be YYYY-MM-DD (got ${JSON.stringify(v)})`, 0);
  if (start > end) throw new WithingsError("start_date is after end_date", 0);
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 864e5) + 1;
  if (days > maxDays) throw new WithingsError(`Range is ${days} days; the maximum per call is ${maxDays}. Split it into smaller ranges.`, 0);
  return { start, end, days };
}
