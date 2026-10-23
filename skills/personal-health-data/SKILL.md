---
name: personal-health-data
description: Use when the user asks about their own Withings data, such as weight, body fat, muscle, water, bone or visceral fat from a Withings scale, blood pressure, daily steps and activity, sleep from a Withings sleep mat or watch, or which Withings devices are linked; or when they need to set up or re-authorize Withings access. Calls the read-only tools of the personal-health-data MCP server (community plugin, not made by Withings).
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
| Is it set up? | `auth_status` |
| First-time setup or re-authorize | `start_authorization`, then `exchange_code` if the callback is not localhost or the browser is on another computer than the server |

## Rules
- Dates are `YYYY-MM-DD` in the user's local time. Ranges up to 366 days per call. Fetch the smallest range that answers the question.
- One body row is one step on the scale. Several readings on the same day are separate rows; for a daily trend use the first reading of each day (morning) unless the user says otherwise.
- Never invent, estimate or fill values. `null` means the device did not measure it; an empty list means no data in the range. Say which.
- `source: "manual"` rows were typed in by hand; `ambiguous` means Withings was not sure whose weigh-in it was. Mention this when it matters.
- Body composition from a scale is an estimate; describe trends over weeks, not day-to-day changes.
- When you show this data in a chart, table or summary, say it comes from Withings (e.g. "Source: Withings").
- Never ask the user to paste the client secret or tokens into chat. Setup values go wherever their MCP client keeps this server's settings: `WITHINGS_CLIENT_ID` / `WITHINGS_CLIENT_SECRET` as settings or env vars (in Cursor: Plugins → this plugin → Configure), or a `600` file named by `WITHINGS_ENV_FILE`. Then restart or reload the server.
- The one-time authorization code is not a secret, but it expires in 30 seconds and must reach the same server process that ran `start_authorization`. If the browser is on the same computer as the server, the localhost callback finishes by itself. If not (remote or headless server), the redirect page fails to load; ask the user to copy the full address from the address bar and pass it to `exchange_code` right away, or use the CLI (`node server/cli.mjs authorize`), which accepts the paste too.
- If authorization fails with a redirect URI problem, the server's `WITHINGS_REDIRECT_URI` (see `auth_status`) must match a Callback URL in the user's Withings app exactly (scheme, host, port, path, trailing slash).
- `auth_status` lists `requested_scopes` (user.info, user.metrics, user.activity) and `granted_scopes`. Withings may add `user.sleepevents`; it is notification-only and unused. Don't present it as something the plugin asked for.
- If a tool says the token was rejected or expired, run `start_authorization` again (re-authorize). Refresh tokens last about a year if unused and rotate on every refresh; the server handles that.
- Not available here: writing or deleting data, ECG waveforms, raw intraday streams, notifications/webhooks.
