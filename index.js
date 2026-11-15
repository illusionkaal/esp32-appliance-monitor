export class ApplianceLoggerDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        appliance TEXT,
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
        current_a REAL,
        power_w REAL,
        signal_mv REAL,
        since_ms INTEGER,
        updated_ms INTEGER,
        esp_online INTEGER DEFAULT 1
      );
    `);
    try {
      this.sql.exec(`ALTER TABLE logs ADD COLUMN note TEXT DEFAULT ''`);
    } catch (e) {}
    try {
      this.sql.exec(`ALTER TABLE live_state ADD COLUMN esp_online INTEGER DEFAULT 1`);
    } catch (e) {}
  }

  formatIST(ms) {
    const d = new Date(ms);
    const date_str = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    }).format(d);
    const day_str = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      weekday: 'long'
    }).format(d);
    const time_str = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
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
      server_time: Date.now()
    };
  }

  broadcast(dataObj) {
    const msg = JSON.stringify(dataObj);
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      try { ws.send(msg); } catch (e) {}
    }
  }

  // Automatic 10-Second Watchdog Alarm when ESP32 loses Power or Internet!
  async alarm() {
    const rows = this.sql.exec(`SELECT * FROM live_state WHERE id = 1`).toArray();
    if (!rows.length) return;
    const prev = rows[0];
    const now = Date.now();

    if (now - prev.updated_ms >= 9000 && prev.esp_online === 1) {
      this.sql.exec(`UPDATE live_state SET esp_online = 0 WHERE id = 1`);
      this.broadcast(this.getFullState());
    }
  }

  insertLogRow(appliance, event, current_a, power_w, eventTimeMs, noteStr, knownDurationSec = 0) {
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
    if (noteStr) {
      duration_str = `${duration_str} (${noteStr})`;
    }

    this.sql.exec(
      `INSERT INTO logs (appliance, event_type, current_a, power_w, date_str, day_str, time_str, duration_sec, duration_str, timestamp_ms, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      appliance || "Appliance",
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
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Connection": "keep-alive"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    // 1. Real-Time WebSocket Endpoint
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

    // 2. ESP32 Telemetry, Offline Sync & Power-Recovery Endpoint
    if (url.pathname === "/api/update" && request.method === "POST") {
      const body = await request.json();
      const now = Date.now();
      const {
        event,          // "ON", "OFF", "HEARTBEAT", "BOOT_SYNC"
        appliance,
        current_a,
        power_w,
        signal_mv,
        duration_sec,
        event_epoch_ms, // Sent when flushing offline queued events!
        is_offline_sync
      } = body;

      // Schedule watchdog alarm 10 seconds in the future
      await this.ctx.storage.setAlarm(now + 10000);

      // Use original NTP timestamp if ESP32 is syncing an offline-queued event!
      const effectiveTimeMs = (event_epoch_ms && event_epoch_ms > 1700000000000) ? Number(event_epoch_ms) : now;

      const prevRows = this.sql.exec(`SELECT * FROM live_state WHERE id = 1`).toArray();
      const prev = prevRows.length ? prevRows[0] : null;

      const currentState = (event === "OFF" || Number(current_a) < 0.20) ? "OFF" : "ON";
      let since_ms = prev ? prev.since_ms : effectiveTimeMs;
      let logsUpdated = false;

      // --- CASE 2B & 2C: POWER-LOSS / REBOOT RECONCILIATION ---
      if (event === "ON") {
        if (prev && prev.state === "ON") {
          // Sub-Case 2B: Appliance was ALREADY ON before ESP32 rebooted!
          // Do NOT create a duplicate ON row; keep original since_ms timer running!
          since_ms = prev.since_ms;
        } else {
          since_ms = effectiveTimeMs;
          logsUpdated = true;
          const note = is_offline_sync ? "Synced after Net Restore" : "";
          this.insertLogRow(appliance, "ON", current_a, power_w, effectiveTimeMs, note, 0);
        }
      } else if (event === "OFF") {
        if (!prev || prev.state === "ON" || is_offline_sync) {
          since_ms = effectiveTimeMs;
          logsUpdated = true;
          const note = is_offline_sync ? "Synced after Net Restore" : "";
          this.insertLogRow(appliance, "OFF", 0.0, 0.0, effectiveTimeMs, note, Number(duration_sec || 0));
        }
      } else if (event === " HEARTBEAT" || event === "HEARTBEAT" || event === "BOOT_SYNC") {
        // Sub-Case 2C: Appliance was ON in DB, ESP32 lost power, appliance turned OFF while ESP32 was dead,
        // and now ESP32 booted up reporting 0.000A (OFF)!
        if (prev && prev.state === "ON" && currentState === "OFF") {
          logsUpdated = true;
          since_ms = now;
          this.insertLogRow(
            prev.appliance || "Appliance",
            "OFF",
            0.0,
            0.0,
            now,
            "Auto-Closed after ESP Power/Net Loss",
            0
          );
        } else if ((!prev || prev.state === "OFF") && currentState === "ON") {
          // Appliance turned ON while ESP32 was dead, and ESP32 just booted seeing current!
          logsUpdated = true;
          since_ms = now;
          this.insertLogRow(
            appliance || "Appliance",
            "ON",
            current_a,
            power_w,
            now,
            "Detected on ESP Recovery",
            0
          );
        }
      }

      this.sql.exec(
        `INSERT INTO live_state (id, state, appliance, current_a, power_w, signal_mv, since_ms, updated_ms, esp_online)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(id) DO UPDATE SET
           state=excluded.state,
           appliance=excluded.appliance,
           current_a=excluded.current_a,
           power_w=excluded.power_w,
           signal_mv=excluded.signal_mv,
           since_ms=excluded.since_ms,
           updated_ms=excluded.updated_ms,
           esp_online=1`,
        currentState,
        currentState === "OFF" ? "None" : (appliance || "Appliance"),
        Number(current_a || 0),
        Number(power_w || 0),
        Number(signal_mv || 0),
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
            appliance: currentState === "OFF" ? "None" : (appliance || "None"),
            current_a: Number(current_a || 0),
            power_w: Number(power_w || 0),
            signal_mv: Number(signal_mv || 0),
            since_ms,
            updated_ms: now,
            esp_online: 1
          },
          server_time: now
        });
      }

      return new Response("OK", { headers: cors });
    }

    if (url.pathname === "/api/status" && request.method === "GET") {
      return new Response(JSON.stringify(this.getFullState()), {
        headers: { ...cors, "Content-Type": "application/json" }
      });
    }

    if (url.pathname === "/api/clear" && request.method === "DELETE") {
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
  <title>Real-Time Appliance Telemetry • Material 3</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@24,500,1,0" rel="stylesheet" />
  <style>
    :root {
      --bg: #0b0f19;
      --surface: #131b2e;
      --surface-2: #1c2742;
      --border: rgba(255, 255, 255, 0.08);
      --primary: #6366f1;
      --primary-soft: rgba(99, 102, 241, 0.15);
      --success: #10b981;
      --success-soft: rgba(16, 185, 129, 0.15);
      --danger: #f43f5e;
      --danger-soft: rgba(244, 63, 94, 0.15);
      --warn: #f59e0b;
      --warn-soft: rgba(245, 158, 11, 0.18);
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --radius-lg: 24px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Plus Jakarta Sans', sans-serif;
      background: radial-gradient(circle at top right, #1e1b4b, var(--bg) 50%);
      color: var(--text);
      min-height: 100vh;
      padding: 20px;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    .header {
      display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px;
      padding: 18px 24px; background: rgba(19, 27, 46, 0.85); backdrop-filter: blur(16px);
      border: 1px solid var(--border); border-radius: var(--radius-lg); margin-bottom: 18px;
    }
    .brand { display: flex; align-items: center; gap: 14px; }
    .brand-icon {
      width: 48px; height: 48px; border-radius: 16px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      display: grid; place-items: center; box-shadow: 0 8px 20px rgba(99, 102, 241, 0.35);
    }
    .brand h1 { font-size: 1.25rem; font-weight: 800; }
    .brand p { font-size: 0.82rem; color: var(--text-muted); }
    .conn-pill {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 8px 16px; border-radius: 999px; font-size: 0.82rem; font-weight: 700;
      background: var(--surface-2); border: 1px solid var(--border);
    }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--danger); }
    .dot.online { background: var(--success); box-shadow: 0 0 12px var(--success); animation: pulse 1.2s infinite; }
    @keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.3); opacity: 0.7; } }

    .offline-banner {
      display: none; align-items: center; gap: 12px;
      padding: 14px 20px; border-radius: 16px; margin-bottom: 20px;
      background: var(--warn-soft); border: 1px solid rgba(245, 158, 11, 0.45); color: #fcd34d;
      font-size: 0.9rem; font-weight: 600;
    }

    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 18px; margin-bottom: 24px; }
    .card {
      background: rgba(19, 27, 46, 0.85); border: 1px solid var(--border);
      border-radius: var(--radius-lg); padding: 22px; transition: all 0.15s ease;
    }
    .card-head { display: flex; justify-content: space-between; align-items: center; color: var(--text-muted); font-size: 0.82rem; font-weight: 700; margin-bottom: 12px; }
    .card-value { font-family: 'JetBrains Mono', monospace; font-size: 2rem; font-weight: 700; margin-bottom: 6px; }
    .card-sub { font-size: 0.8rem; color: var(--text-muted); }
    .state-on {
      background: linear-gradient(135deg, rgba(16, 185, 129, 0.22), rgba(19, 27, 46, 0.92));
      border-color: rgba(16, 185, 129, 0.5);
      box-shadow: 0 0 25px rgba(16, 185, 129, 0.15);
    }
    .toolbar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
    .chips { display: flex; gap: 8px; flex-wrap: wrap; }
    .chip {
      padding: 8px 16px; border-radius: 999px; font-size: 0.85rem; font-weight: 600;
      cursor: pointer; border: 1px solid var(--border); background: var(--surface); color: var(--text-muted);
    }
    .chip.active { background: var(--primary); color: white; border-color: var(--primary); }
    .btn-danger {
      display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border-radius: 12px;
      border: 1px solid rgba(244, 63, 94, 0.3); background: var(--danger-soft); color: #fda4af; font-size: 0.84rem; font-weight: 600; cursor: pointer;
    }
    .table-card { background: rgba(19, 27, 46, 0.85); border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; }
    .table-wrap { width: 100%; overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; text-align: left; }
    th { padding: 16px 20px; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); background: rgba(28, 39, 66, 0.5); border-bottom: 1px solid var(--border); }
    td { padding: 16px 20px; font-size: 0.92rem; border-bottom: 1px solid var(--border); }
    .badge { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 999px; font-size: 0.78rem; font-weight: 700; }
    .badge-on { background: var(--success-soft); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }
    .badge-off { background: var(--danger-soft); color: #fb7185; border: 1px solid rgba(244, 63, 94, 0.3); }
    .app-tag { display: inline-flex; align-items: center; gap: 6px; font-weight: 700; }
    .mono { font-family: 'JetBrains Mono', monospace; font-weight: 600; }
    .duration-pill { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border-radius: 8px; background: var(--primary-soft); color: #a5b4fc; font-family: 'JetBrains Mono', monospace; font-size: 0.82rem; font-weight: 600; }
    .empty-state { padding: 48px 20px; text-align: center; color: var(--text-muted); }

    @media (max-width: 992px) { .grid { grid-template-columns: repeat(2, 1fr); } }
    @media (max-width: 640px) {
      body { padding: 12px; }
      .grid { grid-template-columns: 1fr; gap: 12px; }
      thead { display: none; }
      table, tbody, tr, td { display: block; width: 100%; }
      tr { padding: 16px; border-bottom: 1px solid var(--border); }
      td { padding: 6px 0; border: none; display: flex; justify-content: space-between; align-items: center; }
      td::before { content: attr(data-label); color: var(--text-muted); font-size: 0.78rem; font-weight: 600; text-transform: uppercase; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="header">
      <div class="brand">
        <div class="brand-icon"><span class="material-symbols-rounded" style="color:white;font-size:28px;">bolt</span></div>
        <div>
          <h1>ESP32 Appliance Telemetry</h1>
          <p>Fault-Tolerant Stream • Offline Queue & Power-Loss Recovery</p>
        </div>
      </div>
      <div class="conn-pill">
        <span id="connDot" class="dot"></span>
        <span id="connText">Connecting...</span>
      </div>
    </header>

    <div id="offlineBanner" class="offline-banner">
      <span class="material-symbols-rounded">warning</span>
      <span id="offlineText">ESP32 Power or Internet Lost! Waiting for reconnection (Offline events will auto-sync)...</span>
    </div>

    <section class="grid">
      <div id="stateCard" class="card">
        <div class="card-head"><span>CURRENT STATE</span><span class="material-symbols-rounded">power_settings_new</span></div>
        <div id="liveState" class="card-value">OFF</div>
        <div id="liveAppliance" class="card-sub">Appliance: None</div>
      </div>
      <div class="card">
        <div class="card-head"><span>LIVE CURRENT (RMS)</span><span class="material-symbols-rounded">electric_meter</span></div>
        <div id="liveCurrent" class="card-value">0.000 A</div>
        <div id="liveSignal" class="card-sub">ADC Signal: 0.00 mV</div>
      </div>
      <div class="card">
        <div class="card-head"><span>ACTIVE POWER</span><span class="material-symbols-rounded">speed</span></div>
        <div id="livePower" class="card-value">0.0 W</div>
        <div class="card-sub">At 230V AC Nominal</div>
      </div>
      <div class="card">
        <div class="card-head"><span>ACTIVE SESSION TIMER</span><span class="material-symbols-rounded">timer</span></div>
        <div id="liveTimer" class="card-value">00:00</div>
        <div id="liveSince" class="card-sub">Idle</div>
      </div>
    </section>

    <div class="toolbar">
      <div class="chips">
        <button class="chip active" onclick="setFilter('ALL', this)">All Events</button>
        <button class="chip" onclick="setFilter('Iron', this)">Iron Only</button>
        <button class="chip" onclick="setFilter('Fan', this)">Fan Only</button>
        <button class="chip" onclick="setFilter('ON', this)">ON Logs</button>
        <button class="chip" onclick="setFilter('OFF', this)">OFF Logs</button>
      </div>
      <button class="btn-danger" onclick="clearLogs()">
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
            <tr><td colspan="6" class="empty-state">Waiting for real-time telemetry...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    let allLogs = [];
    let currentFilter = 'ALL';
    let liveData = null;
    let ws = null;

    function formatClock(sec) {
      if (sec < 0) sec = 0;
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = Math.floor(sec % 60);
      const pad = n => String(n).padStart(2, '0');
      return h > 0 ? \`\${pad(h)}:\${pad(m)}:\${pad(s)}\` : \`\${pad(m)}:\${pad(s)}\`;
    }

    function setFilter(f, btn) {
      currentFilter = f;
      document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      renderLogs();
    }

    function updateLiveUI(live) {
      if (!live) return;
      liveData = live;
      const isOn = live.state === 'ON';
      const espOnline = live.esp_online === 1 && (Date.now() - live.updated_ms < 12000);

      document.getElementById('stateCard').className = 'card ' + (isOn ? 'state-on' : '');
      document.getElementById('liveState').textContent = live.state;
      document.getElementById('liveState').style.color = isOn ? '#34d399' : '#f8fafc';
      document.getElementById('liveAppliance').textContent = 'Detected: ' + (live.appliance || 'None');
      document.getElementById('liveCurrent').textContent = Number(live.current_a).toFixed(3) + ' A';
      document.getElementById('liveSignal').textContent = 'ADC Signal: ' + Number(live.signal_mv).toFixed(2) + ' mV';
      document.getElementById('livePower').textContent = Number(live.power_w).toFixed(1) + ' W';

      const dot = document.getElementById('connDot');
      const txt = document.getElementById('connText');
      const banner = document.getElementById('offlineBanner');

      if (espOnline) {
        dot.className = 'dot online';
        txt.textContent = 'ESP32 Online (Real-Time)';
        banner.style.display = 'none';
        document.getElementById('liveSince').textContent = isOn ? 'Streaming Live (1s rate)' : 'Load is OFF';
      } else {
        dot.className = 'dot';
        txt.textContent = 'ESP32 Offline / Power Lost';
        banner.style.display = 'flex';
        document.getElementById('liveSince').textContent = isOn ? '⚠️ Last known state: ON (ESP Offline)' : 'ESP32 Offline';
      }
    }

    function renderLogs() {
      const tbody = document.getElementById('logBody');
      const filtered = allLogs.filter(item => {
        if (currentFilter === 'ALL') return true;
        if (currentFilter === 'ON' || currentFilter === 'OFF') return item.event_type === currentFilter;
        return item.appliance.includes(currentFilter);
      });

      if (!filtered.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No ON/OFF events recorded yet.</td></tr>';
        return;
      }

      tbody.innerHTML = filtered.map(row => {
        const isOn = row.event_type === 'ON';
        const icon = row.appliance.includes('Iron') ? 'iron' : (row.appliance.includes('Fan') ? 'mode_fan' : 'power');
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

    function connectWS() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(\`\${proto}//\${location.host}/api/ws\`);
      ws.onmessage = (e) => {
        if (e.data === 'PONG') return;
        const data = JSON.parse(e.data);
        if (data.type === 'SYNC') {
          allLogs = data.logs || [];
          updateLiveUI(data.live);
          renderLogs();
        } else if (data.type === 'LIVE') {
          updateLiveUI(data.live);
        }
      };
      ws.onclose = () => setTimeout(connectWS, 1500);
    }

    setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send('PING');
      if (liveData) {
        updateLiveUI(liveData);
        if (liveData.state === 'ON') {
          const elapsed = Math.floor((Date.now() - liveData.since_ms) / 1000);
          document.getElementById('liveTimer').textContent = formatClock(elapsed);
        } else {
          document.getElementById('liveTimer').textContent = '00:00';
        }
      }
    }, 1000);

    async function clearLogs() {
      if (!confirm('Clear all appliance history logs?')) return;
      await fetch('/api/clear', { method: 'DELETE' });
    }

    connectWS();
  </script>
</body>
</html>`;
