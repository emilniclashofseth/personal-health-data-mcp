---
name: personal-health-data
description: Use when the user asks about their own Withings data, such as weight, body fat, muscle, water, bone or visceral fat from a Withings scale, blood pressure, daily steps and activity, sleep from a Withings sleep mat or watch, or which Withings devices are linked; or when they need to set up or re-authorize Withings access. Calls the read-only tools of the personal-health-data MCP server (unofficial community plugin, not affiliated with Withings).
---

# Personal Health Data (community) · Compatible with Withings

Data shapes the tools return (all carry `data_source: "Withings"`; units are in the field names and in `units`):
- `BodyMeasurement = { date, time_local, weight_kg, fat_ratio_pct, fat_mass_kg, fat_free_mass_kg, muscle_mass_kg, hydration_kg, bone_mass_kg, visceral_fat, extracellular_water_kg, intracellular_water_kg, basal_metabolic_rate_kcal, metabolic_age_years, pulse_wave_velocity_m_s, vascular_age_years, heart_rate_bpm, source (device|manual|ambiguous), device_model }`
- `BloodPressure = { date, time_local, systolic_mmhg, diastolic_mmhg, pulse_bpm }`
- `DayActivity = { date, steps, distance_km, floors, active_min, active_kcal, total_kcal, hr_avg, hr_zone_min }`
- `NightSleep = { date (wake day), start_local, end_local, total_sleep_min, time_in_bed_min, deep/light/rem/awake_min, sleep_efficiency_pct, sleep_score, hr_avg, rr_avg, snoring_min }`

## Which tool
| Question | Tool |
|---|---|
| Weight, body fat, muscle, water, bone, visceral fat, trends | `get_body_measurements` (default last 30 days) |
| Blood pressure | `get_blood_pressure` |
| Steps, activity minutes, calories | `get_daily_activity` (default 7 days) |
| How did I sleep (Withings sleep mat / watch) | `get_sleep_summary` (default 7 days; if empty, it returns a `hint`: check `list_devices`) |
| Which devices, last sync, battery | `list_devices` |
| Is it set up? | `auth_status` (also says which redirect is live, and whether it was defaulted) |
| Walk a new user through setup | `setup_guide`, one step per turn. Human version: `docs/SETUP-WITHINGS.md` |
| First-time setup or re-authorize | `start_authorization`, then `exchange_code` if the callback is not localhost or the browser is on another computer than the server |

## Rules
- Dates are `YYYY-MM-DD` in the user's local time. Ranges up to 366 days per call. Fetch the smallest range that answers the question.
- One body row is one step on the scale. Several readings on the same day are separate rows; for a daily trend use the first reading of each day (morning) unless the user says otherwise.
- General wellness information only, not medical advice. Report what the device recorded; don't diagnose, label readings as a condition, or suggest treatment or medication. When you interpret health values or trends (blood pressure, heart rate, body composition, vascular or metabolic age, sleep), add a short note that this is not medical advice. If readings look concerning (e.g. high or low blood pressure) or the user mentions symptoms, suggest they talk to a doctor or other qualified health professional (for an emergency, local emergency services).
- Never invent, estimate or fill values. `null` means the device did not measure it; an empty list means no data in the range. Say which.
- `source: "manual"` rows were typed in by hand; `ambiguous` means Withings was not sure whose weigh-in it was. Mention this when it matters.
- Body composition from a scale is an estimate; describe trends over weeks, not day-to-day changes.
- When you show this data in a chart, table or summary, say it comes from Withings (e.g. "Source: Withings").
- Never ask the user to paste the client secret or tokens into chat. Setup values go wherever their MCP client keeps this server's settings: `WITHINGS_CLIENT_ID` / `WITHINGS_CLIENT_SECRET` as settings or env vars (in Cursor: Plugins → this plugin → Configure), or a `600` file named by `WITHINGS_ENV_FILE`. Environment variables apply only when a new server process starts (Cursor: reload the window). The env file is re-read on the next auth call and does not override a set environment variable. Say that out loud when `config_stale_warning` or `redirect_uri_source: "environment"` is why a change did not show up. `process_started_at` is when this process captured the environment.
- For a first-time user, call `setup_guide` and give them **one step**, then wait. Tone: this is not super straightforward, but if they follow the steps exactly it should be fine; it is mostly copy-pasting. The first time takes about 10–15 minutes. Steps with `done: null` are on the Withings website, which you cannot see; when the user says that step is done, go to the next step even if `current_step` has not moved. The default callback, when `WITHINGS_REDIRECT_URI` is unset, is `http://localhost:8765/callback`. They do not need a website. Do not send them to a third-party redirect.
- Before `start_authorization`, read `redirect_warning` to the user. The `redirect_uri` in that response must match a Callback URL in their Withings app exactly (scheme, host, port, path, trailing slash), or Withings shows `redirect_uri_mismatch` and no code. `redirect_uri_defaulted: true` means they must have registered `http://localhost:8765/callback` unless they set the variable.
- The one-time authorization code is not the client secret, but it expires in 30 seconds and must reach the same server process that ran `start_authorization`. If the browser is on the same computer as the server, the localhost callback finishes by itself. If this plugin runs on the assistant's computer and the user's browser is on their own computer (the usual hosted-assistant case), or the server is otherwise remote or headless, the localhost page fails to load. That is expected. Ask them to copy the full address from the address bar and paste it back right away for `exchange_code`, or use the CLI (`node server/cli.mjs authorize`), which accepts the paste too. Do not retry a code the tool says was rejected; start authorization again. If the tool says the pasted address is for a different callback and the code was not sent, fix the callback first. `config_stale_warning` may name `WITHINGS_CLIENT_ID` or `WITHINGS_CLIENT_SECRET` as well as the redirect; it never includes those values.
- `auth_status` lists `requested_scopes` (user.info, user.metrics, user.activity) and `granted_scopes`. Withings may add `user.sleepevents`; it is notification-only and unused. Don't present it as something the plugin asked for.
- If a tool says the token was rejected or expired, run `start_authorization` again (re-authorize). Refresh tokens last about a year if unused and rotate on every refresh; the server handles that.
- Not available here: writing or deleting data, ECG waveforms, raw intraday streams, notifications/webhooks.
