// Tool definitions and compact, stable output shapes (read-only).
//   BodyMeasurement = { date, time_local, weight_kg, fat_ratio_pct, fat_mass_kg, fat_free_mass_kg, muscle_mass_kg, hydration_kg, bone_mass_kg, visceral_fat, ... }
//   BloodPressure   = { date, time_local, systolic_mmhg, diastolic_mmhg, pulse_bpm }
//   DayActivity     = { date, steps, distance_km, floors, active_min, active_kcal, total_kcal, hr_avg, ... }
//   NightSleep      = { date (wake day), start_local, end_local, total_sleep_min, deep/light/rem_min, sleep_score, ... }
// Values are decoded (value * 10^unit). A missing metric is null, never 0. Every result carries data_source: "Withings".
import { SCOPES, SETUP_HELP, WithingsError, resolveRange, addDays } from "./client.mjs";

const SOURCE = "Withings";

// Withings meastype -> [field, unit, decimals]  (https://developer.withings.com/api-reference/#tag/measure)
export const MEASTYPES = {
  1: ["weight_kg", "kg", 2], 4: ["height_m", "m", 2], 5: ["fat_free_mass_kg", "kg", 2], 6: ["fat_ratio_pct", "%", 1],
  8: ["fat_mass_kg", "kg", 2], 9: ["diastolic_mmhg", "mmHg", 0], 10: ["systolic_mmhg", "mmHg", 0], 11: ["heart_rate_bpm", "bpm", 0],
  12: ["temperature_c", "°C", 2], 54: ["spo2_pct", "%", 1], 71: ["body_temperature_c", "°C", 2], 73: ["skin_temperature_c", "°C", 2],
  76: ["muscle_mass_kg", "kg", 2], 77: ["hydration_kg", "kg", 2], 88: ["bone_mass_kg", "kg", 2], 91: ["pulse_wave_velocity_m_s", "m/s", 2],
  123: ["vo2max_ml_min_kg", "ml/min/kg", 1], 155: ["vascular_age_years", "years", 0], 167: ["nerve_health_score", "score", 0],
  168: ["extracellular_water_kg", "kg", 2], 169: ["intracellular_water_kg", "kg", 2], 170: ["visceral_fat", "index (no unit)", 1],
  226: ["basal_metabolic_rate_kcal", "kcal", 0], 227: ["metabolic_age_years", "years", 0],
};
const BODY_TYPES = [1, 5, 6, 8, 76, 77, 88, 170, 168, 169, 226, 227, 91, 155, 11];
const BP_TYPES = [9, 10, 11];
const ATTRIB = { 0: "device", 1: "ambiguous", 2: "manual", 4: "manual", 5: "device", 7: "device", 8: "device" };
const SESSION_GAP_S = 120;   // one weigh-in can be split into several measure groups a few seconds apart

const round = (x, d) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const n = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const minOf = (s) => (typeof s === "number" ? Math.round(s / 60) : null);
const sysTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function localParts(epochS, tz) {
  if (typeof epochS !== "number") return { date: null, time: null };
  let z = tz; try { new Intl.DateTimeFormat("en", { timeZone: z }); } catch { z = sysTz(); }
  const s = new Intl.DateTimeFormat("sv-SE", { timeZone: z || sysTz(), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(epochS * 1000));
  const [date, time] = s.split(" ");
  return { date, time };
}

// ---------- transforms
export function decodeGroup(g, tz, types) {
  const vals = {};
  for (const m of g.measures || []) {
    const t = MEASTYPES[m.type];
    if (!t || !types.includes(m.type) || typeof m.value !== "number" || typeof m.unit !== "number") continue;
    vals[t[0]] = round(m.value * 10 ** m.unit, t[2]);
  }
  const { date, time } = localParts(g.date, tz);
  return { _ts: g.date, _dev: g.deviceid ?? g.hash_deviceid ?? null, date, time_local: time, source: ATTRIB[g.attrib] ?? "other", device_model: g.model ?? null, vals };
}

function emptyRow(types) { return Object.fromEntries(types.map((t) => [MEASTYPES[t][0], null])); }

/** Merge measure groups from one step-on (same device, <= 2 min apart). The group that has body composition wins on weight. */
export function mergeSessions(groups, types) {
  const out = [];
  for (const g of [...groups].sort((a, b) => a._ts - b._ts)) {
    const cur = out.at(-1);
    if (cur && g._dev && cur._dev === g._dev && g._ts - cur._last <= SESSION_GAP_S) {
      cur._last = g._ts; cur.measure_groups++;
      const takeAll = g.vals.weight_kg != null && (g.vals.fat_ratio_pct != null || cur.fat_ratio_pct == null);
      if (takeAll) { cur.date = g.date; cur.time_local = g.time_local; }
      for (const [k, v] of Object.entries(g.vals)) if (v != null && (cur[k] == null || takeAll)) cur[k] = v;
      continue;
    }
    out.push({ date: g.date, time_local: g.time_local, ...emptyRow(types), ...g.vals, source: g.source, device_model: g.device_model, measure_groups: 1, _dev: g._dev, _last: g._ts });
  }
  return out.map(({ _dev, _last, ...r }) => r);
}

export function dayActivity(a) {
  return {
    date: a.date ?? null, steps: n(a.steps), distance_km: typeof a.distance === "number" ? round(a.distance / 1000, 2) : null,
    floors: n(a.elevation), soft_min: minOf(a.soft), moderate_min: minOf(a.moderate), intense_min: minOf(a.intense), active_min: minOf(a.active),
    active_kcal: round(a.calories, 0), total_kcal: round(a.totalcalories, 0),
    hr_avg: n(a.hr_average), hr_min: n(a.hr_min), hr_max: n(a.hr_max),
    hr_zone_min: { light: minOf(a.hr_zone_0), moderate: minOf(a.hr_zone_1), intense: minOf(a.hr_zone_2), max: minOf(a.hr_zone_3) },
    is_tracker: typeof a.is_tracker === "boolean" ? a.is_tracker : null,
  };
}
const ACTIVITY_FIELDS = "steps,distance,elevation,soft,moderate,intense,active,calories,totalcalories,hr_average,hr_min,hr_max,hr_zone_0,hr_zone_1,hr_zone_2,hr_zone_3";

export function nightSleep(s) {
  const d = s.data || {};
  const st = localParts(s.startdate, s.timezone), en = localParts(s.enddate, s.timezone);
  return {
    date: s.date ?? en.date, start_local: st.date ? `${st.date} ${st.time}` : null, end_local: en.date ? `${en.date} ${en.time}` : null,
    total_sleep_min: minOf(d.total_sleep_time ?? d.asleepduration), time_in_bed_min: minOf(d.total_timeinbed),
    deep_min: minOf(d.deepsleepduration), light_min: minOf(d.lightsleepduration), rem_min: minOf(d.remsleepduration), awake_min: minOf(d.wakeupduration),
    sleep_efficiency_pct: typeof d.sleep_efficiency === "number" ? round(d.sleep_efficiency * (d.sleep_efficiency <= 1 ? 100 : 1), 0) : null,
    sleep_latency_min: minOf(d.sleep_latency), waso_min: minOf(d.waso), wakeup_count: n(d.wakeupcount), out_of_bed_count: n(d.out_of_bed_count),
    sleep_score: n(d.sleep_score), hr_avg: n(d.hr_average), hr_min: n(d.hr_min), hr_max: n(d.hr_max), rr_avg: n(d.rr_average),
    snoring_min: minOf(d.snoring), snoring_episodes: n(d.snoringepisodecount),
    breathing_disturbances_intensity: n(d.breathing_disturbances_intensity), apnea_hypopnea_index: n(d.apnea_hypopnea_index),
    device_model: s.model ?? null,
  };
}
const SLEEP_FIELDS = "total_timeinbed,total_sleep_time,asleepduration,lightsleepduration,remsleepduration,deepsleepduration,sleep_efficiency,sleep_latency,wakeupduration,wakeupcount,waso,out_of_bed_count,hr_average,hr_min,hr_max,rr_average,snoring,snoringepisodecount,sleep_score,breathing_disturbances_intensity,apnea_hypopnea_index";

export function device(d) {
  const ts = (x) => (typeof x === "number" ? new Date(x * 1000).toISOString().slice(0, 10) : null);
  return { type: d.type ?? null, model: d.model ?? null, battery: d.battery ?? null, firmware: d.fw ?? null, first_session_date: ts(d.first_session_date), last_session_date: ts(d.last_session_date) };
}

// ---------- fetchers
async function measures(c, r, types) {
  // Pad by a day each side (time zones), then keep only the user's local dates inside the range.
  const startdate = Math.floor(Date.parse(addDays(r.start, -1) + "T00:00:00Z") / 1000);
  const enddate = Math.floor(Date.parse(addDays(r.end, 2) + "T00:00:00Z") / 1000);
  const { items, body } = await c.paged("/measure", { action: "getmeas", meastypes: types.join(","), category: 1, startdate, enddate }, "measuregrps");
  const tz = body.timezone || sysTz();
  return items.filter((g) => (g.category ?? 1) === 1).map((g) => decodeGroup(g, tz, types)).filter((g) => g.date >= r.start && g.date <= r.end && Object.keys(g.vals).length);
}

export const SLEEP_EMPTY_HINT = "No Withings sleep nights in this range. Withings sleep comes only from a sleep-tracking device (a sleep mat such as Sleep Analyzer, or a Withings watch with sleep tracking). Call list_devices to check that one is linked and has synced recently; if none is, this is not an error, just no sleep source in Withings. Use another source for sleep if you have one.";

// ---------- tool table
const range = (days) => ({
  start_date: { type: "string", description: `First calendar day, YYYY-MM-DD. Default: ${days - 1} days before end_date.` },
  end_date: { type: "string", description: "Last calendar day (inclusive), YYYY-MM-DD. Default: today (local)." },
});
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const units = (types) => Object.fromEntries(types.map((t) => [MEASTYPES[t][0], MEASTYPES[t][1]]));
function wrap(rows, extra = {}) { return { data_source: SOURCE, ...extra, count: rows.length, items: rows }; }

export const TOOLS = [
  {
    name: "get_body_measurements", title: "Body measurements (scale)",
    description: "Weigh-ins in a date range, one row per step-on: weight, fat ratio, fat mass, fat-free mass, muscle, hydration (water), bone, visceral fat, extra/intracellular water, BMR, metabolic age, and on cardio scales pulse wave velocity, vascular age and standing heart rate. Units decoded; metrics the scale did not measure are null. Default: last 30 days; up to 366 days.",
    inputSchema: { type: "object", properties: { ...range(30), include_manual: { type: "boolean", default: true, description: "Include entries typed in by hand in the Withings app (source: manual)." } }, additionalProperties: false },
    annotations: RO,
    async run(c, a) {
      const r = resolveRange(a, { defaultDays: 30 });
      let rows = mergeSessions(await measures(c, r, BODY_TYPES), BODY_TYPES);
      rows = rows.filter((x) => x.weight_kg != null || x.fat_ratio_pct != null || x.muscle_mass_kg != null);
      if (a.include_manual === false) rows = rows.filter((x) => x.source !== "manual");
      return wrap(rows, { range: r, units: units(BODY_TYPES) });
    },
  },
  {
    name: "get_blood_pressure", title: "Blood pressure and pulse",
    description: "Blood pressure readings (systolic, diastolic in mmHg) with pulse (bpm), from a Withings blood pressure monitor or device that measures it. Empty if you have none. Default: last 30 days; up to 366 days.",
    inputSchema: { type: "object", properties: { ...range(30) }, additionalProperties: false },
    annotations: RO,
    async run(c, a) {
      const r = resolveRange(a, { defaultDays: 30 });
      const rows = (await measures(c, r, BP_TYPES)).filter((g) => g.vals.systolic_mmhg != null || g.vals.diastolic_mmhg != null)
        .sort((x, y) => x._ts - y._ts)
        .map((g) => ({ date: g.date, time_local: g.time_local, systolic_mmhg: g.vals.systolic_mmhg ?? null, diastolic_mmhg: g.vals.diastolic_mmhg ?? null, pulse_bpm: g.vals.heart_rate_bpm ?? null, source: g.source, device_model: g.device_model }));
      return wrap(rows, { range: r, units: { systolic_mmhg: "mmHg", diastolic_mmhg: "mmHg", pulse_bpm: "bpm" } });
    },
  },
  {
    name: "get_daily_activity", title: "Daily activity",
    description: "One row per day: steps, distance, floors, soft/moderate/intense/active minutes, active and total calories, heart rate and HR-zone minutes (from a Withings watch or the app's step tracking). Default: last 7 days; up to 366 days.",
    inputSchema: { type: "object", properties: { ...range(7) }, additionalProperties: false },
    annotations: RO,
    async run(c, a) {
      const r = resolveRange(a);
      const { items } = await c.paged("/v2/measure", { action: "getactivity", startdateymd: r.start, enddateymd: r.end, data_fields: ACTIVITY_FIELDS }, "activities");
      return wrap(items.map(dayActivity).filter((x) => x.date >= r.start && x.date <= r.end).sort((x, y) => (x.date < y.date ? -1 : 1)), { range: r });
    },
  },
  {
    name: "get_sleep_summary", title: "Sleep (nightly summary)",
    description: "Nightly sleep from a Withings sleep mat or watch: total sleep, time in bed, deep/light/REM/awake minutes, efficiency, latency, wake-ups, sleep score, heart and breathing rate, snoring, breathing disturbances. A night is labelled by the day it ends. Default: last 7 days; up to 366 days. An empty result carries a hint: check list_devices for a linked sleep device.",
    inputSchema: { type: "object", properties: { ...range(7) }, additionalProperties: false },
    annotations: RO,
    async run(c, a) {
      const r = resolveRange(a);
      const { items } = await c.paged("/v2/sleep", { action: "getsummary", startdateymd: r.start, enddateymd: r.end, data_fields: SLEEP_FIELDS }, "series");
      const rows = items.map(nightSleep).filter((x) => x.date >= r.start && x.date <= r.end).sort((x, y) => (x.end_local < y.end_local ? -1 : 1));
      return wrap(rows, { range: r, ...(rows.length ? {} : { hint: SLEEP_EMPTY_HINT }) });
    },
  },
  {
    name: "list_devices", title: "Linked devices",
    description: "Withings devices linked to your account: type, model, battery level, firmware and the last time each synced (useful when data looks missing). No serial numbers or ids.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: RO,
    async run(c) { const b = await c.call("/v2/user", { action: "getdevice" }); return wrap((b.devices || []).map(device)); },
  },
  {
    name: "auth_status", title: "Setup status",
    description: "Shows whether the Withings app credentials are configured (directly or via WITHINGS_ENV_FILE) and whether you have authorized access: token file location, the scopes this plugin requests (user.info, user.metrics, user.activity) and the scopes Withings actually granted (Withings may add user.sleepevents, which is notification-only and unused), minutes left on the current access token. Never shows the secret or tokens.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(c) { const st = await c.status(); return { ...st, next_step: !st.client_configured ? (st.env_file_problem ? `${st.env_file_problem} ${SETUP_HELP}` : SETUP_HELP) : !st.authorized ? "Run start_authorization and approve access in the browser." : null }; },
  },
  {
    name: "start_authorization", title: "Authorize (one time)",
    description: "One-time setup step. Returns the Withings authorization URL for the user to open in a browser. Requests the read-only scopes " + SCOPES.join(", ") + "; Withings may also add user.sleepevents to the grant (notification-only, unused here), which auth_status lists under extra_granted_scopes. If the callback URL is on localhost, this server listens there for 10 minutes and finishes the setup by itself when the browser runs on the same computer. If the browser is on another computer, or the callback is not localhost, the user copies the full redirect URL from the address bar and passes it to exchange_code on this same server within 30 seconds. Writes only the local token file.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(c) {
      const { startAuthorization } = await import("./auth-flow.mjs");
      const { _result, ...out } = await startAuthorization(c);
      return out;
    },
  },
  {
    name: "exchange_code", title: "Finish authorization (non-localhost callback)",
    description: "Finishes the one-time authorization when the callback URL is not on localhost, or when the browser ran on a different computer than this server (the localhost redirect then fails to load in the browser, but its address still holds the code): pass the full URL from the browser's address bar (or just its code). Must be called on the same server process that ran start_authorization, within 30 seconds (Withings codes expire after 30 s and work once). Saves the tokens to the local token file (chmod 600); never returns them.",
    inputSchema: { type: "object", properties: { redirect_url_or_code: { type: "string", description: "The URL you were redirected to (contains ?code=...&state=...), or the code itself." } }, required: ["redirect_url_or_code"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(c, a) {
      const { pendingState, stopListener } = await import("./auth-flow.mjs");
      const out = await c.exchangeCode(a.redirect_url_or_code, { expectedState: pendingState() });
      stopListener();
      return out;
    },
  },
];

export { WithingsError };
