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
  "Public Cloud) with the callback URL " + DEFAULT_REDIRECT + " (or another URL you control). The callback must match " +
  "exactly, character for character. 2) Give its client id and secret to this MCP server through your MCP client's " +
  "settings for it: either WITHINGS_CLIENT_ID and WITHINGS_CLIENT_SECRET, or WITHINGS_ENV_FILE=<absolute path to a file " +
  "with those KEY=value lines>. Restart or reload the server afterwards if you set environment variables (for example " +
  "in Cursor: Plugins -> Personal Health Data (community) -> Configure, then reload the window). An env file is re-read " +
  "on the next auth call. 3) Run the setup_guide or start_authorization tool (or `node server/cli.mjs authorize`) once " +
  "and approve access in the browser. Step-by-step: docs/SETUP-WITHINGS.md. Never paste the secret into chat.";

// Captured when this process started. Environment variables do not change until a new process starts.
export const PROCESS_STARTED_AT = new Date().toISOString();

const sourcePhrase = (source, envFile) => source === "default"
  ? "the built-in default, because WITHINGS_REDIRECT_URI is not set"
  : source === "env_file"
    ? `the env file ${envFile || "(WITHINGS_ENV_FILE)"}, which is re-read on every auth call`
    : "the WITHINGS_REDIRECT_URI environment variable (fixed until this process is restarted; the env file cannot override it)";

export function redirectWarningText(c) {
  return `redirect_uri=${c.redirectUri} (${sourcePhrase(c.redirectUriSource, c.envFile)}). ` +
    "It must match a Callback URL registered in your Withings developer app character for character: same scheme " +
    "(http or https), host (localhost and 127.0.0.1 are different), port, path, and trailing slash. If it does not, " +
    "Withings shows redirect_uri_mismatch (\"The redirect URI provided is missing or does not match partner callback url\") " +
    "and does not give you a code.";
}

function configNoteText(c) {
  const started = `This process started at ${c.processStartedAt}.`;
  if (c.redirectUriSource === "environment") {
    return `Redirect config source: process environment, captured when the process started. ${started} Changing WITHINGS_REDIRECT_URI in plugin settings or the shell does nothing until you restart or reload so a new process starts. The env file is re-read on every auth call but does not override a set environment variable.`;
  }
  if (c.redirectUriSource === "env_file") {
    return `Redirect config source: env file ${c.envFile}, re-read at ${c.configReadAt}` +
      (c.envFileMtime ? ` (file modified ${c.envFileMtime})` : "") +
      `. ${started} You do not need to restart after editing that file. If WITHINGS_REDIRECT_URI is also set in the environment, the environment wins and a restart is required to change it.`;
  }
  return `Redirect config source: built-in default ${DEFAULT_REDIRECT}, because WITHINGS_REDIRECT_URI is unset in both the environment and the env file. ${started} ` +
    "Register that exact URL in your Withings app, or set WITHINGS_REDIRECT_URI. An env-file value is picked up on the next auth call. An environment value is picked up only when a new process starts.";
}

/** Why a code exchange failed. `error` is Withings' error string; it is not echoed if it might hold a code. */
export function explainTokenFailure(c, { grantType, status, error } = {}) {
  if (grantType !== "authorization_code") {
    return " The refresh token was rejected (expired after a year, revoked in the Withings app, or replaced by another process). Run start_authorization again to re-authorize.";
  }
  const blob = `${status ?? ""} ${error ?? ""}`.toLowerCase();
  const redirectHit = status === 293 || /redirect[_\s-]?uri|partner callback|callback url/.test(blob);
  const codeHit = status === 304 || /invalid code|authorization code|code has expired|invalid_grant/.test(blob);
  const where = `redirect_uri=${c.redirectUri} (${sourcePhrase(c.redirectUriSource, c.envFile)}). This process started at ${c.processStartedAt}.`;
  if (status === 342) {
    return " Withings rejected the client id or secret (status 342). Check WITHINGS_CLIENT_ID and WITHINGS_CLIENT_SECRET in the plugin settings or the env file (they are not shown here). If you changed them in the environment, restart the server. Then run start_authorization again.";
  }
  if (redirectHit && !codeHit) {
    return ` Withings rejected the callback URL (redirect_uri mismatch). This server sent ${where} It must equal, character for character, a Callback URL in your Withings developer app (${DASHBOARD}). ` +
      "Change the dashboard callback to that exact value, or set WITHINGS_REDIRECT_URI to the callback you already registered. " +
      "If you change an environment variable, restart or reload the server. An env-file edit is picked up on the next attempt only when the environment variable is unset. " +
      "Then run start_authorization again. The code from this attempt cannot be reused.";
  }
  if (codeHit && !redirectHit) {
    return " Withings rejected the authorization code. Codes are valid for about 30 seconds, work only once, and must be exchanged by the same server process that ran start_authorization. " +
      "Run start_authorization again, approve access, and immediately pass the full address-bar URL to exchange_code (or paste it at the CLI prompt). Do not reuse the old code. " +
      `If Withings never redirected you and instead showed redirect_uri_mismatch, the callback does not match: this server is using ${where} That exact string must be a Callback URL in your Withings app.`;
  }
  return ` Withings did not return a token. Check two things, in order. (1) Code: it expires in about 30 seconds, works once, and must reach the same server process that ran start_authorization. Run start_authorization again and finish immediately; do not reuse the old code. ` +
    `(2) Callback: it must match character for character. This server sent ${where} Compare it with the Callback URL in your Withings developer app (${DASHBOARD}), fix whichever side is wrong, restart the server if you changed an environment variable, then start again.`;
}

export function pasteMismatchMessage(pasted, c) {
  return `The address you pasted is for callback ${pasted}, but this server will exchange the code using redirect_uri=${c.redirectUri} (${sourcePhrase(c.redirectUriSource, c.envFile)}). ` +
    "Those must be character for character the same, so the code was not sent to Withings (a mismatch would use it up). " +
    `Register ${c.redirectUri} as a Callback URL in your Withings app, or set WITHINGS_REDIRECT_URI to exactly ${pasted} and run start_authorization again. ` +
    `If the redirect comes from the process environment, restart the server after changing it (this process started at ${c.processStartedAt}). ` +
    "If it comes from the env file, the next attempt re-reads the file. Do not reuse this code.";
}

/** Pull a code out of a pasted redirect URL. Never returns the query string that held the code. */
export function parseAuthInput(codeOrUrl) {
  const raw = String(codeOrUrl || "").trim();
  if (!raw) return { code: "", state: null, pastedRedirect: null };
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  if (!isUrl && !/[?&]code=/.test(raw)) return { code: raw, state: null, pastedRedirect: null };
  let u;
  try { u = new URL(raw, "http://localhost"); }
  catch { return { error: "Could not read that as a URL. Paste the full address from the browser's address bar, or paste only the authorization code (not the client secret)." }; }
  const code = u.searchParams.get("code") || "";
  const state = u.searchParams.get("state");
  let pastedRedirect = null;
  if (isUrl) {
    u.searchParams.delete("code");
    u.searchParams.delete("state");
    u.hash = "";
    const q = u.searchParams.toString();
    pastedRedirect = `${u.origin}${u.pathname}${q ? `?${q}` : ""}`;
  }
  return { code, state, pastedRedirect };
}

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
  let text, mtime = null;
  try {
    mtime = new Date(statSync(file).mtimeMs).toISOString();
    text = readFileSync(file, "utf8");
  } catch (e) { return { values: {}, error: `WITHINGS_ENV_FILE (${file}) could not be read (${e.code || "error"}).`, mtime: null }; }
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
  return { values, error: null, mtime };
}

/**
 * Explicit environment variables win; WITHINGS_ENV_FILE fills whatever is unset (keeps secrets out of client configs).
 * Called on every auth operation (not cached): the env file is re-read from disk each time. Values already in the
 * process environment were captured when that process started and do not change until a new process starts.
 */
export function readConfig(env = process.env, now = Date.now) {
  const clock = typeof now === "function" ? now : () => now;
  const envFile = unset(env.WITHINGS_ENV_FILE);
  const file = envFile ? readEnvFile(envFile) : { values: {}, error: null, mtime: null };
  const origin = (k) => (unset(env[k]) ? "environment" : unset(file.values[k]) ? "env_file" : null);
  const redirectUriSource = origin("WITHINGS_REDIRECT_URI") || "default";
  const envRedirect = unset(env.WITHINGS_REDIRECT_URI);
  const fileRedirect = unset(file.values.WITHINGS_REDIRECT_URI);
  const partial = {
    redirectUri: envRedirect || fileRedirect || DEFAULT_REDIRECT,
    redirectUriSource,
    envFile, envFileMtime: file.mtime, envFileError: file.error,
    configReadAt: new Date(clock()).toISOString(),
    processStartedAt: PROCESS_STARTED_AT,
  };
  let configStaleWarning = null;
  if (envRedirect && fileRedirect && envRedirect !== fileRedirect) {
    configStaleWarning = `WITHINGS_REDIRECT_URI in the environment is ${envRedirect}, which overrides ${fileRedirect} in ${envFile}` +
      (file.mtime ? ` (file modified ${file.mtime})` : "") +
      `. Editing the env file did not change the live redirect. This process started at ${PROCESS_STARTED_AT} and will keep the environment value until you restart or reload it. ` +
      "To use the file, unset WITHINGS_REDIRECT_URI in the MCP client's environment (Cursor: Plugins → Personal Health Data (community) → Configure, then reload the window).";
  }
  partial.configStaleWarning = configStaleWarning;
  partial.redirectWarning = redirectWarningText(partial);
  partial.configNote = (file.error ? `${file.error} ` : "") + configNoteText(partial);
  return {
    clientId: unset(env.WITHINGS_CLIENT_ID) || unset(file.values.WITHINGS_CLIENT_ID),
    clientSecret: unset(env.WITHINGS_CLIENT_SECRET) || unset(file.values.WITHINGS_CLIENT_SECRET),
    clientIdSource: origin("WITHINGS_CLIENT_ID"),
    clientSecretSource: origin("WITHINGS_CLIENT_SECRET"),
    tokenFile: unset(env.WITHINGS_TOKEN_FILE) || unset(file.values.WITHINGS_TOKEN_FILE) || defaultTokenFile(env),
    tokenFileSource: origin("WITHINGS_TOKEN_FILE") || "default",
    ...partial,
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
  get config() { return readConfig(this.env, this.now); }

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
    let r;
    try {
      r = await this.rawPost("/v2/oauth2", { action: "requesttoken", client_id: c.clientId, client_secret: c.clientSecret, ...params });
    } catch (e) {
      // Withings usually returns HTTP 200 with a status field. A proxy or an error page may not.
      if (/Network error/.test(e.message) || params.grant_type !== "authorization_code") throw e;
      throw new WithingsError(`${e.message}${explainTokenFailure(c, { grantType: params.grant_type, status: e.status, error: e.message })}`, e.status ?? 0);
    }
    const b = r?.body || {};
    if (r?.status !== 0 || !b.access_token || !b.refresh_token) {
      const why = explainTokenFailure(c, { grantType: params.grant_type, status: r?.status, error: r?.error });
      throw new WithingsError(`Withings token request failed (status ${r?.status}${r?.error ? `: ${this.redact(r.error)}` : ""}).${why}`, r?.status ?? 0);
    }
    // userid is deliberately not stored: tools never need it. redirect_uri is not a secret; the caller may set it.
    return { access_token: b.access_token, refresh_token: b.refresh_token, expires_in: Number(b.expires_in) || 10800, scope: b.scope ?? null, token_type: b.token_type ?? "Bearer", obtained_at: Math.floor(this.now() / 1000) };
  }

  /** Exchange an authorization code (or the full redirect URL containing it) for tokens and store them. */
  async exchangeCode(codeOrUrl, { expectedState } = {}) {
    const parsed = parseAuthInput(codeOrUrl);
    if (parsed.error) throw new WithingsError(parsed.error, 0);
    const { code, state, pastedRedirect } = parsed;
    if (!code) throw new WithingsError("No authorization code found. Paste the code or the whole URL you were redirected to.", 0);
    if (expectedState && state && state !== expectedState) throw new WithingsError("The state in the redirect does not match this authorization request. Run start_authorization again. Do not reuse this code; it is single-use.", 0);
    const c = this.config;
    // Compare before calling Withings so a wrong callback does not burn the one-time code.
    if (pastedRedirect && pastedRedirect !== c.redirectUri) throw new WithingsError(pasteMismatchMessage(pastedRedirect, c), 0);
    const tok = await this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: c.redirectUri });
    tok.redirect_uri = c.redirectUri;
    const file = c.tokenFile;
    await withLock(file, () => saveTokens(file, tok), { wait: this.wait });
    this.tokens = tok;
    return { ok: true, token_file: file, scope: tok.scope, access_expires_in_s: tok.expires_in, redirect_uri: c.redirectUri };
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
      if (t.redirect_uri) nt.redirect_uri = t.redirect_uri;   // which callback obtained this grant; not a secret
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
    const authorized = Boolean(t?.refresh_token);
    const tokenRedirect = typeof t?.redirect_uri === "string" && t.redirect_uri ? t.redirect_uri : null;
    const redirectChanged = Boolean(tokenRedirect && tokenRedirect !== c.redirectUri);
    const redirectAction = c.configStaleWarning ? "restart_to_pick_up_config"
      : redirectChanged ? "differs_from_saved_token"
      : !authorized ? "register_this_exact_url"
      : null;
    return {
      client_configured: Boolean(c.clientId && c.clientSecret),
      client_id_set: Boolean(c.clientId), client_secret_set: Boolean(c.clientSecret),
      client_id_source: c.clientIdSource, client_secret_source: c.clientSecretSource,
      env_file: c.envFile ?? null, env_file_problem: c.envFileError ?? null, env_file_mtime: c.envFileMtime ?? null,
      redirect_uri: c.redirectUri, redirect_uri_source: c.redirectUriSource, redirect_uri_defaulted: c.redirectUriSource === "default",
      redirect_warning: c.redirectWarning, redirect_action: redirectAction,
      config_note: c.configNote, config_stale_warning: c.configStaleWarning, config_read_at: c.configReadAt, process_started_at: c.processStartedAt,
      token_file: c.tokenFile, token_file_source: c.tokenFileSource,
      token_redirect_uri: tokenRedirect, redirect_changed_since_authorization: redirectChanged,
      redirect_changed_warning: redirectChanged
        ? `The saved token was authorized with redirect_uri=${tokenRedirect}, but this process is using ${c.redirectUri} (${sourcePhrase(c.redirectUriSource, c.envFile)}). Data calls keep working until you re-authorize. Before start_authorization, the Callback URL in your Withings app must exactly equal ${c.redirectUri}. To keep the previous callback, set WITHINGS_REDIRECT_URI back to ${tokenRedirect} and restart the server if that value comes from the environment.`
        : null,
      authorized,
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
