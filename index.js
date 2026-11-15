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
        timestamp_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS live_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state TEXT,
        appliance TEXT,
        current_a REAL,
        power_w REAL,
        signal_mv REAL,
        since_ms INTEGER,
        updated_ms INTEGER
      );
    `);
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
    if (!sec || sec <= 0) return "-";
    const hrs = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const secs = Math.floor(sec % 60);
    if (hrs > 0) return `${hrs}h ${mins}m ${secs}s`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    // 1. ESP32 Event & Telemetry Endpoint
    if (url.pathname === "/api/update" && request.method === "POST") {
      const body = await request.json();
      const now = Date.now();
      const {
        event,         // "ON", "OFF", or "HEARTBEAT"
        appliance,     // "Iron", "Fan", "Iron + Fan", "None"
        current_a,
        power_w,
        signal_mv,
        on_current_a   // Peak/Avg current during the ON session (sent on OFF)
      } = body;

      const prevRows = this.sql.exec(`SELECT * FROM live_state WHERE id = 1`).toArray();
      const prev = prevRows.length ? prevRows[0] : null;

      let since_ms = prev ? prev.since_ms : now;
      if (event === "ON") {
        since_ms = now;
      } else if (event === "OFF") {
        since_ms = now;
      } else if (prev && prev.state !== (current_a >= 0.12 ? "ON" : "OFF")) {
        since_ms = now;
      }

      const currentState = (event === "OFF" || current_a < 0.12) ? "OFF" : "ON";

      this.sql.exec(
        `INSERT INTO live_state (id, state, appliance, current_a, power_w, signal_mv, since_ms, updated_ms)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           state=excluded.state,
           appliance=excluded.appliance,
           current_a=excluded.current_a,
           power_w=excluded.power_w,
           signal_mv=excluded.signal_mv,
           since_ms=excluded.since_ms,
           updated_ms=excluded.updated_ms`,
        currentState,
        appliance || "None",
        Number(current_a || 0),
        Number(power_w || 0),
        Number(signal_mv || 0),
        since_ms,
        now
      );

      // Log state change (ON or OFF)
      if (event === "ON" || event === "OFF") {
        const { date_str, day_str, time_str } = this.formatIST(now);
        let duration_sec = 0;

        if (event === "OFF") {
          const lastOn = this.sql.exec(
            `SELECT timestamp_ms, current_a FROM logs WHERE event_type = 'ON' ORDER BY id DESC LIMIT 1`
          ).toArray();
          if (lastOn.length > 0) {
            duration_sec = Math.max(1, Math.round((now - lastOn[0].timestamp_ms) / 1000));
          } else if (body.duration_sec) {
            duration_sec = Number(body.duration_sec);
          }
        }

        const duration_str = event === "OFF" ? this.formatDuration(duration_sec) : "Running...";
        const loggedCurrent = Number(current_a || 0);

        this.sql.exec(
          `INSERT INTO logs (appliance, event_type, current_a, power_w, date_str, day_str, time_str, duration_sec, duration_str, timestamp_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          appliance || "Appliance",
          event,
          loggedCurrent,
          Number(power_w || 0),
          date_str,
          day_str,
          time_str,
          duration_sec,
          duration_str,
          now
        );

        // If OFF, also update the matching previous ON row's duration_str so both rows show clarity
        if (event === "OFF") {
          this.sql.exec(
            `UPDATE logs SET duration_str = 'Completed (' || ? || ')' WHERE id = (SELECT id FROM logs WHERE event_type = 'ON' ORDER BY id DESC LIMIT 1)`,
            duration_str
          );
        }
      }

      return new Response(JSON.stringify({ ok: true, timestamp: now }), {
        headers: { ...cors, "Content-Type": "application/json" }
      });
    }

    // 2. Dashboard Data Fetch Endpoint
    if (url.pathname === "/api/status" && request.method === "GET") {
      const liveRows = this.sql.exec(`SELECT * FROM live_state WHERE id = 1`).toArray();
      const logs = this.sql.exec(`SELECT * FROM logs ORDER BY id DESC LIMIT 150`).toArray();
      return new Response(
        JSON.stringify({
          live: liveRows.length ? liveRows[0] : null,
          logs,
          server_time: Date.now()
        }),
        { headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // 3. Clear Logs Endpoint
    if (url.pathname === "/api/clear" && request.method === "DELETE") {
      this.sql.exec(`DELETE FROM logs`);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...cors, "Content-Type": "application/json" }
      });
    }

    return new Response("Not Found", { status: 404 });
  }
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
  <title>Smart Appliance Telemetry • Material 3</title>
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
      --warning: #f59e0b;
      --warning-soft: rgba(245, 158, 11, 0.15);
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --radius-lg: 24px;
      --radius-md: 16px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Plus Jakarta Sans', sans-serif;
      background: radial-gradient(circle at top right, #1e1b4b, var(--bg) 50%);
      color: var(--text);
      min-height: 100vh;
      padding: 20px;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
    }

    /* Top App Bar */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
      padding: 18px 24px;
      background: rgba(19, 27, 46, 0.8);
      backdrop-filter: blur(16px);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      margin-bottom: 24px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .brand-icon {
      width: 48px;
      height: 48px;
      border-radius: 16px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      display: grid;
      place-items: center;
      box-shadow: 0 8px 20px rgba(99, 102, 241, 0.35);
    }

    .brand h1 {
      font-size: 1.25rem;
      font-weight: 800;
      letter-spacing: -0.02em;
    }

    .brand p {
      font-size: 0.82rem;
      color: var(--text-muted);
    }

    .conn-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      border-radius: 999px;
      font-size: 0.82rem;
      font-weight: 600;
      background: var(--surface-2);
      border: 1px solid var(--border);
    }

    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--text-muted);
    }
    .dot.online {
      background: var(--success);
      box-shadow: 0 0 12px var(--success);
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.25); opacity: 0.7; }
    }

    /* Live Hero Grid */
    .grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 18px;
      margin-bottom: 24px;
    }

    .card {
      background: rgba(19, 27, 46, 0.85);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 22px;
      position: relative;
      overflow: hidden;
      transition: transform 0.2s ease, border-color 0.2s ease;
    }

    .card:hover {
      transform: translateY(-2px);
      border-color: rgba(99, 102, 241, 0.35);
    }

    .card-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: var(--text-muted);
      font-size: 0.85rem;
      font-weight: 600;
      margin-bottom: 12px;
    }

    .card-value {
      font-family: 'JetBrains Mono', monospace;
      font-size: 2rem;
      font-weight: 700;
      margin-bottom: 6px;
    }

    .card-sub {
      font-size: 0.8rem;
      color: var(--text-muted);
    }

    .state-on {
      background: linear-gradient(135deg, rgba(16, 185, 129, 0.18), rgba(19, 27, 46, 0.9));
      border-color: rgba(16, 185, 129, 0.4);
    }
    .state-off {
      background: rgba(19, 27, 46, 0.85);
    }

    /* Filter & Action Bar */
    .toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 16px;
    }

    .chips {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .chip {
      padding: 8px 16px;
      border-radius: 999px;
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text-muted);
      transition: all 0.2s;
    }

    .chip.active {
      background: var(--primary);
      color: white;
      border-color: var(--primary);
      box-shadow: 0 4px 14px rgba(99, 102, 241, 0.35);
    }

    .btn-danger {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 16px;
      border-radius: 12px;
      border: 1px solid rgba(244, 63, 94, 0.3);
      background: var(--danger-soft);
      color: #fda4af;
      font-size: 0.84rem;
      font-weight: 600;
      cursor: pointer;
    }

    /* Log Table & Mobile Cards */
    .table-card {
      background: rgba(19, 27, 46, 0.85);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      overflow: hidden;
    }

    .table-wrap {
      width: 100%;
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
    }

    th {
      padding: 16px 20px;
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-muted);
      background: rgba(28, 39, 66, 0.5);
      border-bottom: 1px solid var(--border);
    }

    td {
      padding: 16px 20px;
      font-size: 0.92rem;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }

    tr:last-child td { border-bottom: none; }
    tr:hover td { background: rgba(255, 255, 255, 0.02); }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 12px;
      border-radius: 999px;
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.03em;
    }

    .badge-on {
      background: var(--success-soft);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }

    .badge-off {
      background: var(--danger-soft);
      color: #fb7185;
      border: 1px solid rgba(244, 63, 94, 0.3);
    }

    .app-tag {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-weight: 700;
    }

    .mono {
      font-family: 'JetBrains Mono', monospace;
      font-weight: 600;
    }

    .duration-pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 4px 10px;
      border-radius: 8px;
      background: var(--primary-soft);
      color: #a5b4fc;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.82rem;
      font-weight: 600;
    }

    .empty-state {
      padding: 48px 20px;
      text-align: center;
      color: var(--text-muted);
    }

    /* Responsive Breakpoints */
    @media (max-width: 992px) {
      .grid { grid-template-columns: repeat(2, 1fr); }
    }

    @media (max-width: 640px) {
      body { padding: 12px; }
      .grid { grid-template-columns: 1fr; gap: 12px; }
      .card { padding: 18px; }
      .card-value { font-size: 1.65rem; }
      
      /* Turn table rows into sleek Material cards on Mobile */
      thead { display: none; }
      table, tbody, tr, td { display: block; width: 100%; }
      tr {
        padding: 16px;
        border-bottom: 1px solid var(--border);
      }
      td {
        padding: 6px 0;
        border: none;
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 0.88rem;
      }
      td::before {
        content: attr(data-label);
        color: var(--text-muted);
        font-size: 0.78rem;
        font-weight: 600;
        text-transform: uppercase;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Top Bar -->
    <header class="header">
      <div class="brand">
        <div class="brand-icon">
          <span class="material-symbols-rounded" style="color:white;font-size:28px;">bolt</span>
        </div>
        <div>
          <h1>ESP32 Appliance Telemetry</h1>
          <p>ACS712-30A True-RMS Live Logger & Session Tracker</p>
        </div>
      </div>
      <div class="conn-pill">
        <span id="connDot" class="dot"></span>
        <span id="connText">Waiting for ESP32...</span>
      </div>
    </header>

    <!-- Live Telemetry Cards -->
    <section class="grid">
      <div id="stateCard" class="card state-off">
        <div class="card-head">
          <span>CURRENT STATE</span>
          <span class="material-symbols-rounded">power_settings_new</span>
        </div>
        <div id="liveState" class="card-value">OFF</div>
        <div id="liveAppliance" class="card-sub">Appliance: None</div>
      </div>

      <div class="card">
        <div class="card-head">
          <span>LIVE CURRENT (RMS)</span>
          <span class="material-symbols-rounded">electric_meter</span>
        </div>
        <div id="liveCurrent" class="card-value">0.000 A</div>
        <div id="liveSignal" class="card-sub">ADC Signal: 0.00 mV</div>
      </div>

      <div class="card">
        <div class="card-head">
          <span>ACTIVE POWER</span>
          <span class="material-symbols-rounded">speed</span>
        </div>
        <div id="livePower" class="card-value">0.0 W</div>
        <div class="card-sub">At 230V AC Nominal</div>
      </div>

      <div class="card">
        <div class="card-head">
          <span>ACTIVE TIMER</span>
          <span class="material-symbols-rounded">timer</span>
        </div>
        <div id="liveTimer" class="card-value">00:00</div>
        <div id="liveSince" class="card-sub">Idle</div>
      </div>
    </section>

    <!-- Filter & Actions -->
    <div class="toolbar">
      <div class="chips">
        <button class="chip active" onclick="setFilter('ALL', this)">All Events</button>
        <button class="chip" onclick="setFilter('Iron', this)">Iron Only</button>
        <button class="chip" onclick="setFilter('Fan', this)">Fan Only</button>
        <button class="chip" onclick="setFilter('ON', this)">ON Logs</button>
        <button class="chip" onclick="setFilter('OFF', this)">OFF Logs</button>
      </div>
      <button class="btn-danger" onclick="clearLogs()">
        <span class="material-symbols-rounded" style="font-size:18px;">delete</span>
        Clear History
      </button>
    </div>

    <!-- Logs Table -->
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
              <th>ON Duration</th>
            </tr>
          </thead>
          <tbody id="logBody">
            <tr><td colspan="6" class="empty-state">Loading telemetry logs...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    let allLogs = [];
    let currentFilter = 'ALL';
    let liveData = null;

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

    function renderLogs() {
      const tbody = document.getElementById('logBody');
      const filtered = allLogs.filter(item => {
        if (currentFilter === 'ALL') return true;
        if (currentFilter === 'ON' || currentFilter === 'OFF') return item.event_type === currentFilter;
        return item.appliance.includes(currentFilter);
      });

      if (!filtered.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No ON/OFF events recorded yet. Turn ON your Iron or Fan!</td></tr>';
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
              \${Number(row.current_a).toFixed(3)} A <span style="color:var(--text-muted);font-size:0.8rem;">(\${ Number(row.power_w).toFixed(0) } W)</span>
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

    async function fetchStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        allLogs = data.logs || [];
        liveData = data.live;

        if (liveData) {
          const ageSec = (data.server_time - liveData.updated_ms) / 1000;
          const dot = document.getElementById('connDot');
          const txt = document.getElementById('connText');
          if (ageSec < 15) {
            dot.className = 'dot online';
            txt.textContent = 'ESP32 Live (' + Math.max(0, Math.round(ageSec)) + 's ago)';
          } else {
            dot.className = 'dot';
            txt.textContent = 'ESP32 Offline (' + Math.round(ageSec) + 's ago)';
          }

          const isOn = liveData.state === 'ON';
          const stateCard = document.getElementById('stateCard');
          stateCard.className = 'card ' + (isOn ? 'state-on' : 'state-off');

          document.getElementById('liveState').textContent = liveData.state;
          document.getElementById('liveState').style.color = isOn ? '#34d399' : '#f8fafc';
          document.getElementById('liveAppliance').textContent = 'Detected: ' + (liveData.appliance || 'None');
          document.getElementById('liveCurrent').textContent = Number(liveData.current_a).toFixed(3) + ' A';
          document.getElementById('liveSignal').textContent = 'ADC Signal: ' + Number(liveData.signal_mv).toFixed(2) + ' mV';
          document.getElementById('livePower').textContent = Number(liveData.power_w).toFixed(1) + ' W';
          document.getElementById('liveSince').textContent = isOn ? 'Running continuously' : 'Load is OFF';
        }

        renderLogs();
      } catch (e) {
        console.error(e);
      }
    }

    setInterval(() => {
      if (liveData && liveData.state === 'ON') {
        const elapsed = Math.floor((Date.now() - liveData.since_ms) / 1000);
        document.getElementById('liveTimer').textContent = formatClock(elapsed);
      } else {
        document.getElementById('liveTimer').textContent = '00:00';
      }
    }, 1000);

    async function clearLogs() {
      if (!confirm('Clear all appliance history logs?')) return;
      await fetch('/api/clear', { method: 'DELETE' });
      fetchStatus();
    }

    fetchStatus();
    setInterval(fetchStatus, 2000);
  </script>
</body>
</html>`;
