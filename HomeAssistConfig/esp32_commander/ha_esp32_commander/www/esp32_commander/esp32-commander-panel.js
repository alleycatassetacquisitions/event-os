/**
 * ESP32 Commander Panel
 * A Home Assistant custom panel for controlling ESP32 devices via MQTT.
 *
 * Place this file at:
 *   config/www/esp32_commander/esp32-commander-panel.js
 *
 * Then register the panel in configuration.yaml (see README).
 */

class ESP32CommanderPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._devices = {};
    this._selectedDevice = null;
    this._eventUnsubscribe = null;
    this._activeTab = "message";
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) {
      this._initialized = true;
      this._render();
      this._initAsync();
    }
  }

  async _initAsync() {
    await this._loadDevices();
    await this._subscribeToEvents();
  }

  connectedCallback() {
    if (this._hass && !this._initialized) {
      this._initialized = true;
      this._render();
      this._initAsync();
    }
  }

  disconnectedCallback() {
    if (this._eventUnsubscribe) {
      this._eventUnsubscribe();
      this._eventUnsubscribe = null;
    }
    this._initialized = false;
  }

  /**
   * Fetch the current device list from the HA integration via websocket.
   * This gives us the retained state of all devices immediately on page load,
   * sourced from the integration's in-memory store (which was populated from
   * the retained protobuf MQTT status messages).
   */
  async _loadDevices() {
    if (!this._hass) return;
    try {
      const result = await this._hass.connection.sendMessagePromise({
        type: "esp32_commander/list_devices",
      });
      (result.devices || []).forEach((d) => {
        this._devices[d.device_id] = d;
      });
      this._renderDeviceList();
      console.info("[ESP32 Commander] Loaded", Object.keys(this._devices).length, "device(s)");
    } catch (err) {
      console.warn("[ESP32 Commander] Could not load device list:", err);
    }
  }

  /**
   * Subscribe to esp32_commander_device_update HA events.
   * The integration decodes the protobuf binary from MQTT and fires these
   * events as plain JSON — no binary handling needed in the frontend.
   */
  async _subscribeToEvents() {
    if (!this._hass || this._eventUnsubscribe) return;
    try {
      this._eventUnsubscribe = await this._hass.connection.subscribeEvents(
        (event) => {
          const d = event.data;
          if (!d || !d.device_id) return;
          this._devices[d.device_id] = {
            ...this._devices[d.device_id],
            ...d,
          };
          this._renderDeviceList();
        },
        "esp32_commander_device_update"
      );
      console.info("[ESP32 Commander] Subscribed to esp32_commander_device_update events");
    } catch (err) {
      console.warn("[ESP32 Commander] Could not subscribe to device events:", err);
    }
  }

  // ─── Service Callers ───────────────────────────────────────────────────────

  async _callService(service, data) {
    if (!this._hass) return;
    try {
      await this._hass.callService("esp32_commander", service, data);
      this._showFeedback(`✓ ${service.replace(/_/g, " ")} sent`, "success");
    } catch (err) {
      this._showFeedback(`✗ Error: ${err.message}`, "error");
    }
  }

  _sendMessage() {
    const root = this.shadowRoot;
    const deviceId = this._selectedDevice;
    if (!deviceId) return this._showFeedback("Select a device first", "warn");

    const message = root.getElementById("msg-text").value.trim();
    if (!message) return this._showFeedback("Enter a message", "warn");

    const duration = parseInt(root.getElementById("msg-duration").value) || 5;
    const scroll = root.getElementById("msg-scroll").checked;

    this._callService("send_message", { device_id: deviceId, message, duration, scroll });
  }

  _setLed(state) {
    const root = this.shadowRoot;
    const deviceId = this._selectedDevice;
    if (!deviceId) return this._showFeedback("Select a device first", "warn");

    const brightness = parseInt(root.getElementById("led-brightness").value);
    const effect = root.getElementById("led-effect").value;
    const colorHex = root.getElementById("led-color").value;
    const r = parseInt(colorHex.slice(1, 3), 16);
    const g = parseInt(colorHex.slice(3, 5), 16);
    const b = parseInt(colorHex.slice(5, 7), 16);

    this._callService("set_led", {
      device_id: deviceId,
      state,
      brightness,
      red: r, green: g, blue: b,
      effect,
    });
  }

  _triggerHaptic() {
    const root = this.shadowRoot;
    const deviceId = this._selectedDevice;
    if (!deviceId) return this._showFeedback("Select a device first", "warn");

    const pattern = root.getElementById("haptic-pattern").value;
    const intensity = parseInt(root.getElementById("haptic-intensity").value);
    const duration_ms = parseInt(root.getElementById("haptic-duration").value);
    const repeat = parseInt(root.getElementById("haptic-repeat").value);

    this._callService("trigger_haptic", { device_id: deviceId, pattern, intensity, duration_ms, repeat });
  }

  _showFeedback(msg, type = "info") {
    const el = this.shadowRoot.getElementById("feedback");
    if (!el) return;
    const colors = { success: "#1d9e75", error: "#e24b4a", warn: "#ef9f27", info: "#378add" };
    el.textContent = msg;
    el.style.color = colors[type] || colors.info;
    el.style.opacity = "1";
    clearTimeout(this._feedbackTimer);
    this._feedbackTimer = setTimeout(() => { el.style.opacity = "0"; }, 3000);
  }

  // ─── Render Helpers ────────────────────────────────────────────────────────

  _selectDevice(deviceId) {
    this._selectedDevice = deviceId;
    this.shadowRoot.querySelectorAll(".device-chip").forEach(c => {
      c.classList.toggle("active", c.dataset.id === deviceId);
    });
    const nameEl = this.shadowRoot.getElementById("selected-device-name");
    if (nameEl) {
      const d = this._devices[deviceId];
      nameEl.textContent = d ? deviceId : deviceId;
    }
    const panel = this.shadowRoot.getElementById("control-panel");
    if (panel) panel.style.display = "block";
  }

  _setTab(tab) {
    this._activeTab = tab;
    this.shadowRoot.querySelectorAll(".tab-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    this.shadowRoot.querySelectorAll(".tab-pane").forEach(p => {
      p.style.display = p.dataset.tab === tab ? "block" : "none";
    });
  }

  _renderDeviceList() {
    const container = this.shadowRoot.getElementById("device-list");
    if (!container) return;

    const deviceIds = Object.keys(this._devices);

    if (deviceIds.length === 0) {
      container.innerHTML = `<p class="empty-hint">Waiting for ESP32 devices to report in…<br><span>Devices publish to <code>esp32/{id}/status</code></span></p>`;
      return;
    }

    container.innerHTML = deviceIds.map(id => {
      const d = this._devices[id];
      const online = d?.online !== false;
      return `
        <div class="device-chip ${this._selectedDevice === id ? "active" : ""}" data-id="${id}">
          <span class="device-status-dot ${online ? "online" : "offline"}"></span>
          <span class="device-id">${id}</span>
          ${d?.rssi ? `<span class="device-rssi">${d.rssi} dBm</span>` : ""}
        </div>
      `;
    }).join("");

    container.querySelectorAll(".device-chip").forEach(chip => {
      chip.addEventListener("click", () => this._selectDevice(chip.dataset.id));
    });
  }

  // ─── Main Render ───────────────────────────────────────────────────────────

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: var(--primary-font-family, sans-serif);
          background: var(--primary-background-color, #f5f5f5);
          min-height: 100vh;
          color: var(--primary-text-color, #212121);
        }
        .page-header {
          background: var(--card-background-color, #fff);
          border-bottom: 1px solid var(--divider-color, #e0e0e0);
          padding: 16px 24px;
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .page-header h1 {
          margin: 0;
          font-size: 20px;
          font-weight: 500;
          letter-spacing: 0.01em;
        }
        .page-header .subtitle {
          font-size: 13px;
          color: var(--secondary-text-color, #727272);
          margin: 0;
        }
        .chip-icon {
          width: 36px;
          height: 36px;
          background: #1d9e75;
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .chip-icon svg { width: 22px; height: 22px; fill: #fff; }

        .layout {
          display: grid;
          grid-template-columns: 280px 1fr;
          gap: 0;
          height: calc(100vh - 70px);
        }

        /* ── Device Sidebar ── */
        .sidebar {
          background: var(--card-background-color, #fff);
          border-right: 1px solid var(--divider-color, #e0e0e0);
          overflow-y: auto;
          padding: 16px;
        }
        .sidebar-title {
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--secondary-text-color, #727272);
          margin: 0 0 12px;
        }
        #device-list { display: flex; flex-direction: column; gap: 6px; }
        .device-chip {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 12px;
          border-radius: 8px;
          border: 1px solid var(--divider-color, #e0e0e0);
          cursor: pointer;
          transition: background 0.15s, border-color 0.15s;
          background: var(--secondary-background-color, #f5f5f5);
        }
        .device-chip:hover { background: var(--primary-background-color, #eeeeee); }
        .device-chip.active {
          background: #e1f5ee;
          border-color: #1d9e75;
        }
        .device-status-dot {
          width: 8px; height: 8px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .device-status-dot.online { background: #1d9e75; }
        .device-status-dot.offline { background: #e24b4a; }
        .device-id { font-size: 14px; font-weight: 500; flex: 1; }
        .device-rssi { font-size: 11px; color: var(--secondary-text-color, #727272); }
        .empty-hint {
          font-size: 13px;
          color: var(--secondary-text-color, #727272);
          text-align: center;
          padding: 32px 8px;
          line-height: 1.6;
        }
        .empty-hint code {
          background: var(--secondary-background-color, #f0f0f0);
          padding: 2px 6px;
          border-radius: 4px;
          font-size: 12px;
        }

        /* ── Main Control Area ── */
        .main {
          padding: 24px;
          overflow-y: auto;
        }
        .placeholder-msg {
          text-align: center;
          padding: 80px 32px;
          color: var(--secondary-text-color, #727272);
        }
        .placeholder-msg svg { opacity: 0.25; margin-bottom: 16px; }

        #control-panel { display: none; }
        .device-header {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 20px;
        }
        .device-header h2 { margin: 0; font-size: 18px; font-weight: 500; }

        /* ── Tabs ── */
        .tabs {
          display: flex;
          gap: 4px;
          border-bottom: 1px solid var(--divider-color, #e0e0e0);
          margin-bottom: 20px;
        }
        .tab-btn {
          padding: 8px 16px;
          border: none;
          background: none;
          cursor: pointer;
          font-size: 14px;
          color: var(--secondary-text-color, #727272);
          border-bottom: 2px solid transparent;
          margin-bottom: -1px;
          transition: color 0.15s;
          font-family: inherit;
        }
        .tab-btn:hover { color: var(--primary-text-color, #212121); }
        .tab-btn.active {
          color: #1d9e75;
          border-bottom-color: #1d9e75;
          font-weight: 500;
        }

        /* ── Control Cards ── */
        .card {
          background: var(--card-background-color, #fff);
          border: 1px solid var(--divider-color, #e0e0e0);
          border-radius: 12px;
          padding: 20px;
          margin-bottom: 16px;
        }
        .card-title {
          font-size: 13px;
          font-weight: 600;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--secondary-text-color, #727272);
          margin: 0 0 16px;
        }

        label { display: block; font-size: 13px; margin-bottom: 4px; color: var(--secondary-text-color, #727272); }

        input[type="text"], textarea, select {
          width: 100%;
          padding: 9px 12px;
          border: 1px solid var(--divider-color, #e0e0e0);
          border-radius: 8px;
          font-size: 14px;
          font-family: inherit;
          background: var(--primary-background-color, #fff);
          color: var(--primary-text-color, #212121);
          box-sizing: border-box;
          transition: border-color 0.15s;
        }
        input[type="text"]:focus, textarea:focus, select:focus {
          outline: none;
          border-color: #1d9e75;
        }
        textarea { resize: vertical; min-height: 80px; }

        input[type="range"] {
          width: 100%;
          accent-color: #1d9e75;
        }
        input[type="color"] {
          width: 48px;
          height: 36px;
          border: 1px solid var(--divider-color, #e0e0e0);
          border-radius: 8px;
          padding: 2px;
          cursor: pointer;
        }

        .row { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
        .col { flex: 1; min-width: 120px; }

        .checkbox-row { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
        .checkbox-row input { width: auto; accent-color: #1d9e75; }
        .checkbox-row label { margin: 0; }

        .slider-row { display: flex; align-items: center; gap: 12px; }
        .slider-row input[type="range"] { flex: 1; }
        .slider-val { min-width: 36px; text-align: right; font-size: 13px; font-weight: 500; }

        /* ── Buttons ── */
        .btn-row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
        .btn {
          padding: 9px 20px;
          border-radius: 8px;
          border: none;
          cursor: pointer;
          font-size: 14px;
          font-weight: 500;
          font-family: inherit;
          transition: opacity 0.15s, transform 0.1s;
        }
        .btn:hover { opacity: 0.88; }
        .btn:active { transform: scale(0.97); }
        .btn-primary { background: #1d9e75; color: #fff; }
        .btn-secondary { background: var(--secondary-background-color, #f0f0f0); color: var(--primary-text-color, #212121); }
        .btn-danger { background: #e24b4a; color: #fff; }
        .btn-warning { background: #ef9f27; color: #fff; }
        .btn-sm { padding: 6px 14px; font-size: 13px; }

        /* Haptic pattern quick-buttons */
        .pattern-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
          gap: 8px;
          margin-bottom: 16px;
        }
        .pattern-btn {
          padding: 12px 8px;
          border-radius: 8px;
          border: 1px solid var(--divider-color, #e0e0e0);
          background: var(--secondary-background-color, #f5f5f5);
          cursor: pointer;
          font-size: 13px;
          font-weight: 500;
          font-family: inherit;
          text-align: center;
          transition: all 0.15s;
          color: var(--primary-text-color, #212121);
        }
        .pattern-btn:hover {
          border-color: #1d9e75;
          background: #e1f5ee;
          color: #0f6e56;
        }
        .pattern-btn .pattern-icon { font-size: 18px; display: block; margin-bottom: 4px; }

        /* ── LED Color Palette ── */
        .color-palette {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          margin-bottom: 12px;
        }
        .color-swatch {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          cursor: pointer;
          border: 2px solid transparent;
          transition: transform 0.15s, border-color 0.15s;
        }
        .color-swatch:hover { transform: scale(1.15); border-color: #fff; }

        /* ── Feedback ── */
        #feedback {
          font-size: 13px;
          font-weight: 500;
          transition: opacity 0.5s;
          min-height: 20px;
          margin-top: 8px;
        }

        /* ── Broadcast Banner ── */
        .broadcast-card {
          background: linear-gradient(135deg, #085041, #1d9e75);
          border-radius: 12px;
          padding: 20px;
          color: #fff;
          margin-bottom: 20px;
        }
        .broadcast-card h3 { margin: 0 0 4px; font-size: 15px; font-weight: 500; }
        .broadcast-card p { margin: 0 0 12px; font-size: 13px; opacity: 0.8; }
      </style>

      <div class="page-header">
        <div class="chip-icon">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M9 2H15V4H17V2H19V4H21V6H19V8H21V10H19V12H17V14H15V16H9V14H7V12H5V10H3V8H5V6H3V4H5V2H7V4H9V2ZM9 6V14H15V6H9ZM11 8H13V12H11V8Z"/>
            <path d="M7 18H10V20H7V22H5V20H2V18H5V16H7V18ZM17 18H14V16H17V18H20V20H17V22H15V20H12V18H14V20H17V18Z"/>
          </svg>
        </div>
        <div>
          <h1>ESP32 Commander</h1>
          <p class="subtitle">MQTT device control panel</p>
        </div>
        <div style="margin-left: auto; display: flex; align-items: center; gap: 8px;">
          <span id="feedback"></span>
        </div>
      </div>

      <div class="layout">
        <aside class="sidebar">
          <p class="sidebar-title">Devices</p>
          <div id="device-list">
            <p class="empty-hint">Waiting for devices…</p>
          </div>
        </aside>

        <main class="main">
          <!-- Placeholder shown before device selected -->
          <div id="placeholder" style="display:block">
            <div class="broadcast-card">
              <h3>Broadcast to all devices</h3>
              <p>Send a command to every connected ESP32 at once.</p>
              <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <button class="btn btn-sm" style="background:rgba(255,255,255,0.2);color:#fff;border:1px solid rgba(255,255,255,0.3);" id="bcast-led-on">All LEDs ON</button>
                <button class="btn btn-sm" style="background:rgba(255,255,255,0.2);color:#fff;border:1px solid rgba(255,255,255,0.3);" id="bcast-led-off">All LEDs OFF</button>
                <button class="btn btn-sm" style="background:rgba(255,255,255,0.2);color:#fff;border:1px solid rgba(255,255,255,0.3);" id="bcast-haptic">Haptic All</button>
              </div>
            </div>
            <div class="placeholder-msg">
              <svg width="64" height="64" viewBox="0 0 24 24" fill="var(--secondary-text-color)">
                <path d="M9 2H15V4H17V2H19V4H21V6H19V8H21V10H19V12H17V14H15V16H9V14H7V12H5V10H3V8H5V6H3V4H5V2H7V4H9V2ZM9 6V14H15V6H9ZM11 8H13V12H11V8Z"/>
              </svg>
              <p>Select a device from the sidebar<br>to start sending commands.</p>
            </div>
          </div>

          <!-- Per-device control panel -->
          <div id="control-panel">
            <div class="device-header">
              <div class="device-status-dot online" id="ctrl-status-dot"></div>
              <h2 id="selected-device-name">—</h2>
            </div>

            <div class="tabs">
              <button class="tab-btn active" data-tab="message">Message</button>
              <button class="tab-btn" data-tab="led">LED</button>
              <button class="tab-btn" data-tab="haptic">Haptic</button>
              <button class="tab-btn" data-tab="raw">Raw</button>
            </div>

            <!-- Message Tab -->
            <div class="tab-pane" data-tab="message" style="display:block">
              <div class="card">
                <p class="card-title">Display Message</p>
                <label>Message text</label>
                <textarea id="msg-text" placeholder="Enter text to display on ESP32…"></textarea>
                <div class="row" style="margin-top: 12px;">
                  <div class="col">
                    <label>Duration (seconds)</label>
                    <input type="text" id="msg-duration" value="5" style="width:80px" />
                  </div>
                  <div class="col" style="flex:2">
                    <label>Quick messages</label>
                    <div style="display:flex;gap:6px;flex-wrap:wrap;">
                      <button class="btn btn-secondary btn-sm" data-quick="Hello!">Hello!</button>
                      <button class="btn btn-secondary btn-sm" data-quick="Alert!">Alert!</button>
                      <button class="btn btn-secondary btn-sm" data-quick="Stand by">Stand by</button>
                      <button class="btn btn-secondary btn-sm" data-quick="Ready">Ready</button>
                    </div>
                  </div>
                </div>
                <div class="checkbox-row" style="margin-top:12px">
                  <input type="checkbox" id="msg-scroll" />
                  <label for="msg-scroll">Scroll text</label>
                </div>
                <div class="btn-row">
                  <button class="btn btn-primary" id="btn-send-msg">Send Message</button>
                  <button class="btn btn-secondary" id="btn-clear-msg">Clear Display</button>
                </div>
              </div>
            </div>

            <!-- LED Tab -->
            <div class="tab-pane" data-tab="led" style="display:none">
              <div class="card">
                <p class="card-title">LED Control</p>
                <label>Quick color presets</label>
                <div class="color-palette" id="color-palette"></div>

                <div class="row">
                  <div class="col">
                    <label>Color picker</label>
                    <input type="color" id="led-color" value="#ffffff" />
                  </div>
                  <div class="col">
                    <label>Effect</label>
                    <select id="led-effect">
                      <option value="solid">Solid</option>
                      <option value="blink">Blink</option>
                      <option value="pulse">Pulse</option>
                      <option value="rainbow">Rainbow</option>
                    </select>
                  </div>
                </div>

                <div style="margin-top:16px">
                  <label>Brightness</label>
                  <div class="slider-row">
                    <input type="range" id="led-brightness" min="0" max="255" value="255"
                      oninput="this.parentElement.querySelector('.slider-val').textContent=this.value" />
                    <span class="slider-val">255</span>
                  </div>
                </div>

                <div class="btn-row">
                  <button class="btn btn-primary" id="btn-led-on">Turn ON</button>
                  <button class="btn btn-danger" id="btn-led-off">Turn OFF</button>
                </div>
              </div>
            </div>

            <!-- Haptic Tab -->
            <div class="tab-pane" data-tab="haptic" style="display:none">
              <div class="card">
                <p class="card-title">Haptic Motor</p>
                <label style="margin-bottom:10px">Pattern</label>
                <div class="pattern-grid">
                  <button class="pattern-btn" data-pattern="short"><span class="pattern-icon">▪</span>Short</button>
                  <button class="pattern-btn" data-pattern="long"><span class="pattern-icon">▬</span>Long</button>
                  <button class="pattern-btn" data-pattern="double"><span class="pattern-icon">▪▪</span>Double</button>
                  <button class="pattern-btn" data-pattern="sos"><span class="pattern-icon">···−−−···</span>SOS</button>
                </div>
                <input type="hidden" id="haptic-pattern" value="short" />

                <div class="row">
                  <div class="col">
                    <label>Duration (ms)</label>
                    <input type="text" id="haptic-duration" value="200" style="width:90px" />
                  </div>
                  <div class="col">
                    <label>Repeat</label>
                    <input type="text" id="haptic-repeat" value="1" style="width:60px" />
                  </div>
                </div>

                <div style="margin-top:16px">
                  <label>Intensity</label>
                  <div class="slider-row">
                    <input type="range" id="haptic-intensity" min="0" max="255" value="200"
                      oninput="this.parentElement.querySelector('.slider-val').textContent=this.value" />
                    <span class="slider-val">200</span>
                  </div>
                </div>

                <div class="btn-row">
                  <button class="btn btn-primary" id="btn-haptic-fire">Fire Pattern</button>
                </div>
              </div>
            </div>

            <!-- Raw Command Tab -->
            <div class="tab-pane" data-tab="raw" style="display:none">
              <div class="card">
                <p class="card-title">Raw MQTT Command</p>
                <label>Action (topic suffix)</label>
                <input type="text" id="raw-action" placeholder="e.g. buzzer, display, custom" />
                <div style="margin-top:12px">
                  <label>JSON Payload</label>
                  <textarea id="raw-payload" placeholder='{"key": "value"}'
                    style="font-family:monospace;font-size:13px;min-height:120px"></textarea>
                </div>
                <div class="btn-row">
                  <button class="btn btn-primary" id="btn-raw-send">Send Raw</button>
                </div>
              </div>
            </div>

          </div>
        </main>
      </div>
    `;

    this._attachEventListeners();
    this._buildColorPalette();
  }

  _buildColorPalette() {
    const colors = [
      "#ffffff", "#ff0000", "#00ff00", "#0000ff",
      "#ffff00", "#ff6600", "#ff00ff", "#00ffff",
      "#ff8800", "#8800ff",
    ];
    const palette = this.shadowRoot.getElementById("color-palette");
    if (!palette) return;
    palette.innerHTML = colors.map(c => `
      <div class="color-swatch" style="background:${c};" data-color="${c}" title="${c}"></div>
    `).join("");
    palette.querySelectorAll(".color-swatch").forEach(sw => {
      sw.addEventListener("click", () => {
        const picker = this.shadowRoot.getElementById("led-color");
        if (picker) picker.value = sw.dataset.color;
      });
    });
  }

  _attachEventListeners() {
    const root = this.shadowRoot;

    // Tabs
    root.querySelectorAll(".tab-btn").forEach(btn => {
      btn.addEventListener("click", () => this._setTab(btn.dataset.tab));
    });

    // Message tab
    root.getElementById("btn-send-msg")?.addEventListener("click", () => this._sendMessage());
    root.getElementById("btn-clear-msg")?.addEventListener("click", () => {
      if (!this._selectedDevice) return this._showFeedback("Select a device first", "warn");
      this._callService("send_message", { device_id: this._selectedDevice, message: "", duration: 1 });
    });
    root.querySelectorAll("[data-quick]").forEach(btn => {
      btn.addEventListener("click", () => {
        const ta = root.getElementById("msg-text");
        if (ta) ta.value = btn.dataset.quick;
      });
    });

    // LED tab
    root.getElementById("btn-led-on")?.addEventListener("click", () => this._setLed(true));
    root.getElementById("btn-led-off")?.addEventListener("click", () => this._setLed(false));

    // Haptic tab
    root.querySelectorAll(".pattern-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        root.querySelectorAll(".pattern-btn").forEach(b => b.style.borderColor = "");
        btn.style.borderColor = "#1d9e75";
        const hidden = root.getElementById("haptic-pattern");
        if (hidden) hidden.value = btn.dataset.pattern;
      });
    });
    root.getElementById("btn-haptic-fire")?.addEventListener("click", () => this._triggerHaptic());

    // Raw tab
    root.getElementById("btn-raw-send")?.addEventListener("click", () => {
      if (!this._selectedDevice) return this._showFeedback("Select a device first", "warn");
      const action = root.getElementById("raw-action").value.trim();
      let payload;
      try { payload = JSON.parse(root.getElementById("raw-payload").value); }
      catch { return this._showFeedback("Invalid JSON payload", "error"); }
      if (!action) return this._showFeedback("Enter an action", "warn");
      this._callService("send_raw", { device_id: this._selectedDevice, action, payload });
    });

    // Broadcast buttons
    root.getElementById("bcast-led-on")?.addEventListener("click", () => {
      Object.keys(this._devices).forEach(id =>
        this._hass?.callService("esp32_commander", "set_led", { device_id: id, state: true, brightness: 255, red: 255, green: 255, blue: 255, effect: "solid" })
      );
      this._showFeedback("Broadcast: LEDs ON", "success");
    });
    root.getElementById("bcast-led-off")?.addEventListener("click", () => {
      Object.keys(this._devices).forEach(id =>
        this._hass?.callService("esp32_commander", "set_led", { device_id: id, state: false, brightness: 0, red: 0, green: 0, blue: 0, effect: "solid" })
      );
      this._showFeedback("Broadcast: LEDs OFF", "success");
    });
    root.getElementById("bcast-haptic")?.addEventListener("click", () => {
      Object.keys(this._devices).forEach(id =>
        this._hass?.callService("esp32_commander", "trigger_haptic", { device_id: id, pattern: "short", intensity: 200, duration_ms: 200, repeat: 1 })
      );
      this._showFeedback("Broadcast: Haptic sent", "success");
    });
  }
}

customElements.define("esp32-commander-panel", ESP32CommanderPanel);
