export class ApplianceLoggerDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.initTables();
  }

  getGoldenSettings() {
    return {
      dashboard_title: "ESP32 Smart Appliance Telemetry",
      dashboard_subtitle: "Dynamic Cloud-Calibrated True-RMS Power & Session Logger",
      ac_voltage: "230",
      tariff_rate: "8.5",
      base_sensitivity: "63.00",
      noise_floor_mv: "9.50",          // Above 8.47mV idle Wi-Fi noise
      deadzone_amps: "0.25",           // Sensor deadzone
      dashboard_deadzone_amps: "0.25", // Strict Dashboard UI cutoff (below this = 0.000A & OFF)
      on_threshold_amps: "0.27",       // Turn ON only above 0.27A (Fan is ~0.33A)
      off_threshold_amps: "0.22",      // Turn OFF below 0.22A
      log_unmatched: "1",
      show_state_card: "1",
      show_current_card: "1",
      show_power_card: "1",
      show_timer_card: "1",
      show_signal_mv: "1",
      show_cost_est: "1",
      show_filters: "1",
      allow_public_clear: "0"
    };
  }

  getGoldenAppliances() {
    return [
      ["Ceiling / Table Fan", "mode_fan", 0.26, 0.55, 1.00, 1],
      ["Fridge / Air Cooler", "kitchen", 0.55, 1.80, 1.00, 1],
      ["Electric Iron (Press)", "iron", 1.80, 4.15, 1.00, 1],
      ["Iron + Fan (Combined)", "bolt", 4.15, 15.00, 1.00, 1]
    ];
  }

  initTables() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        appliance TEXT,
        icon TEXT DEFAULT 'bolt',
        event_type TEXT,
        current_a REAL,
        power_w REAL,
        date_str TEXT,
        day_str TEXT,
        time_str TEXT,
        duration_sec INTEGER,
        duration_str TEXT,
        timestamp_ms INTEGER,
        note TEXT DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS live_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state TEXT,
        appliance TEXT,
        icon TEXT DEFAULT 'bolt',
        current_a REAL,
        raw_current_a REAL DEFAULT 0,
        power_w REAL,
        signal_mv REAL,
        since_ms INTEGER,
        updated_ms INTEGER,
        esp_online INTEGER DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS appliances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        icon TEXT DEFAULT 'bolt',
        min_a REAL NOT NULL,
        max_a REAL NOT NULL,
        cal_factor REAL DEFAULT 1.0,
        log_enabled INTEGER DEFAULT 1,
        active INTEGER DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        val TEXT
      );
    `);

    try { this.sql.exec(`ALTER TABLE logs ADD COLUMN icon TEXT DEFAULT 'bolt'`); } catch (e) {}
    try { this.sql.exec(`ALTER TABLE logs ADD COLUMN note TEXT DEFAULT ''`); } catch (e) {}
    try { this.sql.exec(`ALTER TABLE live_state ADD COLUMN icon TEXT DEFAULT 'bolt'`); } catch (e) {}
    try { this.sql.exec(`ALTER TABLE live_state ADD COLUMN raw_current_a REAL DEFAULT 0`); } catch (e) {}
    try { this.sql.exec(`ALTER TABLE live_state ADD COLUMN esp_online INTEGER DEFAULT 1`); } catch (e) {}

    this.sql.exec(`INSERT OR IGNORE INTO settings (key, val) VALUES ('admin_user', 'admin')`);
    this.sql.exec(`INSERT OR IGNORE INTO settings (key, val) VALUES ('admin_pass', 'vikas@123')`);

    // Force-apply Golden Migration v3 once so stuck Mobile Charger / 0.108A state is wiped immediately!
    const mig = this.sql.exec(`SELECT val FROM settings WHERE key = 'migration_v3'`).toArray();
    if (!mig.length) {
      this.resetToGoldenDefaults(true);
      this.sql.exec(`INSERT OR REPLACE INTO settings (key, val) VALUES ('migration_v3', 'done')`);
    } else {
      const golden = this.getGoldenSettings();
      for (const [k, v] of Object.entries(golden)) {
        this.sql.exec(`INSERT OR IGNORE INTO settings (key, val) VALUES (?, ?)`, k, v);
      }
    }
  }

  resetToGoldenDefaults(resetAppliancesToo = true) {
    const golden = this.getGoldenSettings();
    for (const [k, v] of Object.entries(golden)) {
      this.sql.exec(
        `INSERT INTO settings (key, val) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET val = excluded.val`,
        k, String(v)
      );
    }
    if (resetAppliancesToo) {
      this.sql.exec(`DELETE FROM appliances`);
      for (const a of this.getGoldenAppliances()) {
        this.sql.exec(
          `INSERT INTO appliances (name, icon, min_a, max_a, cal_factor, log_enabled, active) VALUES (?, ?, ?, ?, ?, ?, 1)`,
          a[0], a[1], a[2], a[3], a[4], a[5]
        );
      }
    }
    // Immediately clear any stuck phantom ON state
    this.sql.exec(
      `UPDATE live_state SET state='OFF', appliance='None', icon='power_settings_new', current_a=0, raw_current_a=0, power_w=0, since_ms=? WHERE id=1`,
      Date.now()
    );
  }

  getSettingsObj() {
    const rows = this.sql.exec(`SELECT key, val FROM settings`).toArray();
    const obj = {};
    for (const r of rows) obj[r.key] = r.val;
    return obj;
  }

  getPublicSettings() {
    const s = this.getSettingsObj();
    delete s.admin_pass;
    return s;
  }

  getAppliances() {
    return this.sql.exec(`SELECT * FROM appliances ORDER BY min_a ASC`).toArray();
  }

  checkAuth(request) {
    const s = this.getSettingsObj();
    const u = request.headers.get("X-Admin-User") || "";
    const p = request.headers.get("X-Admin-Pass") || "";
    return (u === s.admin_user && p === s.admin_pass);
  }

  matchAppliance(rawAmps, cfg) {
    const dashDeadzone = Number(cfg.dashboard_deadzone_amps || 0.25);
    const offThresh = Number(cfg.off_threshold_amps || 0.22);
    const cutoff = Math.max(dashDeadzone, offThresh);

    if (rawAmps < cutoff) {
      return { name: "None", icon: "power_settings_new", cal_factor: 1.0, log_enabled: 0, matched: false };
    }
    const list = this.sql.exec(`SELECT * FROM appliances WHERE active = 1 ORDER BY min_a ASC`).toArray();
    for (const app of list) {
      if (rawAmps >= app.min_a && rawAmps <= app.max_a) {
        return {
          name: app.name,
          icon: app.icon || "bolt",
          cal_factor: Number(app.cal_factor || 1.0),
          log_enabled: Number(app.log_enabled),
          matched: true
        };
      }
    }
    return {
      name: `Other Load (${rawAmps.toFixed(2)}A)`,
      icon: "electrical_services",
      cal_factor: 1.0,
      log_enabled: Number(cfg.log_unmatched ?? 1),
      matched: true
    };
  }

  formatIST(ms) {
    const d = new Date(ms);
    const date_str = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric'
    }).format(d);
    const day_str = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata', weekday: 'long'
    }).format(d);
    const time_str = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
    }).format(d);
    return { date_str, day_str, time_str };
  }

  formatDuration(sec) {
    if (!sec || sec <= 0) return "< 1s";
    const hrs = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const secs = Math.floor(sec % 60);
    if (hrs > 0) return `${hrs}h ${mins}m ${secs}s`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  }

  getFullState() {
    const liveRows = this.sql.exec(`SELECT * FROM live_state WHERE id = 1`).toArray();
    const logs = this.sql.exec(`SELECT * FROM logs ORDER BY id DESC LIMIT 150`).toArray();
    return {
      type: "SYNC",
      live: liveRows.length ? liveRows[0] : null,
      logs,
      appliances: this.getAppliances(),
      settings: this.getPublicSettings(),
      server_time: Date.now()
    };
  }

  broadcast(dataObj) {
    const msg = JSON.stringify(dataObj);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch (e) {}
    }
  }

  async alarm() {
    const rows = this.sql.exec(`SELECT * FROM live_state WHERE id = 1`).toArray();
    if (!rows.length) return;
    const prev = rows[0];
    if (Date.now() - prev.updated_ms >= 9000 && prev.esp_online === 1) {
      this.sql.exec(`UPDATE live_state SET esp_online = 0 WHERE id = 1`);
      this.broadcast(this.getFullState());
    }
  }

  insertLogRow(appliance, icon, event, current_a, power_w, eventTimeMs, noteStr, knownDurationSec = 0) {
    const { date_str, day_str, time_str } = this.formatIST(eventTimeMs);
    let duration_sec = knownDurationSec;

    if (event === "OFF" && duration_sec <= 0) {
      const lastOn = this.sql.exec(
        `SELECT timestamp_ms FROM logs WHERE event_type = 'ON' ORDER BY id DESC LIMIT 1`
      ).toArray();
      if (lastOn.length > 0) {
        duration_sec = Math.max(1, Math.round((eventTimeMs - lastOn[0].timestamp_ms) / 1000));
      }
    }

    let duration_str = event === "OFF" ? this.formatDuration(duration_sec) : "Running Live...";
    if (noteStr) duration_str = `${duration_str} (${noteStr})`;

    this.sql.exec(
      `INSERT INTO logs (appliance, icon, event_type, current_a, power_w, date_str, day_str, time_str, duration_sec, duration_str, timestamp_ms, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      appliance || "Appliance",
      icon || "bolt",
      event,
      Number(current_a || 0),
      Number(power_w || 0),
      date_str,
      day_str,
      time_str,
      duration_sec,
      duration_str,
      eventTimeMs,
      noteStr || ""
    );

    if (event === "OFF") {
      const cleanDur = this.formatDuration(duration_sec);
      this.sql.exec(
        `UPDATE logs SET duration_str = 'Ran for ' || ? WHERE id = (SELECT id FROM logs WHERE event_type = 'ON' ORDER BY id DESC LIMIT 1)`,
        cleanDur
      );
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Admin-User, X-Admin-Pass",
      "Connection": "keep-alive"
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    if (url.pathname === "/api/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify(this.getFullState()));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/api/update" && request.method === "POST") {
      const body = await request.json();
      const now = Date.now();
      const cfg = this.getSettingsObj();

      const acVolt = Number(cfg.ac_voltage || 230);
      const baseSens = Number(cfg.base_sensitivity || 63.0);
      const noiseFloorMv = Number(cfg.noise_floor_mv || 9.5);
      const sensorDeadzone = Number(cfg.deadzone_amps || 0.25);
      const dashDeadzone = Number(cfg.dashboard_deadzone_amps || 0.25);
      const onThresh = Math.max(Number(cfg.on_threshold_amps || 0.27), dashDeadzone);
      const offThresh = Math.max(Number(cfg.off_threshold_amps || 0.22), dashDeadzone * 0.88);

      const {
        event,
        current_a,
        signal_mv,
        duration_sec,
        event_epoch_ms,
        is_offline_sync
      } = body;

      await this.ctx.storage.setAlarm(now + 10000);
      const effectiveTimeMs = (event_epoch_ms && event_epoch_ms > 1700000000000) ? Number(event_epoch_ms) : now;

      const sigMv = Number(signal_mv || 0);
      let rawAmps = Number(current_a || 0);

      // Server-side recalculation using latest Cloud Noise Floor if signal_mv is present
      if (sigMv > 0) {
        if (sigMv <= noiseFloorMv) {
          rawAmps = 0.0;
        } else {
          const trueMv = Math.sqrt((sigMv * sigMv) - (noiseFloorMv * noiseFloorMv));
          rawAmps = trueMv / baseSens;
        }
      }

      // Apply strict Dashboard Display Deadzone!
      const effectiveCutoff = Math.max(sensorDeadzone, dashDeadzone);
      let displayAmps = rawAmps < effectiveCutoff ? 0.0 : rawAmps;

      const matched = this.matchAppliance(displayAmps, cfg);
      const calibratedAmps = displayAmps >= effectiveCutoff ? (displayAmps * matched.cal_factor) : 0.0;
      const calibratedPower = calibratedAmps * acVolt;

      const prevRows = this.sql.exec(`SELECT * FROM live_state WHERE id = 1`).toArray();
      const prev = prevRows.length ? prevRows[0] : null;

      const currentState = (event === "OFF" || calibratedAmps < effectiveCutoff)
        ? "OFF"
        : (calibratedAmps >= onThresh ? "ON" : (prev ? prev.state : "OFF"));

      let since_ms = prev ? prev.since_ms : effectiveTimeMs;
      let logsUpdated = false;

      if (currentState === "ON" && (!prev || prev.state === "OFF")) {
        since_ms = effectiveTimeMs;
        if (matched.log_enabled === 1) {
          logsUpdated = true;
          const note = is_offline_sync ? "Synced after Net Restore" : "";
          this.insertLogRow(matched.name, matched.icon, "ON", calibratedAmps, calibratedPower, effectiveTimeMs, note, 0);
        }
      } else if (currentState === "OFF" && prev && prev.state === "ON") {
        since_ms = effectiveTimeMs;
        const prevApp = prev.appliance || "Appliance";
        const prevIcon = prev.icon || "bolt";
        const prevMatch = this.sql.exec(`SELECT log_enabled FROM appliances WHERE name = ?`, prevApp).toArray();
        const shouldLogOff = prevMatch.length ? Number(prevMatch[0].log_enabled) === 1 : false;

        if (shouldLogOff && prevApp !== "None") {
          logsUpdated = true;
          let note = is_offline_sync ? "Synced after Net Restore" : "";
          if (event === "BOOT_SYNC") note = "Auto-Closed after ESP Power Loss";
          this.insertLogRow(prevApp, prevIcon, "OFF", 0.0, 0.0, effectiveTimeMs, note, Number(duration_sec || 0));
        }
      } else if (currentState === "ON" && prev && prev.state === "ON" && matched.name !== prev.appliance && matched.name !== "None") {
        if (matched.log_enabled === 1) {
          logsUpdated = true;
          this.insertLogRow(matched.name, matched.icon, "ON", calibratedAmps, calibratedPower, now, `Switched from ${prev.appliance}`, 0);
        }
      }

      const finalAppName = currentState === "OFF" ? "None" : matched.name;
      const finalIcon = currentState === "OFF" ? "power_settings_new" : matched.icon;
      const finalCurrent = currentState === "OFF" ? 0.0 : calibratedAmps;
      const finalPower = currentState === "OFF" ? 0.0 : calibratedPower;

      this.sql.exec(
        `INSERT INTO live_state (id, state, appliance, icon, current_a, raw_current_a, power_w, signal_mv, since_ms, updated_ms, esp_online)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(id) DO UPDATE SET
           state=excluded.state,
           appliance=excluded.appliance,
           icon=excluded.icon,
           current_a=excluded.current_a,
           raw_current_a=excluded.raw_current_a,
           power_w=excluded.power_w,
           signal_mv=excluded.signal_mv,
           since_ms=excluded.since_ms,
           updated_ms=excluded.updated_ms,
           esp_online=1`,
        currentState,
        finalAppName,
        finalIcon,
        finalCurrent,
        rawAmps,
        finalPower,
        sigMv,
        since_ms,
        now
      );

      if (logsUpdated) {
        this.broadcast(this.getFullState());
      } else {
        this.broadcast({
          type: "LIVE",
          live: {
            state: currentState,
            appliance: finalAppName,
            icon: finalIcon,
            current_a: finalCurrent,
            raw_current_a: rawAmps,
            power_w: finalPower,
            signal_mv: sigMv,
            since_ms,
            updated_ms: now,
            esp_online: 1
          },
          server_time: now
        });
      }

      return new Response(
        JSON.stringify({
          ok: true,
          cfg: {
            sens: baseSens,
            noise: noiseFloorMv,
            deadzone: effectiveCutoff,
            on_a: onThresh,
            off_a: offThresh
          }
        }),
        { headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    if (url.pathname === "/api/status" && request.method === "GET") {
      return new Response(JSON.stringify(this.getFullState()), {
        headers: { ...cors, "Content-Type": "application/json" }
      });
    }

    if (url.pathname === "/api/admin/login" && request.method === "POST") {
      const { username, password } = await request.json();
      const s = this.getSettingsObj();
      if (username === s.admin_user && password === s.admin_pass) {
        return new Response(JSON.stringify({ ok: true, state: this.getFullState() }), {
          headers: { ...cors, "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ ok: false, error: "Invalid Admin Username or Password" }), {
        status: 401,
        headers: { ...cors, "Content-Type": "application/json" }
      });
    }

    if (url.pathname.startsWith("/api/admin/")) {
      if (!this.checkAuth(request)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...cors, "Content-Type": "application/json" }
        });
      }

      if (url.pathname === "/api/admin/reset-defaults" && request.method === "POST") {
        const body = await request.json();
        this.resetToGoldenDefaults(body.reset_appliances !== false);
        const st = this.getFullState();
        this.broadcast(st);
        return new Response(JSON.stringify({ ok: true, state: st }), {
          headers: { ...cors, "Content-Type": "application/json" }
        });
      }

      if (url.pathname === "/api/admin/appliance" && request.method === "POST") {
        const b = await request.json();
        if (b.id) {
          this.sql.exec(
            `UPDATE appliances SET name=?, icon=?, min_a=?, max_a=?, cal_factor=?, log_enabled=?, active=? WHERE id=?`,
            b.name, b.icon || "bolt", Number(b.min_a), Number(b.max_a), Number(b.cal_factor || 1.0), b.log_enabled ? 1 : 0, b.active ? 1 : 0, Number(b.id)
          );
        } else {
          this.sql.exec(
            `INSERT INTO appliances (name, icon, min_a, max_a, cal_factor, log_enabled, active) VALUES (?, ?, ?, ?, ?, ?, 1)`,
            b.name, b.icon || "bolt", Number(b.min_a), Number(b.max_a), Number(b.cal_factor || 1.0), b.log_enabled ? 1 : 0
          );
        }
        const st = this.getFullState();
        this.broadcast(st);
        return new Response(JSON.stringify({ ok: true, state: st }), {
          headers: { ...cors, "Content-Type": "application/json" }
        });
      }

      if (url.pathname === "/api/admin/appliance" && request.method === "DELETE") {
        const id = Number(url.searchParams.get("id"));
        this.sql.exec(`DELETE FROM appliances WHERE id = ?`, id);
        const st = this.getFullState();
        this.broadcast(st);
        return new Response(JSON.stringify({ ok: true, state: st }), {
          headers: { ...cors, "Content-Type": "application/json" }
        });
      }

      if (url.pathname === "/api/admin/settings" && request.method === "POST") {
        const body = await request.json();
        for (const [k, v] of Object.entries(body)) {
          if (k === "admin_pass" && (!v || String(v).trim() === "")) continue;
          this.sql.exec(
            `INSERT INTO settings (key, val) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET val = excluded.val`,
            k, String(v)
          );
        }
        // Immediately enforce new dashboard deadzone on live_state if currently below threshold
        const dashDead = Number(body.dashboard_deadzone_amps || 0.25);
        this.sql.exec(
          `UPDATE live_state SET state='OFF', appliance='None', icon='power_settings_new', current_a=0, power_w=0 WHERE id=1 AND raw_current_a < ?`,
          dashDead
        );
        const st = this.getFullState();
        this.broadcast(st);
        return new Response(JSON.stringify({ ok: true, state: st }), {
          headers: { ...cors, "Content-Type": "application/json" }
        });
      }
    }

    if (url.pathname === "/api/clear" && request.method === "DELETE") {
      const s = this.getSettingsObj();
      if (s.allow_public_clear !== "1" && !this.checkAuth(request)) {
        return new Response(JSON.stringify({ error: "Admin login required to clear logs" }), {
          status: 403,
          headers: { ...cors, "Content-Type": "application/json" }
        });
      }
      this.sql.exec(`DELETE FROM logs`);
      this.broadcast(this.getFullState());
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...cors, "Content-Type": "application/json" }
      });
    }

    return new Response("Not Found", { status: 404 });
  }

  async webSocketMessage(ws, message) {
    if (message === "PING") ws.send("PONG");
  }
  async webSocketClose(ws) { ws.close(); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const id = env.LOGGER_DO.idFromName("GLOBAL_APPLIANCE_LOGGER");
      const stub = env.LOGGER_DO.get(id);
      return stub.fetch(request);
    }
    return new Response(HTML_UI, {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
};

const HTML_UI = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Smart Appliance Telemetry & Admin Studio</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@24,500,1,0" rel="stylesheet" />
  <style>
    :root {
      --bg: #0b0f19;
      --surface: #131b2e;
      --surface-2: #1c2742;
      --border: rgba(255, 255, 255, 0.09);
      --primary: #6366f1;
      --primary-soft: rgba(99, 102, 241, 0.16);
      --success: #10b981;
      --success-soft: rgba(16, 185, 129, 0.16);
      --danger: #f43f5e;
      --danger-soft: rgba(244, 63, 94, 0.16);
      --warn: #f59e0b;
      --warn-soft: rgba(245, 158, 11, 0.18);
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --radius-lg: 22px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Plus Jakarta Sans', sans-serif;
      background: radial-gradient(circle at top right, #1e1b4b, var(--bg) 55%);
      color: var(--text);
      min-height: 100vh;
      padding: 18px;
    }
    .container { max-width: 1240px; margin: 0 auto; }

    .header {
      display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 14px;
      padding: 16px 22px; background: rgba(19, 27, 46, 0.88); backdrop-filter: blur(16px);
      border: 1px solid var(--border); border-radius: var(--radius-lg); margin-bottom: 18px;
    }
    .brand { display: flex; align-items: center; gap: 14px; }
    .brand-icon {
      width: 46px; height: 46px; border-radius: 14px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      display: grid; place-items: center; box-shadow: 0 8px 20px rgba(99, 102, 241, 0.35);
    }
    .brand h1 { font-size: 1.2rem; font-weight: 800; }
    .brand p { font-size: 0.8rem; color: var(--text-muted); }
    .header-right { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }

    .conn-pill {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 8px 14px; border-radius: 999px; font-size: 0.8rem; font-weight: 700;
      background: var(--surface-2); border: 1px solid var(--border);
    }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--danger); }
    .dot.online { background: var(--success); box-shadow: 0 0 12px var(--success); animation: pulse 1.2s infinite; }
    @keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.3); opacity: 0.7; } }

    .btn-admin {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 8px 16px; border-radius: 999px; font-size: 0.82rem; font-weight: 700;
      background: var(--primary-soft); color: #a5b4fc; border: 1px solid rgba(99, 102, 241, 0.35);
      cursor: pointer; transition: all 0.2s;
    }
    .btn-admin:hover, .btn-admin.active { background: var(--primary); color: white; }

    .offline-banner {
      display: none; align-items: center; gap: 12px;
      padding: 13px 18px; border-radius: 16px; margin-bottom: 18px;
      background: var(--warn-soft); border: 1px solid rgba(245, 158, 11, 0.45); color: #fcd34d;
      font-size: 0.88rem; font-weight: 600;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 16px;
      margin-bottom: 22px;
    }
    .card {
      background: rgba(19, 27, 46, 0.88); border: 1px solid var(--border);
      border-radius: var(--radius-lg); padding: 20px; transition: all 0.15s ease;
    }
    .card-head { display: flex; justify-content: space-between; align-items: center; color: var(--text-muted); font-size: 0.78rem; font-weight: 700; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
    .card-value { font-family: 'JetBrains Mono', monospace; font-size: 1.85rem; font-weight: 700; margin-bottom: 6px; }
    .card-sub { font-size: 0.8rem; color: var(--text-muted); }
    .state-on {
      background: linear-gradient(135deg, rgba(16, 185, 129, 0.22), rgba(19, 27, 46, 0.92));
      border-color: rgba(16, 185, 129, 0.5);
    }

    .toolbar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
    .chips { display: flex; gap: 8px; flex-wrap: wrap; }
    .chip {
      padding: 7px 15px; border-radius: 999px; font-size: 0.82rem; font-weight: 600;
      cursor: pointer; border: 1px solid var(--border); background: var(--surface); color: var(--text-muted);
    }
    .chip.active { background: var(--primary); color: white; border-color: var(--primary); }
    .btn-danger {
      display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 12px;
      border: 1px solid rgba(244, 63, 94, 0.3); background: var(--danger-soft); color: #fda4af; font-size: 0.82rem; font-weight: 600; cursor: pointer;
    }

    .table-card { background: rgba(19, 27, 46, 0.88); border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; }
    .table-wrap { width: 100%; overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; text-align: left; }
    th { padding: 15px 18px; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); background: rgba(28, 39, 66, 0.5); border-bottom: 1px solid var(--border); }
    td { padding: 14px 18px; font-size: 0.9rem; border-bottom: 1px solid var(--border); }
    .badge { display: inline-flex; align-items: center; gap: 5px; padding: 4px 11px; border-radius: 999px; font-size: 0.76rem; font-weight: 700; }
    .badge-on { background: var(--success-soft); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }
    .badge-off { background: var(--danger-soft); color: #fb7185; border: 1px solid rgba(244, 63, 94, 0.3); }
    .app-tag { display: inline-flex; align-items: center; gap: 7px; font-weight: 700; }
    .mono { font-family: 'JetBrains Mono', monospace; font-weight: 600; }
    .duration-pill { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border-radius: 8px; background: var(--primary-soft); color: #a5b4fc; font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; font-weight: 600; }
    .empty-state { padding: 42px 20px; text-align: center; color: var(--text-muted); }

    #adminSection { display: none; margin-top: 10px; }
    .admin-grid { display: grid; grid-template-columns: 1.35fr 1fr; gap: 18px; margin-bottom: 24px; }
    .panel-title { font-size: 1.05rem; font-weight: 800; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
    .form-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
    .field { display: flex; flex-direction: column; gap: 5px; }
    .field label { font-size: 0.75rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase; }
    .field input, .field select {
      padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border);
      background: #0b0f19; color: white; font-size: 0.88rem; outline: none;
    }
    .field input:focus, .field select:focus { border-color: var(--primary); }
    .btn-primary {
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      padding: 11px 18px; border-radius: 12px; border: none; cursor: pointer;
      background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; font-weight: 700; font-size: 0.88rem;
    }
    .btn-golden {
      display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      padding: 12px 18px; border-radius: 12px; cursor: pointer; width: 100%;
      background: linear-gradient(135deg, rgba(245, 158, 11, 0.25), rgba(16, 185, 129, 0.25));
      border: 1px solid rgba(245, 158, 11, 0.5); color: #fde68a; font-weight: 800; font-size: 0.88rem;
      margin-bottom: 16px; transition: all 0.2s;
    }
    .btn-golden:hover {
      background: linear-gradient(135deg, rgba(245, 158, 11, 0.4), rgba(16, 185, 129, 0.4));
    }
    .toggle-row {
      display: flex; justify-content: space-between; align-items: center;
      padding: 10px 14px; border-radius: 12px; background: rgba(28, 39, 66, 0.45);
      border: 1px solid var(--border); margin-bottom: 8px; font-size: 0.88rem; font-weight: 600;
    }
    .toggle-row input[type="checkbox"] { width: 18px; height: 18px; accent-color: var(--primary); cursor: pointer; }

    .app-item {
      display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;
      padding: 12px 14px; border-radius: 14px; background: rgba(28, 39, 66, 0.5);
      border: 1px solid var(--border); margin-bottom: 10px;
    }
    .app-meta { font-size: 0.78rem; color: var(--text-muted); font-family: 'JetBrains Mono', monospace; margin-top: 3px; }
    .icon-btn {
      padding: 6px 10px; border-radius: 8px; border: 1px solid var(--border);
      background: var(--surface); color: var(--text); cursor: pointer; font-size: 0.78rem; font-weight: 600;
    }

    .modal-backdrop {
      position: fixed; inset: 0; background: rgba(0, 0, 0, 0.7); backdrop-filter: blur(6px);
      display: none; place-items: center; z-index: 100; padding: 16px;
    }
    .modal {
      background: var(--surface); border: 1px solid var(--border); border-radius: 22px;
      padding: 26px; width: 100%; max-width: 400px;
    }
    .toast {
      position: fixed; bottom: 20px; right: 20px; padding: 12px 20px; border-radius: 12px;
      background: var(--success); color: #052e16; font-weight: 800; display: none; z-index: 200;
    }

    @media (max-width: 960px) { .admin-grid { grid-template-columns: 1fr; } }
    @media (max-width: 640px) {
      body { padding: 12px; }
      .form-grid { grid-template-columns: 1fr; }
      thead { display: none; }
      table, tbody, tr, td { display: block; width: 100%; }
      tr { padding: 14px; border-bottom: 1px solid var(--border); }
      td { padding: 5px 0; border: none; display: flex; justify-content: space-between; align-items: center; }
      td::before { content: attr(data-label); color: var(--text-muted); font-size: 0.75rem; font-weight: 700; text-transform: uppercase; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="header">
      <div class="brand">
        <div class="brand-icon"><span class="material-symbols-rounded" style="color:white;font-size:26px;">bolt</span></div>
        <div>
          <h1 id="uiTitle">ESP32 Smart Appliance Telemetry</h1>
          <p id="uiSubtitle">Dynamic Cloud-Calibrated True-RMS Power & Session Logger</p>
        </div>
      </div>
      <div class="header-right">
        <div class="conn-pill">
          <span id="connDot" class="dot"></span>
          <span id="connText">Connecting...</span>
        </div>
        <button id="adminBtn" class="btn-admin" onclick="toggleAdminView()">
          <span class="material-symbols-rounded" style="font-size:18px;">admin_panel_settings</span>
          <span id="adminBtnText">Admin Studio</span>
        </button>
      </div>
    </header>

    <div id="offlineBanner" class="offline-banner">
      <span class="material-symbols-rounded">warning</span>
      <span>ESP32 Power or Internet Lost! Offline events will auto-sync on reconnection.</span>
    </div>

    <!-- MAIN PUBLIC DASHBOARD VIEW -->
    <div id="dashboardSection">
      <section class="grid">
        <div id="cardStateWrap" class="card">
          <div class="card-head"><span>CURRENT STATE</span><span id="liveIcon" class="material-symbols-rounded">power_settings_new</span></div>
          <div id="liveState" class="card-value">OFF</div>
          <div id="liveAppliance" class="card-sub">Detected: None</div>
        </div>
        <div id="cardCurrentWrap" class="card">
          <div class="card-head"><span>LIVE CURRENT (RMS)</span><span class="material-symbols-rounded">electric_meter</span></div>
          <div id="liveCurrent" class="card-value">0.000 A</div>
          <div id="liveSignal" class="card-sub">ADC Signal: 0.00 mV</div>
        </div>
        <div id="cardPowerWrap" class="card">
          <div class="card-head"><span>ACTIVE POWER</span><span class="material-symbols-rounded">speed</span></div>
          <div id="livePower" class="card-value">0.0 W</div>
          <div id="liveCost" class="card-sub">Est. Cost: ₹0.00 / hr</div>
        </div>
        <div id="cardTimerWrap" class="card">
          <div class="card-head"><span>ACTIVE SESSION TIMER</span><span class="material-symbols-rounded">timer</span></div>
          <div id="liveTimer" class="card-value">00:00</div>
          <div id="liveSince" class="card-sub">Idle</div>
        </div>
      </section>

      <div class="toolbar">
        <div id="filterChipsWrap" class="chips"></div>
        <button id="clearBtnWrap" class="btn-danger" onclick="clearLogs()">
          <span class="material-symbols-rounded" style="font-size:18px;">delete</span> Clear History
        </button>
      </div>

      <div class="table-card">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>State</th>
                <th>Appliance</th>
                <th>Sensor Reading</th>
                <th>Date & Day</th>
                <th>Exact Time (IST)</th>
                <th>ON Duration / Status</th>
              </tr>
            </thead>
            <tbody id="logBody">
              <tr><td colspan="6" class="empty-state">Waiting for telemetry...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- PROTECTED ADMIN STUDIO VIEW -->
    <div id="adminSection">
      <button class="btn-golden" onclick="resetToGoldenDefaults()">
        <span class="material-symbols-rounded">restart_alt</span>
        <span>Reset to Tested Working Calibration (63.00 mV/A • 9.5mV Noise Floor • 0.25A Dashboard Deadzone • Fan & Iron Defaults)</span>
      </button>

      <div class="admin-grid">
        <!-- Left Column: Appliance Manager -->
        <div class="card">
          <div class="panel-title">
            <span>🔌 Dynamic Appliance Profiles (≥ 0.25A)</span>
            <button class="icon-btn" onclick="resetApplianceForm()">+ New Profile</button>
          </div>

          <div style="padding:12px 14px;border-radius:12px;background:var(--primary-soft);border:1px solid rgba(99,102,241,0.3);margin-bottom:14px;font-size:0.84rem;">
            📡 <strong>Raw Sensor Preview (Before Deadzone):</strong>
            <span id="adminLiveRaw" class="mono" style="color:#34d399;font-size:1rem;">0.000 A</span>
            (<span id="adminLiveMv" class="mono">0.00 mV</span>)
            <div style="color:var(--text-muted);font-size:0.76rem;margin-top:3px;">
              Anything below the <strong>Dashboard Display Deadzone (0.25A)</strong> is forced to <strong>0.000 A & OFF</strong> on the public dashboard.
            </div>
          </div>

          <form id="appForm" onsubmit="saveAppliance(event)" style="background:rgba(11,15,25,0.6);padding:14px;border-radius:14px;border:1px solid var(--border);margin-bottom:16px;">
            <input type="hidden" id="appId" value="">
            <div class="form-grid">
              <div class="field">
                <label>Appliance Name</label>
                <input type="text" id="appName" placeholder="e.g. Ceiling Fan / Cooler" required>
              </div>
              <div class="field">
                <label>Material Icon</label>
                <select id="appIcon">
                  <option value="iron">Iron (iron)</option>
                  <option value="mode_fan">Fan (mode_fan)</option>
                  <option value="kitchen">Fridge (kitchen)</option>
                  <option value="ac_unit">Cooler / AC (ac_unit)</option>
                  <option value="water_heater">Geyser / Heater (water_heater)</option>
                  <option value="tv">TV / Monitor (tv)</option>
                  <option value="laptop_mac">PC / Desktop (laptop_mac)</option>
                  <option value="bolt">General Load (bolt)</option>
                </select>
              </div>
              <div class="field">
                <label>Min Current (Amps)</label>
                <input type="number" step="0.01" id="appMin" placeholder="0.26" required>
              </div>
              <div class="field">
                <label>Max Current (Amps)</label>
                <input type="number" step="0.01" id="appMax" placeholder="0.55" required>
              </div>
              <div class="field">
                <label>Calibration Multiplier (1.00 = Exact)</label>
                <input type="number" step="0.01" id="appCal" value="1.00" required>
              </div>
              <div class="field">
                <label>Record in History Logs?</label>
                <select id="appLog">
                  <option value="1">✅ Yes - Log ON & OFF Events</option>
                  <option value="0">🚫 No - Show Live Only (Do Not Log)</option>
                </select>
              </div>
            </div>
            <button type="submit" class="btn-primary" style="width:100%;margin-top:12px;">
              <span class="material-symbols-rounded" style="font-size:18px;">save</span>
              <span id="appSubmitText">Save Appliance Profile</span>
            </button>
          </form>

          <div id="applianceList"></div>
        </div>

        <!-- Right Column: Sensor Calibration + Dashboard UI Controls -->
        <div style="display:flex;flex-direction:column;gap:18px;">
          <div class="card">
            <div class="panel-title"><span>🎛️ Dashboard Deadzone & Sensor Calibration</span></div>
            <form onsubmit="saveGlobalSettings(event)">
              <div class="form-grid">
                <div class="field" style="grid-column: 1 / -1; background: rgba(16, 185, 129, 0.12); padding: 10px 12px; border-radius: 12px; border: 1px solid rgba(16, 185, 129, 0.35);">
                  <label style="color:#34d399;">🛡️ Dashboard Display Deadzone (Amps) — Cutoff below this = 0.000A & OFF</label>
                  <input type="number" step="0.01" id="cfgDashDeadzone" required>
                </div>
                <div class="field">
                  <label>ACS712 Base Sensitivity (mV/A)</label>
                  <input type="number" step="0.01" id="cfgSens" required>
                </div>
                <div class="field">
                  <label>Zero-Load Noise Floor (mV)</label>
                  <input type="number" step="0.1" id="cfgNoise" required>
                </div>
                <div class="field">
                  <label>ESP32 Hardware Deadzone (Amps)</label>
                  <input type="number" step="0.01" id="cfgDeadzone" required>
                </div>
                <div class="field">
                  <label>Turn-ON Threshold (Amps)</label>
                  <input type="number" step="0.01" id="cfgOnA" required>
                </div>
                <div class="field">
                  <label>Turn-OFF Threshold (Amps)</label>
                  <input type="number" step="0.01" id="cfgOffA" required>
                </div>
                <div class="field">
                  <label>Nominal AC Voltage (V)</label>
                  <input type="number" step="1" id="cfgVolt" required>
                </div>
                <div class="field">
                  <label>Electricity Tariff (₹ / kWh)</label>
                  <input type="number" step="0.1" id="cfgTariff" required>
                </div>
                <div class="field">
                  <label>Log Unmatched Loads?</label>
                  <select id="cfgUnmatched">
                    <option value="1">Yes (Log as Other Load)</option>
                    <option value="0">No (Ignore Unmatched Loads)</option>
                  </select>
                </div>
              </div>

              <div class="panel-title" style="margin-top:20px;"><span>👁️ Dashboard Visibility & Branding</span></div>
              <div class="form-grid" style="margin-bottom:12px;">
                <div class="field">
                  <label>Dashboard Heading</label>
                  <input type="text" id="cfgTitle" required>
                </div>
                <div class="field">
                  <label>Dashboard Subtitle</label>
                  <input type="text" id="cfgSub" required>
                </div>
              </div>

              <div class="toggle-row"><span>Show Current State Card</span><input type="checkbox" id="visState"></div>
              <div class="toggle-row"><span>Show Live Current (Amps) Card</span><input type="checkbox" id="visCurrent"></div>
              <div class="toggle-row"><span>Show Active Power (Watts) Card</span><input type="checkbox" id="visPower"></div>
              <div class="toggle-row"><span>Show Active Session Timer Card</span><input type="checkbox" id="visTimer"></div>
              <div class="toggle-row"><span>Show ADC Signal (mV) Subtext</span><input type="checkbox" id="visSignal"></div>
              <div class="toggle-row"><span>Show Estimated Cost (₹/hr) Subtext</span><input type="checkbox" id="visCost"></div>
              <div class="toggle-row"><span>Show Category Filter Chips</span><input type="checkbox" id="visFilters"></div>
              <div class="toggle-row"><span>Allow Public Clear History (Without Login)</span><input type="checkbox" id="visClear"></div>

              <div class="panel-title" style="margin-top:20px;"><span>🔐 Admin Credentials</span></div>
              <div class="form-grid">
                <div class="field">
                  <label>Admin Username</label>
                  <input type="text" id="cfgAdminUser" required>
                </div>
                <div class="field">
                  <label>New Password (leave blank to keep)</label>
                  <input type="password" id="cfgAdminPass" placeholder="••••••••">
                </div>
              </div>

              <button type="submit" class="btn-primary" style="width:100%;margin-top:14px;">
                💾 Save All Calibration & UI Settings
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Admin Login Modal -->
  <div id="loginModal" class="modal-backdrop">
    <div class="modal">
      <div class="panel-title">
        <span>🔐 Admin Studio Login</span>
        <button class="icon-btn" onclick="closeLoginModal()">✕</button>
      </div>
      <form onsubmit="submitLogin(event)">
        <div class="field" style="margin-bottom:12px;">
          <label>Username</label>
          <input type="text" id="loginUser" value="admin" required>
        </div>
        <div class="field" style="margin-bottom:16px;">
          <label>Password</label>
          <input type="password" id="loginPass" placeholder="Enter password" required>
        </div>
        <button type="submit" class="btn-primary" style="width:100%;">Unlock Admin Studio</button>
      </form>
    </div>
  </div>

  <div id="toast" class="toast">Saved!</div>

  <script>
    let allLogs = [];
    let appliances = [];
    let settings = {};
    let liveData = null;
    let currentFilter = 'ALL';
    let isAdminView = false;
    let adminCreds = {
      user: sessionStorage.getItem('adm_u') || '',
      pass: sessionStorage.getItem('adm_p') || ''
    };

    function showToast(msg) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.style.display = 'block';
      setTimeout(() => t.style.display = 'none', 3500);
    }

    function formatClock(sec) {
      if (sec < 0) sec = 0;
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = Math.floor(sec % 60);
      const pad = n => String(n).padStart(2, '0');
      return h > 0 ? \`\${pad(h)}:\${pad(m)}:\${pad(s)}\` : \`\${pad(m)}:\${pad(s)}\`;
    }

    function applySettingsUI() {
      if (!settings) return;
      document.getElementById('uiTitle').textContent = settings.dashboard_title || 'ESP32 Smart Appliance Telemetry';
      document.getElementById('uiSubtitle').textContent = settings.dashboard_subtitle || '';

      document.getElementById('cardStateWrap').style.display = settings.show_state_card === '0' ? 'none' : 'block';
      document.getElementById('cardCurrentWrap').style.display = settings.show_current_card === '0' ? 'none' : 'block';
      document.getElementById('cardPowerWrap').style.display = settings.show_power_card === '0' ? 'none' : 'block';
      document.getElementById('cardTimerWrap').style.display = settings.show_timer_card === '0' ? 'none' : 'block';
      document.getElementById('liveSignal').style.display = settings.show_signal_mv === '0' ? 'none' : 'block';
      document.getElementById('liveCost').style.display = settings.show_cost_est === '0' ? 'none' : 'block';
      document.getElementById('filterChipsWrap').style.display = settings.show_filters === '0' ? 'none' : 'flex';
      document.getElementById('clearBtnWrap').style.display = (settings.allow_public_clear === '1' || adminCreds.pass) ? 'inline-flex' : 'none';

      const chipContainer = document.getElementById('filterChipsWrap');
      const baseChips = [
        { key: 'ALL', label: 'All Events' },
        ...appliances.map(a => ({ key: a.name, label: a.name })),
        { key: 'ON', label: 'ON Logs' },
        { key: 'OFF', label: 'OFF Logs' }
      ];
      chipContainer.innerHTML = baseChips.map(c => \`
        <button class="chip \${currentFilter === c.key ? 'active' : ''}" onclick="setFilter('\${c.key.replace(/'/g, "\\\\'")}')">\${c.label}</button>
      \`).join('');
    }

    function setFilter(f) {
      currentFilter = f;
      applySettingsUI();
      renderLogs();
    }

    function updateLiveUI(live) {
      if (!live) return;
      liveData = live;

      // Client-side enforcement of Dashboard Display Deadzone as a second layer of protection!
      const dashDeadzone = Number(settings.dashboard_deadzone_amps || 0.25);
      const rawCurr = Number(live.current_a || 0);
      const isTrulyOn = (live.state === 'ON') && (rawCurr >= dashDeadzone);

      const shownCurr = isTrulyOn ? rawCurr : 0.0;
      const shownPower = isTrulyOn ? Number(live.power_w || 0) : 0.0;
      const shownState = isTrulyOn ? 'ON' : 'OFF';
      const shownApp = isTrulyOn ? (live.appliance || 'Appliance') : 'None';
      const shownIcon = isTrulyOn ? (live.icon || 'bolt') : 'power_settings_new';

      const espOnline = live.esp_online === 1 && (Date.now() - live.updated_ms < 12000);

      document.getElementById('cardStateWrap').className = 'card ' + (isTrulyOn ? 'state-on' : '');
      document.getElementById('liveState').textContent = shownState;
      document.getElementById('liveState').style.color = isTrulyOn ? '#34d399' : '#f8fafc';
      document.getElementById('liveIcon').textContent = shownIcon;
      document.getElementById('liveAppliance').textContent = 'Detected: ' + shownApp;
      document.getElementById('liveCurrent').textContent = shownCurr.toFixed(3) + ' A';
      document.getElementById('liveSignal').textContent = 'ADC Signal: ' + Number(live.signal_mv).toFixed(2) + ' mV (Cutoff: ' + dashDeadzone.toFixed(2) + 'A)';
      document.getElementById('livePower').textContent = shownPower.toFixed(1) + ' W';

      const rate = Number(settings.tariff_rate || 8.5);
      const costPerHr = (shownPower / 1000) * rate;
      document.getElementById('liveCost').textContent = \`Est. Cost: ₹\${costPerHr.toFixed(2)} / hr (@ ₹\${rate}/kWh)\`;

      const rawEl = document.getElementById('adminLiveRaw');
      if (rawEl) {
        rawEl.textContent = Number(live.raw_current_a ?? live.current_a).toFixed(3) + ' A';
        document.getElementById('adminLiveMv').textContent = Number(live.signal_mv).toFixed(2) + ' mV';
      }

      const dot = document.getElementById('connDot');
      const txt = document.getElementById('connText');
      const banner = document.getElementById('offlineBanner');

      if (espOnline) {
        dot.className = 'dot online';
        txt.textContent = 'ESP32 Live';
        banner.style.display = 'none';
        document.getElementById('liveSince').textContent = isTrulyOn ? 'Streaming Live (1s rate)' : 'Idle (Below ' + dashDeadzone.toFixed(2) + 'A Deadzone)';
      } else {
        dot.className = 'dot';
        txt.textContent = 'ESP32 Offline';
        banner.style.display = 'flex';
        document.getElementById('liveSince').textContent = isTrulyOn ? '⚠️ Last state: ON (ESP Offline)' : 'ESP32 Offline';
      }

      if (!isTrulyOn) {
        document.getElementById('liveTimer').textContent = '00:00';
      }
    }

    function renderLogs() {
      const tbody = document.getElementById('logBody');
      const filtered = allLogs.filter(item => {
        if (currentFilter === 'ALL') return true;
        if (currentFilter === 'ON' || currentFilter === 'OFF') return item.event_type === currentFilter;
        return item.appliance === currentFilter || item.appliance.includes(currentFilter);
      });

      if (!filtered.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No matching ON/OFF events recorded yet.</td></tr>';
        return;
      }

      tbody.innerHTML = filtered.map(row => {
        const isOn = row.event_type === 'ON';
        const icon = row.icon || (row.appliance.includes('Iron') ? 'iron' : (row.appliance.includes('Fan') ? 'mode_fan' : 'bolt'));
        return \`
          <tr>
            <td data-label="State">
              <span class="badge \${isOn ? 'badge-on' : 'badge-off'}">
                <span class="material-symbols-rounded" style="font-size:16px;">\${isOn ? 'flash_on' : 'power_off'}</span>
                \${row.event_type}
              </span>
            </td>
            <td data-label="Appliance">
              <span class="app-tag">
                <span class="material-symbols-rounded" style="color:#818cf8;font-size:20px;">\${icon}</span>
                \${row.appliance}
              </span>
            </td>
            <td data-label="Sensor Reading" class="mono">
              \${Number(row.current_a).toFixed(3)} A <span style="color:var(--text-muted);font-size:0.8rem;">(\${Number(row.power_w).toFixed(0)} W)</span>
            </td>
            <td data-label="Date & Day">
              <strong>\${row.date_str}</strong> <span style="color:var(--text-muted);">• \${row.day_str}</span>
            </td>
            <td data-label="Exact Time" class="mono">\${row.time_str}</td>
            <td data-label="ON Duration">
              <span class="duration-pill">
                <span class="material-symbols-rounded" style="font-size:15px;">schedule</span>
                \${row.duration_str || '-'}
              </span>
            </td>
          </tr>
        \`;
      }).join('');
    }

    function toggleAdminView() {
      if (isAdminView) {
        isAdminView = false;
        document.getElementById('adminSection').style.display = 'none';
        document.getElementById('dashboardSection').style.display = 'block';
        document.getElementById('adminBtn').classList.remove('active');
        document.getElementById('adminBtnText').textContent = 'Admin Studio';
        return;
      }
      if (!adminCreds.pass) {
        document.getElementById('loginModal').style.display = 'grid';
      } else {
        openAdminPanel();
      }
    }

    function closeLoginModal() {
      document.getElementById('loginModal').style.display = 'none';
    }

    async function submitLogin(e) {
      e.preventDefault();
      const username = document.getElementById('loginUser').value.trim();
      const password = document.getElementById('loginPass').value;
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        adminCreds = { user: username, pass: password };
        sessionStorage.setItem('adm_u', username);
        sessionStorage.setItem('adm_p', password);
        closeLoginModal();
        openAdminPanel();
        showToast('Welcome to Admin Studio!');
      } else {
        alert(data.error || 'Invalid credentials!');
      }
    }

    function openAdminPanel() {
      isAdminView = true;
      document.getElementById('dashboardSection').style.display = 'none';
      document.getElementById('adminSection').style.display = 'block';
      document.getElementById('adminBtn').classList.add('active');
      document.getElementById('adminBtnText').textContent = '← Back to Live Dashboard';
      populateAdminForms();
    }

    function populateAdminForms() {
      const box = document.getElementById('applianceList');
      box.innerHTML = appliances.map(a => \`
        <div class="app-item">
          <div>
            <div style="display:flex;align-items:center;gap:8px;font-weight:700;">
              <span class="material-symbols-rounded" style="color:#818cf8;">\${a.icon}</span>
              <span>\${a.name}</span>
              <span class="badge \${a.log_enabled ? 'badge-on' : 'badge-off'}" style="font-size:0.68rem;padding:2px 8px;">
                \${a.log_enabled ? 'LOGGING ON' : 'LIVE ONLY (NO LOG)'}
              </span>
            </div>
            <div class="app-meta">
              Range: \${Number(a.min_a).toFixed(2)}A – \${Number(a.max_a).toFixed(2)}A | Cal Factor: ×\${Number(a.cal_factor).toFixed(2)}
            </div>
          </div>
          <div style="display:flex;gap:6px;">
            <button class="icon-btn" onclick='editAppliance(\${JSON.stringify(a)})'>Edit</button>
            <button class="icon-btn" style="color:#fda4af;" onclick="deleteAppliance(\${a.id})">Delete</button>
          </div>
        </div>
      \`).join('');

      document.getElementById('cfgDashDeadzone').value = settings.dashboard_deadzone_amps || '0.25';
      document.getElementById('cfgSens').value = settings.base_sensitivity || '63.00';
      document.getElementById('cfgNoise').value = settings.noise_floor_mv || '9.50';
      document.getElementById('cfgDeadzone').value = settings.deadzone_amps || '0.25';
      document.getElementById('cfgOnA').value = settings.on_threshold_amps || '0.27';
      document.getElementById('cfgOffA').value = settings.off_threshold_amps || '0.22';
      document.getElementById('cfgVolt').value = settings.ac_voltage || '230';
      document.getElementById('cfgTariff').value = settings.tariff_rate || '8.5';
      document.getElementById('cfgUnmatched').value = settings.log_unmatched ?? '1';
      document.getElementById('cfgTitle').value = settings.dashboard_title || '';
      document.getElementById('cfgSub').value = settings.dashboard_subtitle || '';
      document.getElementById('cfgAdminUser').value = settings.admin_user || 'admin';

      document.getElementById('visState').checked = settings.show_state_card !== '0';
      document.getElementById('visCurrent').checked = settings.show_current_card !== '0';
      document.getElementById('visPower').checked = settings.show_power_card !== '0';
      document.getElementById('visTimer').checked = settings.show_timer_card !== '0';
      document.getElementById('visSignal').checked = settings.show_signal_mv !== '0';
      document.getElementById('visCost').checked = settings.show_cost_est !== '0';
      document.getElementById('visFilters').checked = settings.show_filters !== '0';
      document.getElementById('visClear').checked = settings.allow_public_clear === '1';
    }

    async function resetToGoldenDefaults() {
      if (!confirm('Restore Tested Working Calibration (0.25A Dashboard Deadzone, 9.5mV Noise Floor) and default Fan/Fridge/Iron profiles?')) return;
      const res = await fetch('/api/admin/reset-defaults', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-User': adminCreds.user,
          'X-Admin-Pass': adminCreds.pass
        },
        body: JSON.stringify({ reset_appliances: true })
      });
      if (res.ok) {
        const data = await res.json();
        appliances = data.state.appliances;
        settings = data.state.settings;
        populateAdminForms();
        applySettingsUI();
        updateLiveUI(data.state.live);
        showToast('✅ Restored to Tested Working Calibration!');
      }
    }

    function editAppliance(a) {
      document.getElementById('appId').value = a.id;
      document.getElementById('appName').value = a.name;
      document.getElementById('appIcon').value = a.icon || 'bolt';
      document.getElementById('appMin').value = a.min_a;
      document.getElementById('appMax').value = a.max_a;
      document.getElementById('appCal').value = a.cal_factor || 1.0;
      document.getElementById('appLog').value = a.log_enabled ? '1' : '0';
      document.getElementById('appSubmitText').textContent = 'Update Appliance Profile #' + a.id;
    }

    function resetApplianceForm() {
      document.getElementById('appId').value = '';
      document.getElementById('appName').value = '';
      document.getElementById('appMin').value = '';
      document.getElementById('appMax').value = '';
      document.getElementById('appCal').value = '1.00';
      document.getElementById('appLog').value = '1';
      document.getElementById('appSubmitText').textContent = 'Save New Appliance Profile';
    }

    async function saveAppliance(e) {
      e.preventDefault();
      const payload = {
        id: document.getElementById('appId').value || null,
        name: document.getElementById('appName').value.trim(),
        icon: document.getElementById('appIcon').value,
        min_a: Number(document.getElementById('appMin').value),
        max_a: Number(document.getElementById('appMax').value),
        cal_factor: Number(document.getElementById('appCal').value),
        log_enabled: document.getElementById('appLog').value === '1',
        active: true
      };
      const res = await fetch('/api/admin/appliance', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-User': adminCreds.user,
          'X-Admin-Pass': adminCreds.pass
        },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        resetApplianceForm();
        showToast('Appliance profile saved!');
      }
    }

    async function deleteAppliance(id) {
      if (!confirm('Delete this appliance profile?')) return;
      await fetch('/api/admin/appliance?id=' + id, {
        method: 'DELETE',
        headers: { 'X-Admin-User': adminCreds.user, 'X-Admin-Pass': adminCreds.pass }
      });
      showToast('Appliance deleted');
    }

    async function saveGlobalSettings(e) {
      e.preventDefault();
      const newPass = document.getElementById('cfgAdminPass').value;
      const newUser = document.getElementById('cfgAdminUser').value.trim();
      const payload = {
        dashboard_deadzone_amps: document.getElementById('cfgDashDeadzone').value,
        base_sensitivity: document.getElementById('cfgSens').value,
        noise_floor_mv: document.getElementById('cfgNoise').value,
        deadzone_amps: document.getElementById('cfgDeadzone').value,
        on_threshold_amps: document.getElementById('cfgOnA').value,
        off_threshold_amps: document.getElementById('cfgOffA').value,
        ac_voltage: document.getElementById('cfgVolt').value,
        tariff_rate: document.getElementById('cfgTariff').value,
        log_unmatched: document.getElementById('cfgUnmatched').value,
        dashboard_title: document.getElementById('cfgTitle').value.trim(),
        dashboard_subtitle: document.getElementById('cfgSub').value.trim(),
        show_state_card: document.getElementById('visState').checked ? '1' : '0',
        show_current_card: document.getElementById('visCurrent').checked ? '1' : '0',
        show_power_card: document.getElementById('visPower').checked ? '1' : '0',
        show_timer_card: document.getElementById('visTimer').checked ? '1' : '0',
        show_signal_mv: document.getElementById('visSignal').checked ? '1' : '0',
        show_cost_est: document.getElementById('visCost').checked ? '1' : '0',
        show_filters: document.getElementById('visFilters').checked ? '1' : '0',
        allow_public_clear: document.getElementById('visClear').checked ? '1' : '0',
        admin_user: newUser,
        admin_pass: newPass
      };

      const res = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-User': adminCreds.user,
          'X-Admin-Pass': adminCreds.pass
        },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        adminCreds.user = newUser;
        sessionStorage.setItem('adm_u', newUser);
        if (newPass) {
          adminCreds.pass = newPass;
          sessionStorage.setItem('adm_p', newPass);
          document.getElementById('cfgAdminPass').value = '';
        }
        showToast('Settings saved & enforced on Dashboard!');
      }
    }

    function connectWS() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(\`\${proto}//\${location.host}/api/ws\`);
      ws.onmessage = (e) => {
        if (e.data === 'PONG') return;
        const data = JSON.parse(e.data);
        if (data.type === 'SYNC') {
          allLogs = data.logs || [];
          appliances = data.appliances || [];
          settings = data.settings || {};
          applySettingsUI();
          updateLiveUI(data.live);
          renderLogs();
          if (isAdminView) populateAdminForms();
        } else if (data.type === 'LIVE') {
          updateLiveUI(data.live);
        }
      };
      ws.onclose = () => setTimeout(connectWS, 1500);
      setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('PING');
      }, 10000);
    }

    setInterval(() => {
      if (liveData) {
        updateLiveUI(liveData);
        const dashDeadzone = Number(settings.dashboard_deadzone_amps || 0.25);
        const isTrulyOn = (liveData.state === 'ON') && (Number(liveData.current_a || 0) >= dashDeadzone);
        if (isTrulyOn) {
          const elapsed = Math.floor((Date.now() - liveData.since_ms) / 1000);
          document.getElementById('liveTimer').textContent = formatClock(elapsed);
        } else {
          document.getElementById('liveTimer').textContent = '00:00';
        }
      }
    }, 1000);

    async function clearLogs() {
      if (!confirm('Clear all appliance history logs?')) return;
      const res = await fetch('/api/clear', {
        method: 'DELETE',
        headers: { 'X-Admin-User': adminCreds.user, 'X-Admin-Pass': adminCreds.pass }
      });
      if (!res.ok) alert('Please unlock Admin Studio first to clear history!');
    }

    connectWS();
  </script>
</body>
</html>`;
