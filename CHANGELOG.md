# Changelog

## 0.3.0 — 2026-10-23

- `auth_status` and `start_authorization` name the redirect URI the running process will send, whether it was configured or fell back to the default `http://localhost:8765/callback`, and that it must match a Callback URL in the user's Withings app exactly. This is shown before the user opens Withings, instead of only after Withings returns `redirect_uri_mismatch`.
- The env file is re-read on every auth call. Environment variables still come from process start. Status reports where the redirect came from, when the process started, when config was read, and a warning when the env file and the environment disagree.
- The token file records the redirect used at authorization (not a secret). Status warns if the live redirect has since changed. Refresh keeps that recorded redirect.
- `exchange_code` and the CLI distinguish a callback mismatch from an expired or invalid code, and refuse to send a code whose pasted callback does not match the one this process is using.
- `setup_guide` and `docs/SETUP-WITHINGS.md` walk a non-technical user through setup one step at a time. The first time takes about 10–15 minutes. The default callback is the localhost URL above, so no website is required. When the plugin runs on an assistant's computer and the browser is on the user's, the localhost page fails to load; they paste the address back. The one-time code is not sent to a third party.
- The paste check compares normalised callbacks (lowercase scheme and host, default port dropped, empty path as `/`). A trailing slash on a non-root path still counts, and `localhost` is still different from `127.0.0.1`. A configured value that is not a URL does not block the paste.
- `config_stale_warning` also names `WITHINGS_CLIENT_ID` or `WITHINGS_CLIENT_SECRET` when the environment overrides a different env-file value. It does not print either value.

## 0.2.0 — 2026-10-23

- `WITHINGS_ENV_FILE` for credentials outside the client config.
- Remote / headless browser: paste the redirect URL into `exchange_code` or the CLI.
- Requested scopes vs scopes Withings added (`user.sleepevents`) called out in `auth_status`.
- Empty sleep results explain that a sleep device is required.

## 0.1.0 — 2026-10-23

- Initial release. Read-only Withings Public API tools, local OAuth, Cursor plugin.
