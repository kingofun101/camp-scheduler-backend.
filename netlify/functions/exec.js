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

const { getStore } = require("@netlify/blobs");

const API_TOKEN = process.env.API_TOKEN || "";

// Netlify Blobs is supposed to auto-configure itself inside a function handler,
// but this fails in production for a lot of accounts/sites (a known, long-running
// Netlify issue — see github.com/netlify/blobs/issues/175 and multiple threads on
// answers.netlify.com). The documented workaround is to pass siteID + token
// explicitly. If BLOBS_SITE_ID and BLOBS_TOKEN are set as environment variables,
// use them; otherwise fall back to automatic (in case it works fine for this site).
function store(name) {
  const siteID = process.env.BLOBS_SITE_ID;
  const token = process.env.BLOBS_TOKEN;
  if (siteID && token) {
    return getStore({ name, siteID, token });
  }
  return getStore(name);
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json",
};

function respond(body, statusCode = 200) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

function checkAuth(params, event) {
  if (!API_TOKEN) return true;
  const authHeader = (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "");
  const supplied = params.token || bearer;
  return supplied === API_TOKEN;
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

exports.handler = async (event, context) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  const params = getParams(event);
  const action = params.action;
  const camp = (params.camp || "default").toString();

  if (!checkAuth(params, event)) {
    return respond({ ok: false, error: "Invalid or missing token" }, 401);
  }

  const settingsStore = store("camp-scheduler-settings");
  const scheduleStore = store("camp-scheduler-schedules");
  const printerStore = store("camp-scheduler-printer");
  const rosterStore = store("camp-scheduler-roster");
  const preferencesStore = store("camp-scheduler-preferences");

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
        await rosterStore.set(camp, JSON.stringify(campers));
        return respond({ ok: true, count: campers.length });
      }

      // Preferences: one document per camper's intake-form submission —
      // top-3-per-period rankings, friend/same-schedule requests, swim-alt
      // opt-in. Keyed by camper_id so a resubmission (family corrects a
      // mistake) overwrites cleanly rather than piling up.
      case "loadPreferences": {
        const camperId = String(params.camper_id || "");
        if (!camperId) return respond({ ok: false, error: "missing camper_id" });
        const raw = await preferencesStore.get(`${camp}:${camperId}`);
        return respond({ ok: true, submission: raw ? JSON.parse(raw) : null });
      }
      case "savePreferences": {
        const camperId = String(params.camper_id || "");
        if (!camperId) return respond({ ok: false, error: "missing camper_id" });
        if (typeof params.data !== "string") return respond({ ok: false, error: "missing data" });
        let submission;
        try { submission = JSON.parse(params.data); } catch (e) { return respond({ ok: false, error: "bad JSON" }); }
        submission.camper_id = camperId;
        submission.submittedAt = nowISO();
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
        if (!raw) return respond({ ok: true, schedule: null });
        const parsed = JSON.parse(raw);
        return respond({ ok: true, schedule: JSON.stringify(parsed.sched || {}), slotCounts: JSON.stringify(parsed.slotCnt || {}) });
      }
      case "saveSchedule": {
        const week = String(params.week);
        if (typeof params.data !== "string") return respond({ ok: false, error: "missing data" });
        let parsed;
        try { parsed = JSON.parse(params.data); } catch (e) { return respond({ ok: false, error: "bad JSON" }); }
        const key = `${camp}:${week}`;
        await scheduleStore.set(key, JSON.stringify({ sched: parsed.sched || {}, slotCnt: parsed.slotCnt || {}, updatedAt: nowISO() }));
        return respond({ ok: true });
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
};
