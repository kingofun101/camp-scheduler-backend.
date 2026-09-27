// Camp Scheduler Backend — Netlify Functions (classic/CommonJS format) + Netlify Blobs.
//
// Same action-based API contract as the other two backend versions. This uses
// the older exports.handler style (v1 Functions API) instead of the newer
// ESM export-default style — chosen specifically because it's the most
// universally supported format across Netlify's build pipeline, avoiding any
// edge cases around ESM/.mjs function detection.
//
// Trade-off: this format doesn't support a custom URL path via in-code config,
// so this function is only reachable at the default Netlify Functions URL:
//   https://your-site.netlify.app/.netlify/functions/exec
// (A netlify.toml redirect maps the shorter /exec to that same URL too.)

import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";

// Security model (2026-09-26):
//  - Staff/admin actions (everything except formInit + savePreferences)
//    require API_TOKEN, sent as `Authorization: Bearer <token>`. If API_TOKEN
//    isn't configured the admin actions are DISABLED, not open.
//  - Families only ever call formInit / savePreferences, and must present
//    their own camper_id + secret `key` (a random value generated when the
//    roster is saved and baked into their personal link). They can read and
//    write only their own submission.
const API_TOKEN = process.env.API_TOKEN || "";
const PUBLIC_ACTIONS = new Set(["formInit", "savePreferences", "formLookup", "formStatus"]);
const MAX_SUBMISSION_BYTES = 200 * 1024;

// Netlify Blobs auto-configures inside a current-format (v2) function, with
// no credentials to manage. (The old classic-format function needed a
// personal account token as BLOBS_TOKEN — removed 2026-09-26.)
function store(name) {
  // "strong": read-after-write must be consistent, or saveRoster could read a
  // stale roster and re-mint camper keys, silently invalidating links that
  // were already emailed to families.
  return getStore({ name, consistency: "strong" });
}

// Same-origin only: the form and dashboard are served from this site, so no
// other website has any reason to call the API from a visitor's browser.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://camp-aaron-scheduler-backend.netlify.app";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Vary": "Origin",
  "Content-Type": "application/json",
};

function respond(body, statusCode = 200) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function isAdmin(event) {
  if (!API_TOKEN) return false;
  const h = (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
  return safeEqual(h.replace(/^Bearer\s+/i, ""), API_TOKEN);
}

function getParams(event) {
  if (event.httpMethod === "GET") {
    return event.queryStringParameters || {};
  }
  const contentType = (event.headers && (event.headers["content-type"] || event.headers["Content-Type"])) || "";
  const body = event.body || "";
  if (contentType.includes("application/json")) {
    try { return JSON.parse(body); } catch (e) { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(body).entries());
}

function nowISO() { return new Date().toISOString(); }

// ---- single-link form helpers (2026-09-26) ----
// One shared link for every family: they identify their camper by first name,
// last name and birth date, which must all match the roster.
const normName = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]/g, "");
// Accepts MM/DD/YYYY, M-D-YYYY, or YYYY-MM-DD; returns YYYY-MM-DD or "".
function normDob(s) {
  const t = String(s || "").trim();
  let m = t.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/);
  let y, mo, d;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = t.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2}|\d{4})$/))) { mo = +m[1]; d = +m[2]; y = +m[3]; if (y < 100) y += y > 30 ? 1900 : 2000; }
  else return "";
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return "";
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
async function formState(settingsStore, camp) {
  const raw = await settingsStore.get(`${camp}:form`);
  const st = raw ? JSON.parse(raw) : {};
  const deadline = st.deadline || null;
  const passed = deadline ? Date.now() > Date.parse(deadline) : false;
  return { deadline, paused: !!st.paused, open: !st.paused && !passed, passed };
}
const clientIp = (event) => {
  const h = event.headers || {};
  return String(h["x-nf-client-connection-ip"] || (h["x-forwarded-for"] || "").split(",")[0] || "unknown").trim();
};

async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  const params = getParams(event);
  const action = params.action;
  const camp = (params.camp || "default").toString();

  const admin = isAdmin(event);
  if (!PUBLIC_ACTIONS.has(action) && !admin) {
    return respond({ ok: false, error: "Unauthorized" }, 401);
  }

  const settingsStore = store("camp-scheduler-settings");
  const scheduleStore = store("camp-scheduler-schedules");
  const printerStore = store("camp-scheduler-printer");
  const rosterStore = store("camp-scheduler-roster");
  const preferencesStore = store("camp-scheduler-preferences");
  const throttleStore = store("camp-scheduler-throttle");

  try {
    switch (action) {
      // Roster: the pre-loaded camper list (camper_id, name, division,
      // grade, gender) staff imports from registration before intake opens.
      // The intake form looks a camper up by id from this to know their
      // division/grade/gender (and to render a friend-search autocomplete)
      // without the family having to retype anything. One roster per camp;
      // re-saving replaces it wholesale.
      case "loadRoster": {
        const raw = await rosterStore.get(camp);
        return respond({ ok: true, roster: raw ? JSON.parse(raw) : [] });
      }
      case "saveRoster": {
        if (typeof params.data !== "string") return respond({ ok: false, error: "missing data" });
        let campers;
        try { campers = JSON.parse(params.data); } catch (e) { return respond({ ok: false, error: "bad JSON" }); }
        if (!Array.isArray(campers)) return respond({ ok: false, error: "roster must be a JSON array" });
        // Keep each camper's existing secret key across re-uploads so links
        // already sent to families keep working; mint one for new campers.
        const prevRaw = await rosterStore.get(camp);
        const prevKeys = {};
        if (prevRaw) for (const c of JSON.parse(prevRaw)) if (c.key) prevKeys[c.camper_id] = c.key;
        for (const c of campers) {
          if (c.dob != null) c.dob = normDob(c.dob);  // stored as YYYY-MM-DD
        }
        const prevDob = {};
        if (prevRaw) for (const c of JSON.parse(prevRaw)) if (c.dob) prevDob[c.camper_id] = c.dob;
        for (const c of campers) if (!c.dob && prevDob[c.camper_id]) c.dob = prevDob[c.camper_id];
        for (const c of campers) c.key = prevKeys[c.camper_id] || crypto.randomBytes(12).toString("hex");
        await rosterStore.set(camp, JSON.stringify(campers));
        return respond({ ok: true, count: campers.length });
      }

      // Is the shared family form accepting submissions? (public)
      case "formStatus": {
        const st = await formState(settingsStore, camp);
        return respond({ ok: true, open: st.open, deadline: st.deadline, paused: st.paused });
      }
      // Staff: set the submission deadline (ISO date-time or null) and/or pause.
      case "saveFormSettings": {
        const deadline = params.deadline ? new Date(params.deadline).toISOString() : null;
        await settingsStore.set(`${camp}:form`, JSON.stringify({ deadline, paused: params.paused === true || params.paused === "true" }));
        return respond({ ok: true, ...(await formState(settingsStore, camp)) });
      }
      case "loadFormSettings": {
        return respond({ ok: true, ...(await formState(settingsStore, camp)) });
      }

      // Shared-link entry: first + last name + birth date must ALL match one
      // camper; on success returns that camper's id + key so the form can use
      // the normal formInit/savePreferences. Failures are throttled per IP and
      // the message never reveals which field was wrong.
      case "formLookup": {
        const st = await formState(settingsStore, camp);
        if (!st.open) return respond({ ok: false, closed: true, error: st.paused ? "Selections are not open right now." : "The deadline for selections has passed. Please contact camp staff." });
        const tkey = `${camp}:${clientIp(event).replace(/[^0-9a-fA-F:.]/g, "_")}`;
        const traw = await throttleStore.get(tkey);
        let th = traw ? JSON.parse(traw) : { n: 0, t: Date.now() };
        if (Date.now() - th.t > 15 * 60 * 1000) th = { n: 0, t: Date.now() };
        if (th.n >= 12) return respond({ ok: false, error: "Too many attempts. Please wait 15 minutes and try again, or contact camp staff." }, 429);
        const first = normName(params.first), last = normName(params.last), dob = normDob(params.dob);
        const raw = await rosterStore.get(camp);
        const roster = raw ? JSON.parse(raw) : [];
        const hits = first && last && dob ? roster.filter((c) => c.dob && c.dob === dob && normName(c.name) === first + last) : [];
        if (hits.length !== 1) {
          th.n++; await throttleStore.set(tkey, JSON.stringify(th));
          return respond({ ok: false, error: "We couldn't find that camper. Please check the spelling of the first and last name and the birth date (MM/DD/YYYY) exactly as on the registration. If it still doesn't work, contact camp staff." }, 404);
        }
        return respond({ ok: true, camper_id: hits[0].camper_id, key: hits[0].key });
      }

      // Family entry point: authenticated by camper_id + that camper's own
      // secret key. Returns only what the form needs — their own record,
      // same-division names for the friend picker (no ids of other
      // divisions, no grades/genders/keys of anyone else), and their own
      // prior submission.
      case "formInit": {
        const camperId = String(params.camper_id || ""), key = String(params.key || "");
        const raw = await rosterStore.get(camp);
        const me = raw ? JSON.parse(raw).find((c) => c.camper_id === camperId) : null;
        if (!me || !me.key || !safeEqual(key, me.key)) return respond({ ok: false, error: "Invalid link" }, 403);
        const roster = JSON.parse(raw);
        const prior = await preferencesStore.get(`${camp}:${camperId}`);
        return respond({
          ok: true,
          camper: { camper_id: me.camper_id, name: me.name, division: me.division, grade: me.grade, gender: me.gender },
          roster: roster.filter((c) => c.division === me.division).map((c) => ({ camper_id: c.camper_id, name: c.name })),
          submission: prior ? JSON.parse(prior) : null,
        });
      }

      // Preferences: one document per camper's intake-form submission —
      // top-3-per-period rankings, friend/same-schedule requests, swim-alt
      // opt-in. Keyed by camper_id so a resubmission overwrites cleanly.
      case "loadSubmissionHistory": {  // admin
        const raw = await preferencesStore.get(`hist:${camp}:${String(params.camper_id || "")}`);
        return respond({ ok: true, history: raw ? JSON.parse(raw) : [] });
      }
      case "loadPreferences": {  // admin
        const camperId = String(params.camper_id || "");
        if (!camperId) return respond({ ok: false, error: "missing camper_id" });
        const raw = await preferencesStore.get(`${camp}:${camperId}`);
        return respond({ ok: true, submission: raw ? JSON.parse(raw) : null });
      }
      case "savePreferences": {  // public, but needs the camper's own key
        const camperId = String(params.camper_id || ""), key = String(params.key || "");
        if (typeof params.data !== "string") return respond({ ok: false, error: "missing data" });
        if (params.data.length > MAX_SUBMISSION_BYTES) return respond({ ok: false, error: "submission too large" }, 413);
        const raw = await rosterStore.get(camp);
        const roster = raw ? JSON.parse(raw) : [];
        const me = roster.find((c) => c.camper_id === camperId);
        if (!me || !me.key || !safeEqual(key, me.key)) return respond({ ok: false, error: "Invalid link" }, 403);
        const fst = await formState(settingsStore, camp);
        if (!fst.open) return respond({ ok: false, closed: true, error: fst.paused ? "Selections are not open right now." : "The deadline for selections has passed. Please contact camp staff." });
        let input;
        try { input = JSON.parse(params.data); } catch (e) { return respond({ ok: false, error: "bad JSON" }); }
        // Store only the fields the solver reads, validated against the roster.
        const sameDivision = new Set(roster.filter((c) => c.division === me.division).map((c) => c.camper_id));
        const isId = (x) => typeof x === "string" && sameDivision.has(x) && x !== camperId;
        const prefs = {};
        for (const [slot, list] of Object.entries(input.preferences || {})) {
          if (typeof slot === "string" && slot.startsWith(me.division + ":") && Array.isArray(list)) {
            prefs[slot] = [...new Set(list.filter((v) => typeof v === "string" && v.length < 100))].slice(0, 3);
          }
        }
        const submission = {
          camper_id: camperId,
          preferences: prefs,
          friend_requests: (Array.isArray(input.friend_requests) ? input.friend_requests : []).filter(isId).slice(0, 5),
          same_schedule_request: isId(input.same_schedule_request) ? input.same_schedule_request : null,
          swim_alt: input.swim_alt === true,
          submittedAt: nowISO(),
        };
        // Keep every earlier submission (newest last, max 10) so a wrong or
        // malicious overwrite can be recovered by staff.
        const prevRaw = await preferencesStore.get(`${camp}:${camperId}`);
        if (prevRaw) {
          const hkey = `hist:${camp}:${camperId}`;
          const hraw = await preferencesStore.get(hkey);
          const hist = hraw ? JSON.parse(hraw) : [];
          hist.push(JSON.parse(prevRaw));
          await preferencesStore.set(hkey, JSON.stringify(hist.slice(-10)));
        }
        await preferencesStore.set(`${camp}:${camperId}`, JSON.stringify(submission));
        return respond({ ok: true });
      }
      // Every submitted preference doc for a camp, for the solver to pull
      // directly (2026-09-24: "lands in a shared store the solver reads
      // immediately" — see core.py / netlify_data.py in camp_scheduler).
      case "listPreferences": {
        const prefix = `${camp}:`;
        const { blobs } = await preferencesStore.list({ prefix });
        const submissions = await Promise.all(blobs.map(async (b) => {
          const raw = await preferencesStore.get(b.key);
          return raw ? JSON.parse(raw) : null;
        }));
        return respond({ ok: true, submissions: submissions.filter(Boolean) });
      }
      case "loadSettings": {
        const data = await settingsStore.get(camp);
        return respond({ ok: true, settings: data ?? null });
      }
      case "saveSettings": {
        if (typeof params.data !== "string") return respond({ ok: false, error: "missing data" });
        await settingsStore.set(camp, params.data);
        return respond({ ok: true });
      }
      case "loadSchedule": {
        const week = String(params.week);
        const key = `${camp}:${week}`;
        const raw = await scheduleStore.get(key);
        if (!raw) return respond({ ok: true, schedule: null, closed: [] });
        const parsed = JSON.parse(raw);
        return respond({ ok: true, schedule: JSON.stringify(parsed.sched || {}), slotCounts: JSON.stringify(parsed.slotCnt || {}), closed: parsed.closed || [] });
      }
      case "saveSchedule": {
        const week = String(params.week);
        if (typeof params.data !== "string") return respond({ ok: false, error: "missing data" });
        let parsed;
        try { parsed = JSON.parse(params.data); } catch (e) { return respond({ ok: false, error: "bad JSON" }); }
        const key = `${camp}:${week}`;
        // `closed` = classes staff closed this week ([{day, period, base}, ...]).
        // A save that doesn't mention it (a fresh solver push, an older
        // client) keeps whatever was already closed.
        const prevRaw = await scheduleStore.get(key);
        const prevClosed = prevRaw ? (JSON.parse(prevRaw).closed || []) : [];
        const closed = Array.isArray(parsed.closed) ? parsed.closed : prevClosed;
        await scheduleStore.set(key, JSON.stringify({ sched: parsed.sched || {}, slotCnt: parsed.slotCnt || {}, closed, updatedAt: nowISO() }));
        return respond({ ok: true });
      }
      // Permanently deletes a camp's roster, submissions and schedules. Must
      // be called with confirm equal to the camp name, so it can't happen by accident.
      case "deleteCamp": {
        if (String(params.confirm || "") !== camp) return respond({ ok: false, error: "confirm must equal the camp name" }, 400);
        let n = 0;
        await rosterStore.delete(camp); n++;
        for (const [st, prefix] of [[preferencesStore, `${camp}:`], [preferencesStore, `hist:${camp}:`], [scheduleStore, `${camp}:`], [settingsStore, `${camp}:`], [throttleStore, `${camp}:`]]) {
          const { blobs } = await st.list({ prefix });
          for (const b of blobs) { await st.delete(b.key); n++; }
        }
        return respond({ ok: true, deleted: n });
      }
      // Every camp that has a roster (for the dashboard's camp switcher).
      case "listCamps": {
        const { blobs } = await rosterStore.list();
        return respond({ ok: true, camps: blobs.map((b) => b.key).sort() });
      }
      case "listWeeks": {
        const { blobs } = await scheduleStore.list({ prefix: `${camp}:` });
        const weeks = blobs.map(b => ({ week: b.key.slice(camp.length + 1) }));
        weeks.sort((a, b) => Number(a.week) - Number(b.week));
        return respond({ ok: true, weeks });
      }
      case "loadPrinterSettings": {
        const data = await printerStore.get(camp);
        return respond({ ok: true, settings: data ?? null });
      }
      case "savePrinterSettings": {
        if (typeof params.data !== "string") return respond({ ok: false, error: "missing data" });
        await printerStore.set(camp, params.data);
        return respond({ ok: true });
      }
      default:
        return respond({ ok: false, error: `Unknown action: ${action}` }, 400);
    }
  } catch (e) {
    console.error("Backend error:", e);
    return respond({ ok: false, error: String(e.message || e) }, 500);
  }
}

export default async (req) => {
  const url = new URL(req.url);
  const r = await handler({
    httpMethod: req.method,
    headers: Object.fromEntries(req.headers),
    queryStringParameters: Object.fromEntries(url.searchParams),
    body: req.method === "GET" || req.method === "OPTIONS" ? "" : await req.text(),
  });
  return new Response(r.statusCode === 204 ? null : r.body, { status: r.statusCode, headers: r.headers });
};

export const config = { path: "/exec" };
