# Personal Health Data (community)

*Compatible with Withings.*

**An unofficial, community-built plugin. It is not affiliated with, endorsed or sponsored by Withings.**
For general wellness and informational use only. It is not a medical device and not medical advice (see [Disclaimer](#disclaimer)).
It reads **only your own data**, through Withings' Public API (https://developer.withings.com), using a
Withings developer app that **you** create for yourself. It is read-only: it cannot change anything in your Withings
account or on your devices.

Withings is a trademark of Withings. The name is used here only to say which service the plugin is compatible with.
No Withings logo or artwork is used.

It is a small stdio MCP server (Node.js 18+, **no dependencies, no install step**) packaged as a Cursor plugin, plus one
skill that tells the agent when to use the tools. It works with any MCP client that can launch a local stdio server
(Cursor, Grok Bot, Claude Desktop and others). The entry point is **`server/index.mjs`**; the setup CLI is
`server/cli.mjs`.

## New here? Start with the walkthrough

Setting this up is not super straightforward, but if you follow the steps exactly it should be fine. It is mostly copy-pasting. The first time takes about 10–15 minutes.

**[docs/SETUP-WITHINGS.md](docs/SETUP-WITHINGS.md)** is the step-by-step for someone who has never used a developer portal. The short version of the callback: if you do not have a website, register exactly `http://localhost:8765/callback` (the plugin's default; it can answer that address on your own computer). An assistant should call `setup_guide` and give you one step at a time. Before anyone opens the Withings link, `auth_status` / `start_authorization` name the redirect the running process will actually send, and whether that value was configured or just the default.

## Tools
| Tool | What it returns | Withings endpoint (POST) | Scope |
|---|---|---|---|
| `get_body_measurements` | one row per weigh-in: weight, fat %, fat mass, fat-free mass, muscle, hydration, bone, visceral fat, extra/intracellular water, BMR, metabolic age, pulse wave velocity, vascular age, standing heart rate | `/measure` `getmeas` | user.metrics |
| `get_blood_pressure` | systolic, diastolic, pulse | `/measure` `getmeas` (types 9, 10, 11) | user.metrics |
| `get_daily_activity` | steps, distance, floors, activity minutes, calories, HR and HR zones per day | `/v2/measure` `getactivity` | user.activity |
| `get_sleep_summary` | per night: total sleep, time in bed, stages, efficiency, latency, wake-ups, sleep score, HR, breathing rate, snoring. Empty result = no sleep device in Withings; it then returns a `hint` to check `list_devices` | `/v2/sleep` `getsummary` | user.activity |
| `list_devices` | linked devices: type, model, battery, firmware, last sync (no serial numbers or ids) | `/v2/user` `getdevice` | user.info |
| `setup_guide` | step-by-step setup script plus where this server is right now (no secrets) | (local) | |
| `auth_status` | configured (env or `WITHINGS_ENV_FILE`) and authorized; the live redirect URI and whether it was defaulted; where that value came from and when; requested vs granted scopes; what is still missing | (local) | |
| `start_authorization` / `exchange_code` | one-time authorization (see Setup). `start_authorization` repeats the callback check before you open Withings | `/v2/oauth2` `requesttoken` | |

Range tools take `start_date` / `end_date` (`YYYY-MM-DD`, your local dates; up to 366 days per call). Values are decoded
from Withings' `value × 10^unit` format into the units named in each field. Metrics your device didn't measure are
`null`, never 0. Every result carries `data_source: "Withings"`.

The plugin requests only the read scopes `user.info`, `user.metrics` and `user.activity`. It never requests anything
that can write. Withings may still add `user.sleepevents` to the grant it returns; that scope only drives sleep-event
webhook notifications, which this plugin doesn't use. `auth_status` shows both lists: `requested_scopes` and
`granted_scopes` (with any extras explained under `extra_granted_scopes`).

## Install
There is nothing to install: the server uses only Node.js built-ins, so there is no `npm install` / `npm ci` step
(a `package-lock.json` with no packages is included so `npm ci` also succeeds). Get the code and run it with Node:

```bash
git clone https://github.com/emilniclashofseth/personal-health-data-mcp.git
cd personal-health-data-mcp
node server/index.mjs          # stdio MCP server (normally your MCP client starts it)
```

In Cursor you can instead install it from the directory: https://cursor.directory/plugins/personal-health-data-community

## Setup (about 10–15 minutes the first time)

Follow **[docs/SETUP-WITHINGS.md](docs/SETUP-WITHINGS.md)** if this is your first time. The rest of this section is the same setup, shorter, for reference.

You need a Withings account with your devices synced in the Withings app. Withings' current terms say that sharing data
with a third-party service may require an active **Withings+** subscription (Terms of Use §6.4.1); check this if
authorization works but data calls fail.

### 1. Create your own Withings developer app
1. Open the **Withings Developer Dashboard**: https://developer.withings.com/dashboard/ and sign in. You can use your
   normal Withings account. Withings' guide: https://developer.withings.com/developer-guide/v3/integration-guide/public-health-data-api/developer-account/create-your-accesses-no-medical-cloud
2. Create an application: **Public API integration** on the **Public Cloud** (free; endpoint `https://wbsapi.withings.net`).
3. Give it any name and description that is your own, e.g. "My health data". Don't call it "Withings …".
4. **Callback URL** — pick one, and register it exactly. The plugin's default, used whenever `WITHINGS_REDIRECT_URI` is
   unset, is `http://localhost:8765/callback`. `auth_status` shows the value the running process will send
   (`redirect_uri`), whether you set it or it was defaulted (`redirect_uri_defaulted`, `redirect_uri_source`), and a
   warning to compare it with the dashboard before you open Withings. If they differ, Withings shows
   `redirect_uri_mismatch` and does not give you a code.
   - **No website of your own: `http://localhost:8765/callback`.** Leave `WITHINGS_REDIRECT_URI` empty. Withings accepts
     `http`/`localhost` callbacks for apps in the integration (development) phase, which is limited to 10 users. That's
     fine because the only user is you. With this callback the plugin finishes the setup by itself when the browser is
     on the same computer: it listens on `127.0.0.1:8765` for up to 10 minutes after you start authorization. Use a
     different port by registering it and setting `WITHINGS_REDIRECT_URI` to the same value. Do not point the callback
     at a third-party redirect service; the browser is sent there with a one-time code.
   - **If the dashboard rejects localhost:** register any HTTPS URL you control (e.g. a page on your own website). The
     page doesn't have to do anything. After you approve, your browser lands on `https://your-url?code=…&state=…`. Copy
     that whole address within **30 seconds** (Withings codes are valid for 30 s and work once) and give it to the
     setup CLI or the `exchange_code` tool. Set `WITHINGS_REDIRECT_URI` to exactly the URL you registered.
5. Save. The dashboard shows your **Client ID** and **Secret** (you can look them up there again later).

### 2. Give the client id and secret to the server
The server reads `WITHINGS_CLIENT_ID`, `WITHINGS_CLIENT_SECRET` and, if you didn't use the default callback,
`WITHINGS_REDIRECT_URI`. Pass them in one of two ways (never paste the secret into chat, a project file or a commit):
- **`WITHINGS_ENV_FILE`** (recommended outside Cursor): the absolute path of a `600` file with `KEY=value` lines:
  ```
  WITHINGS_CLIENT_ID=your-client-id
  WITHINGS_CLIENT_SECRET=your-secret
  # optional:
  # WITHINGS_REDIRECT_URI=http://localhost:8765/callback
  # WITHINGS_TOKEN_FILE=/absolute/path/tokens.json
  ```
  Only those four names are read; blank lines, `#` comments, `export ` and quotes are allowed; nothing is
  shell-expanded. Variables set directly in the server's environment win over the file.
- **Directly as environment variables** in your client's settings for the server.

The env file is re-read on every `auth_status`, `setup_guide`, `start_authorization`, and `exchange_code` call, so a
callback change in that file shows up on the next call. Values in the process environment (Cursor's Configure fields,
or variables you exported in the shell) were copied in when the process started. They do not change until a new
process starts, and they override the file. `auth_status` reports `process_started_at`, `config_read_at`,
`redirect_uri_source` (`default`, `environment`, or `env_file`), and `config_stale_warning` when the file and the
environment disagree.

Then register the server with your MCP client and restart/reload it when you set or change environment variables:
- **Cursor:** install the plugin. When it asks for settings, paste the Client ID into **`WITHINGS_CLIENT_ID`** and the
  Secret into **`WITHINGS_CLIENT_SECRET`** (and the callback URL into `WITHINGS_REDIRECT_URI` if you didn't use the
  default). To change them later: **Plugins → Personal Health Data (community) → Configure**, then reload the window.
- **Any other client:** see [Use with other MCP clients](#use-with-other-mcp-clients-grok-bot-claude-desktop-etc).

### 3. Authorize once
Ask the agent to "set up Withings" (it calls `start_authorization`), or run it yourself:

```bash
WITHINGS_ENV_FILE=/absolute/path/to/withings.env node server/cli.mjs authorize
```

(Putting the secret on the command line instead, `WITHINGS_CLIENT_ID=... WITHINGS_CLIENT_SECRET=... node server/cli.mjs
authorize`, also works but leaves it in your shell history.) The CLI must use the same `WITHINGS_TOKEN_FILE` as your MCP
server (the default path, unless you set one). Open the printed URL, sign in to Withings and approve. With the localhost callback and the browser on the same computer, the page says "Connected" and
you're done. With your own HTTPS callback, paste the full redirect URL when the CLI asks (within 30 seconds). Check with
`auth_status` or `node server/cli.mjs status`.

Then ask something like "How has my weight and body fat changed this month?"

#### Browser and server on different computers
The localhost callback only completes by itself when the browser runs on the **same machine** as the server, because
Withings redirects your browser to `http://localhost:8765/callback`, i.e. to the browser's own machine.

The common case for a hosted assistant is exactly that: the plugin runs on the assistant's computer, and your browser
is on your own computer. The localhost page fails to load. That is expected. Copy the whole address from the address
bar (`http://localhost:8765/callback?code=…&state=…`) and paste it back to the assistant **right away** (within 30
seconds). The assistant passes it to `exchange_code` on the **same server process** that ran `start_authorization`.

The same paste works if the server is a remote box, a container, or an SSH session. At the CLI, paste it at the
`Redirect URL (or wait):` prompt of the same `node server/cli.mjs authorize` run.

Or forward the port before you approve: `ssh -L 8765:127.0.0.1:8765 you@server`, then the redirect reaches the
server's listener through the tunnel and finishes by itself.

## Use with other MCP clients (Grok Bot, Claude Desktop, etc.)
The bundled `mcp.json` is for Cursor: `${CURSOR_PLUGIN_ROOT}` and `${WITHINGS_…}` are Cursor plugin variables, and
other clients will not expand them. Elsewhere, point the client at `server/index.mjs` with an **absolute path** (no
`~`, no `${...}`) and pass the credentials by file:

```json
{
  "mcpServers": {
    "personal-health-data": {
      "command": "node",
      "args": ["/absolute/path/to/personal-health-data-mcp/server/index.mjs"],
      "env": { "WITHINGS_ENV_FILE": "/absolute/path/to/withings.env" }
    }
  }
}
```

- `command` may need the absolute path to `node` (`which node`) if the client does not inherit your shell's `PATH`.
- Put secrets in `env` (better: in the env file), never in `args`: `args` show up in process lists.
- On Windows use a path like `"C:\\Users\\you\\personal-health-data-mcp\\server\\index.mjs"`.

### Keeping secrets out of client configs: launcher script
If your client can only run a command, or you want one place to manage credentials, use a launcher that points the
server at the `600` env file and `exec`s it. The client config then names only the script. A copy is in
`examples/run-health-data.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT=/absolute/path/to/personal-health-data-mcp
export WITHINGS_ENV_FILE="${WITHINGS_ENV_FILE:-$HOME/.config/personal-health-data-mcp/withings.env}"
[ -r "$WITHINGS_ENV_FILE" ] || { echo "run-health-data: env file missing or unreadable" >&2; exit 1; }
exec node "$ROOT/server/index.mjs"
```

Client config: `{"command": "/absolute/path/to/run-health-data.sh", "args": []}`. Keep the script, the env file and
the token file outside any repository you commit.

## Tokens, lifetime and re-authorizing
- Tokens are stored in **`~/.config/personal-health-data-mcp/tokens.json`** (`$XDG_CONFIG_HOME` if set; on Windows
  `%APPDATA%\personal-health-data-mcp\tokens.json`), outside any project, with the folder at mode `700` and the file at
  `600`. Your Withings user id is not stored.
- **`WITHINGS_TOKEN_FILE`** (env or env file) sets another absolute path, e.g. to keep it next to your other secrets
  or to give separate installs separate files. The server creates the folder (`700`) and file (`600`) when you authorize.
- **Sharing one token file between installs** (two MCP clients, two machines with a synced folder, a dev copy and an
  installed copy): the refresh token **rotates on every refresh** and the old one stops working soon after. Sharing is
  only safe when every process is this plugin (same version or later) using the **same file on the same filesystem**,
  because the plugin serialises refreshes with a lock file next to it (`tokens.json.lock`) and re-reads the file under
  that lock. Don't share it with other Withings tools, copy it between machines, or put it on a synced/network folder
  where the lock doesn't work: one side will refresh, the other will keep an outdated refresh token, and you'll have
  to re-authorize. If in doubt, give each install its own `WITHINGS_TOKEN_FILE` and authorize each once.
- Per Withings' docs (https://developer.withings.com/developer-guide/v3/integration-guide/public-health-data-api/get-access/access-and-refresh-tokens-no-recover):
  the **access token expires after 3 hours**; the **refresh token expires after 1 year**; and every refresh returns a
  **new refresh token**. The old one stops working 8 hours later or as soon as the new access token is used.
- The server refreshes the access token automatically when it has less than 10 minutes left (or when Withings rejects
  it) and saves the new pair straight away, under a file lock, so two processes don't race on the rotating token.
- **Re-authorize** (run step 3 again) if the refresh token expired (about a year without use), if you revoked access in
  the Withings app, if you changed the app's secret, or if a tool says the token was rejected. Running authorization
  again simply replaces the token file.
- **Revoke access** at any time in the Withings app (connected apps/partners), or delete the app in the developer
  dashboard. Deleting the token file removes local access.

## Privacy and security
- The client secret is stored either by your MCP client (e.g. Cursor's plugin settings) and passed to the local server
  as an environment variable, or in a file you control (`WITHINGS_ENV_FILE`) that the server reads at runtime. It is sent only to Withings (`wbsapi.withings.net`), and only when tokens are issued or refreshed.
- Errors are redacted. The secret, codes and tokens are never logged or returned by any tool.
- No telemetry, no third-party servers, no server run by the author. The code sends requests only to Withings. Your data
  goes from Withings to the computer running the server and then to your MCP client and the AI model you use there,
  under those providers' terms. Make sure you are comfortable sharing health data with that model.
- The author of this plugin does not receive, store or have access to your credentials, tokens or data. Tokens are
  kept only in the local token file described above.
- This is for **your own data**. Don't use it to run a service for other people, and don't share your app's secret.
  Each person who installs the plugin creates their own Withings app, so no one else's app or server sits between you
  and Withings.

## Troubleshooting
The same cases, with the wording to expect, are in [docs/SETUP-WITHINGS.md](docs/SETUP-WITHINGS.md) ("If you get this error, do this").
- **Redirect URI mismatch.** Withings shows `redirect_uri_mismatch` / "does not match partner callback url" instead of
  the approval page, or `exchange_code` / the CLI says it rejected the callback and names `redirect_uri=…`. The value
  this process sends (`redirect_uri` in `auth_status`) must equal a Callback URL in your developer app **character for
  character**: scheme (`http` vs `https`), host (`localhost` vs `127.0.0.1`), port, path, and trailing slash.
  `redirect_uri_defaulted: true` means `WITHINGS_REDIRECT_URI` is unset and the server is using
  `http://localhost:8765/callback` — register that exact URL, or set the variable to the URL you already registered.
  If `redirect_uri_source` is `environment`, restart or reload so a new process starts. If it is `env_file`, the next
  auth call re-reads the file; a set environment variable still wins (`config_stale_warning`). Then run
  `start_authorization` again. The code from the failed attempt can't be reused.
- **Changed the settings but the old value is still in use.** Compare `process_started_at` with when you edited.
  Environment variables are frozen for the life of the process (a Cursor reload that does not actually respawn the
  server leaves the old value). The env file is not frozen. `config_note` says which redirect this process used.
  `config_stale_warning` is set when the env file and the environment disagree. For the redirect it names both URLs.
  For `WITHINGS_CLIENT_ID` or `WITHINGS_CLIENT_SECRET` it names the variable only and does not print the value.
- **Code expired / invalid (status 304, "invalid code").** Codes last about 30 seconds, work once, and must be
  exchanged by the same server process that started the authorization. `exchange_code` says this separately from a
  callback mismatch. Run `start_authorization` again and paste the new address immediately. If the pasted address's
  callback is not the one this server is using, the code is not sent (so it is not used up) and the error names both
  URLs.
- **"Not set up yet"** although you set the values: your client probably passed the literal `${WITHINGS_CLIENT_ID}`
  (only Cursor expands it). Use an absolute `WITHINGS_ENV_FILE`. `auth_status` shows `env_file_problem` if the file
  can't be read.
- **State mismatch**: the pasted redirect belongs to a different `start_authorization`. Start again; don't reuse the code.
- **The localhost page will not load:** the browser is not on the same computer as the plugin. That includes a hosted
  assistant (plugin on the assistant's computer, browser on yours). Copy the full address bar and paste it back to
  the assistant within 30 seconds, or forward the port (`ssh -L 8765:127.0.0.1:8765 you@server`).
- **Port 8765 in use**: free it, or register another localhost port and set `WITHINGS_REDIRECT_URI` to match.
- **Token rejected after it worked before**: see "Sharing one token file" above; re-authorize. If you changed the
  callback since authorizing, `redirect_changed_warning` says so; data calls keep working until you re-authorize.
- **`get_sleep_summary` returns nothing**: no sleep device is linked in Withings. Check `list_devices`.

## Limits and caveats
- Withings asks partners not to poll more than about once every 10 minutes per user and reports rate limiting as
  status `601`. The server spaces calls, retries `601`/HTTP 5xx with backoff, and only calls the API when you ask.
- Body composition from a scale is an estimate. One step-on can be stored as several measurement groups a few seconds
  apart; the server merges groups from the same device that are at most 2 minutes apart into one row.
- Not included: writing or deleting data, ECG waveforms, intraday streams, webhooks/notifications.
- Field meanings follow Withings' API reference (https://developer.withings.com/api-reference) and may change when
  Withings updates it.

## Development
```bash
npm test                     # offline tests: node --test test/*.test.mjs (mocked Withings HTTP; no credentials)
npm run test:live            # a few real read-only calls against your own account (needs env + a token file)
npm run authorize            # one-time authorization (CLI)
```
No dependencies, no install step (`npm ci` works with the empty lockfile but isn't needed). The code: `server/client.mjs` (OAuth, token file, refresh, retries, redirect warnings), `server/auth-flow.mjs` (localhost
callback listener), `server/setup-guide.mjs` (the walkthrough `setup_guide` returns), `server/tools.mjs` (tools and output shapes), `server/index.mjs` (MCP stdio JSON-RPC),
`server/cli.mjs` (setup CLI). The human setup steps are `docs/SETUP-WITHINGS.md`.

## Disclaimer
- **Not medical advice.** This plugin retrieves data you already have in your Withings account, for general wellness
  and informational purposes only. It is not a medical device and is not intended to diagnose, treat, cure, monitor or
  prevent any disease or condition. Values (including blood pressure, heart rate and the device's own estimates such
  as body composition, metabolic or vascular age) come from consumer devices, may be missing or inaccurate, and are
  passed on as Withings reports them. Don't make medical decisions based on them; ask a doctor or other qualified
  health professional about any health concern. Any interpretation an AI assistant adds is the assistant's, not this
  plugin's.
- **Your data.** The plugin runs on the computer where you start it and talks only to Withings, using your own
  developer app. It has no telemetry and no server of its own, and the author does not receive, store or have access to
  your credentials, tokens or data. Your MCP client and AI model provider handle the data under their own terms, which
  you choose.
- **Unofficial.** Community project, compatible with Withings; not affiliated with, endorsed or sponsored by Withings.
  Withings is a trademark of Withings, used only to say what the plugin is compatible with.
- **Provided as is, use at your own risk.** No warranty of any kind (see `LICENSE`). You are responsible for following
  Withings' terms (Terms of Use and developer/API terms) and for your own data.

## License
MIT (provided "as is", without warranty). See `LICENSE`. Not affiliated with Withings.
