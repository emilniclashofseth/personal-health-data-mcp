# Personal Health Data (community)

*Compatible with Withings.*

**A personal, community-built plugin. It is not made, endorsed, or supported by Withings.**
It reads **only your own data**, through the official Withings Public API (https://developer.withings.com), using a
Withings developer app that **you** create for yourself. It is read-only: it cannot change anything in your Withings
account or on your devices.

Withings is a trademark of Withings. The name is used here only to say which service the plugin is compatible with.
No Withings logo or artwork is used.

It is a Cursor plugin with a small stdio MCP server (Node.js 18+, no dependencies) and one skill that tells the agent
when to use the tools.

## Tools
| Tool | What it returns | Withings endpoint (POST) | Scope |
|---|---|---|---|
| `get_body_measurements` | one row per weigh-in: weight, fat %, fat mass, fat-free mass, muscle, hydration, bone, visceral fat, extra/intracellular water, BMR, metabolic age, pulse wave velocity, vascular age, standing heart rate | `/measure` `getmeas` | user.metrics |
| `get_blood_pressure` | systolic, diastolic, pulse | `/measure` `getmeas` (types 9, 10, 11) | user.metrics |
| `get_daily_activity` | steps, distance, floors, activity minutes, calories, HR and HR zones per day | `/v2/measure` `getactivity` | user.activity |
| `get_sleep_summary` | per night: total sleep, time in bed, stages, efficiency, latency, wake-ups, sleep score, HR, breathing rate, snoring | `/v2/sleep` `getsummary` | user.activity |
| `list_devices` | linked devices: type, model, battery, firmware, last sync (no serial numbers or ids) | `/v2/user` `getdevice` | user.info |
| `auth_status` | is it configured and authorized, token file path, minutes left on the access token | (local) | |
| `start_authorization` / `exchange_code` | one-time authorization (see Setup) | `/v2/oauth2` `requesttoken` | |

Range tools take `start_date` / `end_date` (`YYYY-MM-DD`, your local dates; up to 366 days per call). Values are decoded
from Withings' `value × 10^unit` format into the units named in each field. Metrics your device didn't measure are
`null`, never 0. Every result carries `data_source: "Withings"`.

The plugin asks only for the read scopes `user.info`, `user.metrics` and `user.activity`. It never requests anything
that can write. (`user.sleepevents` only drives webhook notifications, which this plugin doesn't use.)

## Setup (about 5 minutes, once)

You need a Withings account with your devices synced in the Withings app. Withings' current terms say that sharing data
with a third-party service may require an active **Withings+** subscription (Terms of Use §6.4.1); check this if
authorization works but data calls fail.

### 1. Create your own Withings developer app
1. Open the **Withings Developer Dashboard**: https://developer.withings.com/dashboard/ and sign in. You can use your
   normal Withings account. Withings' guide: https://developer.withings.com/developer-guide/v3/integration-guide/public-health-data-api/developer-account/create-your-accesses-no-medical-cloud
2. Create an application: **Public API integration** on the **Public Cloud** (free; endpoint `https://wbsapi.withings.net`).
3. Give it any name and description that is your own, e.g. "My health data". Don't call it "Withings …".
4. **Callback URL** — pick one:
   - **Recommended: `http://localhost:8765/callback`.** Withings accepts `http`/`localhost` callbacks for apps in the
     integration (development) phase, which is limited to 10 users. That's fine because the only user is you. With this
     callback the plugin finishes the setup by itself: it listens on `127.0.0.1:8765` for up to 10 minutes after you
     start authorization. Use a different port by registering it and setting `WITHINGS_REDIRECT_URI` to the same value.
   - **If the dashboard rejects localhost:** register any HTTPS URL you control (e.g. a page on your own website). The
     page doesn't have to do anything. After you approve, your browser lands on `https://your-url?code=…&state=…`. Copy
     that whole address within **30 seconds** (Withings codes are valid for 30 s and work once) and give it to the
     setup CLI or the `exchange_code` tool. Set `WITHINGS_REDIRECT_URI` to exactly the URL you registered.
5. Save. The dashboard shows your **Client ID** and **Secret** (you can look them up there again later).

### 2. Install the plugin and paste the client id and secret
Install the plugin in Cursor. When it asks for settings, paste the Client ID into **`WITHINGS_CLIENT_ID`** and the
Secret into **`WITHINGS_CLIENT_SECRET`** (and the callback URL into `WITHINGS_REDIRECT_URI` if you didn't use the
default). To change them later: **Plugins → Personal Health Data (community) → Configure**, then reload the window.
Never paste the secret into chat, a project file or a commit.

### 3. Authorize once
Ask the agent to "set up Withings" (it calls `start_authorization`), or run it yourself:

```bash
WITHINGS_CLIENT_ID=... WITHINGS_CLIENT_SECRET=... node server/cli.mjs authorize
```

Open the printed URL, sign in to Withings and approve. With the localhost callback the page says "Connected" and you're
done. With your own HTTPS callback, paste the full redirect URL when the CLI asks (within 30 seconds). Check with
`auth_status` or `node server/cli.mjs status`.

Then ask something like "How has my weight and body fat changed this month?"

Running the server outside Cursor (any MCP client): set `WITHINGS_CLIENT_ID` and `WITHINGS_CLIENT_SECRET` in the
server's `env` (not in `args`) and run `node server/index.mjs`.

## Tokens, lifetime and re-authorizing
- Tokens are stored in **`~/.config/personal-health-data-mcp/tokens.json`** (`$XDG_CONFIG_HOME` if set; on Windows
  `%APPDATA%\personal-health-data-mcp\tokens.json`), outside any project, with the folder at mode `700` and the file at
  `600`. Override with `WITHINGS_TOKEN_FILE`. Your Withings user id is not stored.
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
- The client secret is stored by your MCP client (Cursor's plugin settings) and passed to the local server as an
  environment variable. It is sent only to Withings (`wbsapi.withings.net`), and only when tokens are issued or refreshed.
- Errors are redacted. The secret, codes and tokens are never logged or returned by any tool.
- No telemetry, no third-party servers. Your data goes from Withings to your computer and to the AI model you use in
  your client. Make sure you are comfortable sharing health data with that model.
- This is for **your own data**. Don't use it to run a service for other people, and don't share your app's secret.
  Each person who installs the plugin creates their own Withings app, so nobody's data passes through anyone else.

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
npm test                     # offline tests (mocked Withings HTTP; no credentials needed)
npm run test:live            # a few real read-only calls against your own account (needs env + a token file)
npm run authorize            # one-time authorization (CLI)
```
No dependencies. The code: `server/client.mjs` (OAuth, token file, refresh, retries), `server/auth-flow.mjs` (localhost
callback listener), `server/tools.mjs` (tools and output shapes), `server/index.mjs` (MCP stdio JSON-RPC),
`server/cli.mjs` (setup CLI).

## License
MIT. See `LICENSE`. Not affiliated with Withings.
