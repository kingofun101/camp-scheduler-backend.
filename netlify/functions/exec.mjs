// Camp Scheduler Backend — Netlify Functions + Netlify Blobs edition.
//
// Same action-based API contract as backend/server.js (the self-hosted Express
// version) — the scheduler HTML doesn't know or care which one it's talking to.
// This version has no server to run and no database to provision: Netlify
// Blobs is a zero-config key/value store built into the platform, and it
// persists across deploys (site-scoped store), which is exactly what SQLite
// on Netlify Functions can't do (functions get a fresh, throwaway filesystem
// on every invocation).
//
// Deploy: push this folder to a Git repo and connect it on Netlify, or run
// `netlify deploy` from the CLI. No build step needed. See ../README-netlify.md.
//
// URL: this function is served at /exec (see the `config.path` export below),
// so BACKEND_URL in the scheduler HTML becomes:
//   https://your-site.netlify.app/exec

import { getStore } from "@netlify/blobs";

const API_TOKEN = process.env.API_TOKEN || ""; // set in Netlify site env vars to require a shared secret

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function checkAuth(params, req) {
  if (!API_TOKEN) return true;
  const authHeader = req.headers.get("authorization") || "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "");
  const supplied = params.token || bearer;
  return supplied === API_TOKEN;
}

async function getParams(req) {
  if (req.method === "GET") {
    const url = new URL(req.url);
    return Object.fromEntries(url.searchParams.entries());
  }
  // POST — the frontend sends URLSearchParams-encoded bodies (application/x-www-form-urlencoded)
  const contentType = req.headers.get("content-type") || "";
  const text = await req.text();
  if (contentType.includes("application/json")) {
    try { return JSON.parse(text); } catch (e) { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(text).entries());
}

function nowISO() { return new Date().toISOString(); }

export default async (req, context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const params = await getParams(req);
  const action = params.action;
  const camp = (params.camp || "default").toString();

  if (!checkAuth(params, req)) {
    return json({ ok: false, error: "Invalid or missing token" }, 401);
  }

  // Two stores: one for settings/printer-settings (simple key per camp),
  // one for weekly schedules (keyed camp:week so we can list/prefix-scan them).
  const settingsStore = getStore("camp-scheduler-settings");
  const scheduleStore = getStore("camp-scheduler-schedules");
  const printerStore = getStore("camp-scheduler-printer");

  try {
    switch (action) {
      case "loadSettings": {
        const data = await settingsStore.get(camp);
        return json({ ok: true, settings: data ?? null });
      }
      case "saveSettings": {
        if (typeof params.data !== "string") return json({ ok: false, error: "missing data" });
        await settingsStore.set(camp, params.data);
        return json({ ok: true });
      }
      case "loadSchedule": {
        const week = String(params.week);
        const key = `${camp}:${week}`;
        const raw = await scheduleStore.get(key);
        if (!raw) return json({ ok: true, schedule: null });
        const parsed = JSON.parse(raw);
        return json({ ok: true, schedule: JSON.stringify(parsed.sched || {}), slotCounts: JSON.stringify(parsed.slotCnt || {}) });
      }
      case "saveSchedule": {
        const week = String(params.week);
        if (typeof params.data !== "string") return json({ ok: false, error: "missing data" });
        let parsed;
        try { parsed = JSON.parse(params.data); } catch (e) { return json({ ok: false, error: "bad JSON" }); }
        const key = `${camp}:${week}`;
        await scheduleStore.set(key, JSON.stringify({ sched: parsed.sched || {}, slotCnt: parsed.slotCnt || {}, updatedAt: nowISO() }));
        return json({ ok: true });
      }
      case "listWeeks": {
        const { blobs } = await scheduleStore.list({ prefix: `${camp}:` });
        const weeks = [];
        for (const b of blobs) {
          const week = b.key.slice(camp.length + 1);
          weeks.push({ week });
        }
        weeks.sort((a, b) => Number(a.week) - Number(b.week));
        return json({ ok: true, weeks });
      }
      case "loadPrinterSettings": {
        const data = await printerStore.get(camp);
        return json({ ok: true, settings: data ?? null });
      }
      case "savePrinterSettings": {
        if (typeof params.data !== "string") return json({ ok: false, error: "missing data" });
        await printerStore.set(camp, params.data);
        return json({ ok: true });
      }
      default:
        return json({ ok: false, error: `Unknown action: ${action}` }, 400);
    }
  } catch (e) {
    console.error("Backend error:", e);
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};

export const config = { path: "/exec" };
