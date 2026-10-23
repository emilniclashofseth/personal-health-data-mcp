# Local proof, 23 Oct 2026 (Europe/Oslo)

Run against the owner's real Withings account with his existing developer app. The credentials were loaded into
environment variables from his existing files by a wrapper and were never printed. To protect his own pipeline's
**rotating** refresh token, the proof used a temporary token file holding only a fresh access token (no refresh token,
no user id), deleted afterwards. Live refresh therefore was not exercised against Withings here; it is covered by the
mocked tests. Read-only calls only. **Counts only below, no health values.**

| Check | Result |
|---|---|
| `node --check` on all five server files | PASS |
| `npm test` (offline, mocked Withings HTTP): config/placeholder handling, date validation, missing credentials → setup help with no request, read-only scopes in the authorization URL, `exchange_code` saves tokens with mode 600 (dir 700) and no user id, expired token → refresh → rotated refresh token saved, status 401 → one forced refresh, rejected refresh token → re-authorize message, 601 + HTTP 502 retried, secret/tokens redacted in errors, unit decoding + step-on merging + paging + nulls kept + manual filter, BP/activity/sleep shapes, localhost callback listener (state check, exchange, token saved), MCP handshake/tools/list/annotations | 15/15 PASS (live test skipped by default) |
| `npm run test:live` (real account) | PASS |
| stdio JSON-RPC session (spawned server) | initialize (2025-06-18), tools/list = 8 tools |
| `get_body_measurements`, last 30 days | 21 weigh-ins on 21 dates; 15 metric fields present (weight, fat-free mass, fat %, fat mass, muscle, hydration, bone, visceral fat, extra/intracellular water, BMR, metabolic age, pulse wave velocity, vascular age, heart rate) |
| Cross-check vs the owner's own independent pipeline CSV, same 30 days | 21/21 weigh-ins matched by local date + time; weight equal 21/21; fat % equal 14/14 where both have it |
| `get_body_measurements`, 366 days | 185 weigh-ins (1 API request, paging handled) |
| `get_blood_pressure`, 30 days | 0 (no BP device; returns an empty list, no error) |
| `get_daily_activity`, 7 days | 4 days |
| `get_sleep_summary`, 7 days | 0 (no sleep device; empty list, no error) |
| `list_devices` | 2 devices, no ids in output |
| Whole live session | 2.5 s, no rate limiting, stderr empty. All output scanned for client id, secret, access token, refresh token and user id: 0 hits each |
| Manifests | Cursor `plugin-template` validator: PASS (warning only: no hooks). `mcp.json` server entry validates against agent-plugins.org mcp.schema 1.0.0. Every `${VAR}` is declared under `variables` |
| Local install | real directory `~/.cursor/plugins/local/personal-health-data-mcp` (not a symlink) |
| Cursor launch simulation | read `mcp.json` from the installed copy, expanded `${CURSOR_PLUGIN_ROOT}` and the variables in memory, left `WITHINGS_REDIRECT_URI` unset → default `http://localhost:8765/callback`. 8 tools, `list_devices` OK, `start_authorization` returned an account.withings.com URL with scopes `user.info,user.metrics,user.activity` and a localhost listener (not completed) |

Not provable here: the `@anysphere/cursor-plugins` loader (`loadUserLocalPlugins`) is not on the public npm registry,
and there is no Cursor IDE on this machine. So these are unverified: the Customize UI, the variables prompt at
install, and org policy ("Allow Local Plugin Imports"). The Withings dashboard's acceptance of a localhost callback was
not tested first-hand (the owner's app uses an HTTPS callback).
