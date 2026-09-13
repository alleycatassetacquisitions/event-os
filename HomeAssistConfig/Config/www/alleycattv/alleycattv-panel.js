/**
 * AlleycatTV Panel
 * Home Assistant custom panel for controlling the AlleycatTV video distribution system.
 *
 * Place this file at:
 *   config/www/alleycattv/alleycattv-panel.js
 *
 * Register in configuration.yaml — see docs/setup.md
 */

class AlleycatTVPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._devices = {};       // pi_id → device object
    this._zones = {};         // zone_id → { name, pis: [] }
    this._selectedZone = null;
    this._eventUnsubscribe = null;
    this._serverUrl = null;
    this._contentFiles = [];
    this._initialized = false;
    this._areas = [];
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) {
      this._initialized = true;
      this._serverUrl = this._resolveServerUrl();
      this._render();
      this._initAsync();
    }
  }

  set panel(p) {
    this._panel = p;
    this._serverUrl = this._resolveServerUrl();
  }

  connectedCallback() {
    if (this._hass && !this._initialized) {
      this._initialized = true;
      this._serverUrl = this._resolveServerUrl();
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

  _resolveServerUrl() {
    return (this._serverUrl || "http://headless-alleycat-streaming-server.local").replace(/\/$/, "");
  }

  async _loadDirectoryUrl() {
    const fallback = this._panel?.config?.server_url
      || "http://headless-alleycat-streaming-server.local";
    if (window.AlleycatDirectory && this._hass) {
      this._serverUrl = await window.AlleycatDirectory.getUrl(this._hass, "alleycattv", fallback);
    } else if (!this._serverUrl) {
      this._serverUrl = String(fallback).replace(/\/$/, "");
    }
  }

  _openServerUrlDialog() {
    const dlg = this.shadowRoot.getElementById("server-url-dialog");
    const inp = this.shadowRoot.getElementById("server-url-input");
    if (!dlg || !inp) return;
    inp.value = this._serverUrl || "";
    dlg.style.display = "flex";
    inp.focus();
    inp.select();
  }

  async _initAsync() {
    await this._loadDirectoryUrl();
    await this._fetchServerZones();
    await this._loadDevices();
    await this._loadAreas();
    await this._subscribeToEvents();
    await this._loadContent();
    this._buildZones();
    this._renderZoneList();
  }

  // ── Server API helpers ────────────────────────────────────────────────────

  async _apiGet(path) {
    const resp = await fetch(`${this._serverUrl}${path}`);
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    return resp.json();
  }

  async _apiPost(path, body) {
    const resp = await fetch(`${this._serverUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    return resp.json();
  }

  async _apiDelete(path) {
    const resp = await fetch(`${this._serverUrl}${path}`, { method: "DELETE" });
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    return resp.json();
  }

  // ── Data loading ──────────────────────────────────────────────────────────

  async _loadDevices() {
    if (!this._hass) return;
    try {
      const result = await this._hass.connection.sendMessagePromise({
        type: "alleycattv/list_devices",
      });
      (result.devices || []).forEach(d => {
        if (d?.pi_id) this._devices[d.pi_id] = d;
      });
      this._mergeDevicesFromHassStates();
      console.info("[AlleycatTV] Loaded", Object.keys(this._devices).length, "device(s)");
    } catch (err) {
      console.warn("[AlleycatTV] Could not load device list:", err);
    }
  }

  async _loadAreas() {
    if (!this._hass) return;
    try {
      const result = await this._hass.connection.sendMessagePromise({
        type: "alleycattv/list_areas",
      });
      this._areas = result.areas || [];
    } catch (err) {
      console.warn("[AlleycatTV] Could not load HA Areas:", err);
    }
  }

  async _setPiArea(piId, areaId) {
    try {
      await this._hass.connection.sendMessagePromise({
        type: "alleycattv/set_placement",
        pi_id: piId,
        area_id: areaId,
      });
      if (this._devices[piId]) this._devices[piId].area_id = areaId;
      this._showFeedback("Location saved", "success");
    } catch (err) {
      this._showFeedback(`Location failed: ${err.message || err}`, "error");
    }
  }

  async _subscribeToEvents() {
    if (!this._hass || this._eventUnsubscribe) return;
    try {
      this._eventUnsubscribe = await this._hass.connection.subscribeEvents(
        (event) => {
          const d = event.data;
          if (!d || !d.pi_id) return;
          this._devices[d.pi_id] = { ...this._devices[d.pi_id], ...d };
          this._buildZones();
          this._renderZoneList();
          if (this._selectedZone) this._renderZoneDetail(this._selectedZone);
        },
        "alleycattv_device_update"
      );
    } catch (err) {
      console.warn("[AlleycatTV] Could not subscribe to events:", err);
    }
  }

  _mergeDevicesFromHassStates() {
    const states = this._hass?.states;
    if (!states || typeof states !== "object") return;
    Object.values(states).forEach((s) => {
      if (!s?.entity_id || !String(s.entity_id).startsWith("media_player.")) return;
      const pi = s.attributes?.pi_id;
      if (!pi) return;
      const zone = s.attributes?.broadcast_zone || s.attributes?.zone || "";
      const existing = this._devices[pi] || {};
      this._devices[pi] = {
        ...existing,
        pi_id: pi,
        zone: existing.zone || zone,
        broadcast_zone: existing.broadcast_zone || zone,
        state: existing.state || s.state,
        current_file: existing.current_file || s.attributes?.media_title || s.attributes?.current_file,
        next_file: existing.next_file || s.attributes?.next_file,
        online: existing.online !== undefined ? existing.online : s.state !== "unavailable",
        area_id: existing.area_id || "",
      };
    });
  }

  _normZone(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, "-");
  }

  _resolveDeviceZoneId(device) {
    const raw = String(device.zone || device.broadcast_zone || "").trim();
    if (!raw) return "unassigned";
    const server = this._serverZones || {};
    if (server[raw]) return raw;
    const needle = this._normZone(raw);
    const match = Object.values(server).find(
      (z) => this._normZone(z.zone_id) === needle || this._normZone(z.name) === needle
    );
    return match ? match.zone_id : raw;
  }

  async _fetchServerZones() {
    try {
      const raw = await this._apiGet("/api/zones");
      const zones = Array.isArray(raw) ? raw : Array.isArray(raw?.zones) ? raw.zones : [];
      this._serverZones = this._serverZones || {};
      zones.forEach((z) => {
        if (z?.zone_id) this._serverZones[z.zone_id] = z;
      });
      console.info("[AlleycatTV] Loaded", zones.length, "server zone(s)");
    } catch (err) {
      console.warn("[AlleycatTV] Could not fetch server zones:", err);
    }
  }

  async _loadContent() {
    try {
      const resp = await fetch(`${this._serverUrl}/api/content/?base_url=${encodeURIComponent(this._serverUrl)}`);
      if (resp.ok) {
        this._contentFiles = await resp.json();
        this._populateFilePicker();
        console.info("[AlleycatTV] Loaded", this._contentFiles.length, "content files");
      }
    } catch (err) {
      console.warn("[AlleycatTV] Could not load content from server:", err);
    }
  }

  _buildZones() {
    const zones = {};
    // Seed from server-defined zones first so they show even without Pis
    Object.values(this._serverZones || {}).forEach(z => {
      zones[z.zone_id] = { zone_id: z.zone_id, name: z.name, pis: [] };
    });
    // Overlay Pi device reports
    Object.values(this._devices).forEach(d => {
      if (!d?.pi_id) return;
      const z = this._resolveDeviceZoneId(d);
      if (!zones[z]) zones[z] = { zone_id: z, name: z, pis: [] };
      const existing = zones[z].pis.findIndex(p => p.pi_id === d.pi_id);
      if (existing >= 0) zones[z].pis[existing] = d;
      else zones[z].pis.push(d);
    });
    this._zones = zones;
  }

  _missingPiHint(zoneId) {
    const reports = Object.values(this._devices)
      .filter((d) => d?.pi_id)
      .map((d) => `${d.pi_id} (MQTT zone: ${d.zone || d.broadcast_zone || "none"})`);
    if (!reports.length) {
      return "No Pis have reported in via MQTT yet. Zone Play/Stop still goes out on the zone topic.";
    }
    return `No Pi matched zone id "${zoneId}". Reporting: ${reports.join("; ")}`;
  }

  async _createZone(zoneId, zoneName) {
    try {
      await this._apiPost("/api/zones", { zone_id: zoneId, name: zoneName || zoneId });
      if (!this._serverZones) this._serverZones = {};
      this._serverZones[zoneId] = { zone_id: zoneId, name: zoneName || zoneId };
      this._buildZones();
      this._renderZoneList();
      this._showFeedback(`Zone "${zoneId}" created`, "success");
    } catch (err) {
      this._showFeedback(`Failed to create zone: ${err.message}`, "error");
    }
  }

  async _deleteZone(zoneId) {
    if (!confirm(`Delete zone "${zoneId}"? This cannot be undone.`)) return;
    try {
      await this._apiDelete(`/api/zones/${encodeURIComponent(zoneId)}`);
      delete this._serverZones?.[zoneId];
      delete this._zones[zoneId];
      if (this._selectedZone === zoneId) {
        this._selectedZone = null;
        this.shadowRoot.getElementById("zone-detail").style.display = "none";
        this.shadowRoot.getElementById("main-placeholder").style.display = "block";
      }
      this._renderZoneList();
      this._showFeedback(`Zone "${zoneId}" deleted`, "success");
    } catch (err) {
      this._showFeedback(`Failed to delete zone: ${err.message}`, "error");
    }
  }

  // ── Service calls ─────────────────────────────────────────────────────────

  async _callService(service, data) {
    if (!this._hass) return;
    try {
      await this._hass.callService("alleycattv", service, data);
      this._showFeedback(`✓ ${service.replace(/_/g, " ")}`, "success");
    } catch (err) {
      this._showFeedback(`✗ ${err.message}`, "error");
    }
  }

  _playZone(zone_id) {
    this._callService("play_zone", { zone_id });
  }

  _stopZone(zone_id) {
    this._callService("stop_zone", { zone_id });
  }

  _interruptZone(zone_id) {
    const url = this._buildInterruptUrl(this._getSelectedFileUrl(), "file-picker");
    if (!url) return this._showFeedback("Select an announcement file first", "warn");
    this._callService("interrupt_zone", { zone_id, file_url: url });
  }

  _startZoneBroadcast(zone_id) {
    const base = this._getSelectedFileUrl();
    if (!base) return this._showFeedback("Select an RTSP source first", "warn");
    const url = `${base.split("#")[0]}#acv_hold=1`;
    this._callService("interrupt_zone", { zone_id, file_url: url });
  }

  _stopZoneBroadcast(zone_id) {
    this._callService("play_zone", { zone_id });
  }

  _interruptPi(pi_id) {
    const url = this._buildInterruptUrl(this._getSelectedFileUrl(), "file-picker");
    if (!url) return this._showFeedback("Select an announcement file first", "warn");
    this._callService("interrupt_pi", { pi_id, file_url: url });
  }

  _reloadPlaylist(zone_id) {
    this._callService("reload_playlist", { zone_id });
  }

  _setVolume(zone_id, volume) {
    this._callService("set_volume_zone", { zone_id, volume: parseInt(volume) });
  }

  // ── Content picker helpers ────────────────────────────────────────────────

  _getSelectedFileUrl() {
    const sel = this.shadowRoot.getElementById("file-picker");
    return sel ? sel.value : "";
  }

  _announcementItems() {
    return this._contentFiles.filter(f =>
      f.media_type === "announcement" ||
      f.media_type === "rtsp" ||
      (f.media_type === "webpage" && f.entry_id)
    );
  }

  _getAnnouncementByUrl(url) {
    const bare = (url || "").split("#")[0];
    return this._announcementItems().find(f => this._announcementOptionValue(f) === bare);
  }

  _isRtspSelection(url) {
    const f = this._getAnnouncementByUrl(url);
    if (f?.media_type === "rtsp") return true;
    return /^(rtsp|rtsps):\/\//i.test((url || "").split("#")[0]);
  }

  _isVideoAnnouncementUrl(url) {
    const path = (url || "").split("?")[0].split("#")[0].toLowerCase();
    return /\.(mp4|mkv|avi|mov)$/.test(path);
  }

  _announcementOptionValue(f) {
    return (f.url || "").split("#")[0];
  }

  _announcementOptionLabel(f) {
    if (f.media_type === "rtsp") return `${f.filename || "Live RTSP"} (stream)`;
    return f.filename || f.url || "announcement";
  }

  _getInterruptDurationPicker(pickerId) {
    const sel = this.shadowRoot.getElementById(`${pickerId}-duration`);
    return sel ? sel.value : "30";
  }

  _buildInterruptUrl(baseUrl, pickerId = "file-picker") {
    if (!baseUrl) return "";
    let url = baseUrl.split("#")[0];
    if (this._isRtspSelection(url)) {
      return `${url}#acv_hold=1`;
    }
    const mode = this._getInterruptDurationPicker(pickerId);

    if (this._isVideoAnnouncementUrl(url)) {
      if (mode === "hold") return `${url}#acv_hold=1`;
      return url;
    }
    if (mode === "hold") return `${url}#acv_hold=1`;
    if (mode === "custom") {
      const sec = parseInt(prompt("Display duration (seconds):", "30") || "30", 10);
      return `${url}#acv_duration=${sec > 0 ? sec : 30}`;
    }
    return `${url}#acv_duration=${mode}`;
  }

  _interruptDurationOptions() {
    return `
      <option value="30">30 seconds (default)</option>
      <option value="15">15 seconds</option>
      <option value="60">60 seconds</option>
      <option value="90">90 seconds</option>
      <option value="custom">Custom…</option>
      <option value="hold">Until stopped (Play/Stop)</option>`;
  }

  _populateFilePicker() {
    const announcements = this._announcementItems();
    const options = `<option value="">-- select announcement --</option>` +
      announcements.map(f =>
        `<option value="${this._announcementOptionValue(f)}" data-media-type="${f.media_type || ""}">${this._escHtml(this._announcementOptionLabel(f))}</option>`
      ).join("");
    ["file-picker", "file-picker-global"].forEach(id => {
      const sel = this.shadowRoot.getElementById(id);
      if (sel) sel.innerHTML = options;
    });
    this._syncInterruptUi("file-picker");
    this._syncInterruptUi("file-picker-global");
  }

  _escHtml(v) {
    return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  }

  _syncInterruptUi(pickerId) {
    const root = this.shadowRoot;
    const sel = root.getElementById(pickerId);
    if (!sel) return;
    const isRtsp = this._isRtspSelection(sel.value);
    const isGlobal = pickerId === "file-picker-global";

    const durationEl = root.getElementById(`${pickerId}-duration`);
    const durationWrap = root.getElementById(`${pickerId}-duration-wrap`);
    if (durationEl) durationEl.style.display = isRtsp ? "none" : "";
    if (durationWrap) durationWrap.style.display = isRtsp ? "none" : "";

    if (isGlobal) {
      const volWrap = root.getElementById("bcast-rtsp-volume-wrap");
      const startBtn = root.getElementById("bcast-start");
      const stopBtn = root.getElementById("bcast-stop");
      const interruptBtn = root.getElementById("bcast-interrupt");
      if (volWrap) volWrap.style.display = isRtsp ? "flex" : "none";
      if (startBtn) startBtn.style.display = isRtsp ? "" : "none";
      if (stopBtn) stopBtn.style.display = isRtsp ? "" : "none";
      if (interruptBtn) interruptBtn.style.display = isRtsp ? "none" : "";
    } else {
      const startBtn = root.getElementById("btn-rtsp-start");
      const stopBtn = root.getElementById("btn-rtsp-stop");
      const interruptBtn = root.getElementById("btn-interrupt");
      const hint = root.getElementById("interrupt-hint");
      if (startBtn) startBtn.style.display = isRtsp ? "" : "none";
      if (stopBtn) stopBtn.style.display = isRtsp ? "" : "none";
      if (interruptBtn) interruptBtn.style.display = isRtsp ? "none" : "";
      if (hint) {
        hint.textContent = isRtsp
          ? "Live RTSP plays until you press Stop broadcasting (resumes the playlist)."
          : "Photos and scoreboards use the duration above (default 30s). Videos play in full. \"Until stopped\" stays on screen until you press Play or Stop.";
      }
    }
  }

  async _broadcastStartRtsp() {
    const sel = this.shadowRoot.getElementById("file-picker-global");
    const base = sel ? sel.value : "";
    if (!base) return this._showFeedback("Select an RTSP source", "warn");
    const url = `${base.split("#")[0]}#acv_hold=1`;
    const vol = parseInt(this.shadowRoot.getElementById("bcast-rtsp-volume")?.value || "80", 10);
    const zones = Object.keys(this._zones);
    if (!zones.length) return this._showFeedback("No zones available", "warn");
    for (const zid of zones) {
      await this._hass?.callService("alleycattv", "set_volume_zone", { zone_id: zid, volume: vol });
      await this._hass?.callService("alleycattv", "interrupt_zone", { zone_id: zid, file_url: url });
    }
    this._showFeedback(`Live RTSP started on ${zones.length} zone(s)`, "success");
  }

  async _broadcastStopRtsp() {
    const zones = Object.keys(this._zones);
    for (const zid of zones) {
      await this._hass?.callService("alleycattv", "play_zone", { zone_id: zid });
    }
    this._showFeedback("Broadcasting stopped — playlists resumed", "success");
  }

  // ── Feedback ──────────────────────────────────────────────────────────────

  _showFeedback(msg, type = "info") {
    const el = this.shadowRoot.getElementById("feedback");
    if (!el) return;
    const colors = { success: "#1d9e75", error: "#e24b4a", warn: "#ef9f27", info: "#378add" };
    el.textContent = msg;
    el.style.color = colors[type] || colors.info;
    el.style.opacity = "1";
    clearTimeout(this._feedbackTimer);
    this._feedbackTimer = setTimeout(() => { el.style.opacity = "0"; }, 3500);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  _renderZoneList() {
    const container = this.shadowRoot.getElementById("zone-list");
    if (!container) return;
    const zoneIds = Object.keys(this._zones);
    if (zoneIds.length === 0) {
      container.innerHTML = `<p class="empty-hint">Waiting for devices…<br><span>Pis publish to <code>alleycattv/pi/{id}/status</code></span></p>`;
      return;
    }
    container.innerHTML = zoneIds.map(zid => {
      const z = this._zones[zid];
      const total = z.pis.length;
      const onlineCount = z.pis.filter(p => p.online !== false).length;
      const allPlaying = total > 0 && z.pis.every(p => p.state === "playing");
      const isEmpty = total === 0;
      const dotClass = allPlaying ? "playing" : onlineCount > 0 ? "online" : "offline";
      const subLabel = isEmpty ? "no devices" : `${onlineCount}/${total} online`;
      return `
        <div class="zone-chip ${this._selectedZone === zid ? "active" : ""} ${isEmpty ? "zone-empty" : ""}" data-zone="${zid}">
          <span class="zone-dot ${isEmpty ? "empty" : dotClass}"></span>
          <div class="zone-info">
            <span class="zone-name">${z.name || zid}</span>
            <span class="zone-sub">${subLabel}</span>
          </div>
        </div>`;
    }).join("");
    container.querySelectorAll(".zone-chip").forEach(chip => {
      chip.addEventListener("click", () => {
        this._selectedZone = chip.dataset.zone;
        this._renderZoneList();
        this._renderZoneDetail(chip.dataset.zone);
        this.shadowRoot.getElementById("main-placeholder").style.display = "none";
        this.shadowRoot.getElementById("zone-detail").style.display = "block";
      });
    });
  }

  _renderZoneDetail(zone_id) {
    const detail = this.shadowRoot.getElementById("zone-detail");
    if (!detail) return;
    const zone = this._zones[zone_id];
    if (!zone) return;

    const serverZone = (this._serverZones || {})[zone_id];
    detail.querySelector("#zone-title").textContent = serverZone?.name || zone_id;

    const playingPis = (zone.pis || []).filter(p => p.online !== false && p.state === "playing");
    const summaryPi = playingPis[0] || (zone.pis || []).find(p => p.online !== false);
    const nowEl = detail.querySelector("#now-playing-summary");
    const noPis = !(zone.pis || []).length;
    const hint = noPis ? this._missingPiHint(zone_id) : "";
    if (nowEl) {
      if (noPis) {
        nowEl.innerHTML = `<p class="playback-idle">${hint}</p>`;
      } else if (summaryPi && summaryPi.current_file) {
        nowEl.innerHTML = `
          <div class="playback-row"><span class="playback-label">Now Playing</span><span class="playback-value">${summaryPi.current_file}</span></div>
          <div class="playback-row"><span class="playback-label">Up Next</span><span class="playback-value">${summaryPi.next_file || "—"}</span></div>`;
      } else {
        nowEl.innerHTML = `<p class="playback-idle">${summaryPi ? "Nothing playing" : "No devices online in this zone"}</p>`;
      }
    }

    const pis = this.shadowRoot.getElementById("pi-cards");
    if (!pis) return;
    if (noPis) {
      pis.classList.add("is-empty");
      pis.innerHTML = `<div class="empty-hint">${hint}</div>`;
      return;
    }
    pis.classList.remove("is-empty");
    pis.innerHTML = (zone.pis || []).map(d => {
      const online  = d.online !== false;
      const stateLabel = d.state || "unknown";
      const stateClass = stateLabel === "playing" ? "state-playing"
                       : stateLabel === "interrupted" ? "state-interrupted"
                       : "state-stopped";
      return `
        <div class="pi-card ${online ? "" : "pi-offline"}">
          <div class="pi-header">
            <span class="status-dot ${online ? "online" : "offline"}"></span>
            <strong>${d.pi_id}</strong>
            <span class="pi-state ${stateClass}">${stateLabel}</span>
          </div>
          <div class="pi-meta">
            ${d.ip ? `<span>IP: ${d.ip}</span>` : ""}
            ${d.current_file ? `<span><strong>Now:</strong> ${d.current_file}</span>` : ""}
            ${d.next_file ? `<span><strong>Next:</strong> ${d.next_file}</span>` : ""}
            <label class="pi-area">Location
              <select class="pi-area-select" data-pi="${d.pi_id}">
                <option value="">— none —</option>
                ${(this._areas || []).map((a) =>
                  `<option value="${a.area_id}" ${d.area_id === a.area_id ? "selected" : ""}>${a.name}</option>`
                ).join("")}
              </select>
            </label>
          </div>
          <div class="pi-actions">
            <button class="btn btn-sm btn-warning pi-interrupt" data-pi="${d.pi_id}" title="Play an announcement on this display">Interrupt</button>
          </div>
        </div>`;
    }).join("");

    pis.querySelectorAll(".pi-interrupt").forEach(btn => {
      btn.addEventListener("click", () => this._interruptPi(btn.dataset.pi));
    });
    pis.querySelectorAll(".pi-area-select").forEach(sel => {
      sel.addEventListener("change", () => this._setPiArea(sel.dataset.pi, sel.value));
    });

    const volInput = this.shadowRoot.getElementById("vol-slider");
    if (volInput) {
      volInput.dataset.zone = zone_id;
    }
  }

  _render() {
    this.shadowRoot.innerHTML = `
      <link rel="stylesheet" href="/local/alleycattv/alleycat-panel.css">
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
        .page-header h1 { margin: 0; font-size: 20px; font-weight: 500; }
        .page-header .subtitle { font-size: 13px; color: var(--secondary-text-color, #727272); margin: 0; }
        .brand-icon {
          width: 36px; height: 36px;
          background: linear-gradient(135deg, #1d5fa8, #1d9e75);
          border-radius: 8px;
          display: flex; align-items: center; justify-content: center;
        }
        .brand-icon svg { width: 22px; height: 22px; fill: #fff; }
        #feedback {
          font-size: 13px; font-weight: 500;
          transition: opacity 0.5s; min-height: 20px; margin-left: auto;
        }
        .btn-settings {
          background: none; border: 1px solid var(--divider-color, #e0e0e0);
          border-radius: 8px; padding: 6px 10px; cursor: pointer;
          font-size: 16px; color: var(--secondary-text-color, #727272);
          line-height: 1; transition: background 0.15s;
        }
        .btn-settings:hover { background: var(--secondary-background-color, #f0f0f0); }

        /* ── Server URL dialog ── */
        .url-dialog-overlay {
          display: none; position: fixed; inset: 0;
          background: rgba(0,0,0,0.5); z-index: 9999;
          align-items: center; justify-content: center;
        }
        .url-dialog {
          background: var(--card-background-color, #fff);
          border-radius: 14px; padding: 28px 32px; min-width: 360px; max-width: 90vw;
          box-shadow: 0 8px 32px rgba(0,0,0,0.25);
        }
        .url-dialog h3 { margin: 0 0 6px; font-size: 16px; font-weight: 600; }
        .url-dialog p  { margin: 0 0 16px; font-size: 13px; color: var(--secondary-text-color, #727272); }
        .url-dialog input {
          width: 100%; padding: 10px 12px; border-radius: 8px;
          border: 1px solid var(--divider-color, #e0e0e0);
          font-size: 14px; font-family: inherit;
          background: var(--primary-background-color, #fff);
          color: var(--primary-text-color, #212121);
          box-sizing: border-box; margin-bottom: 16px;
        }
        .url-dialog .url-dialog-hint {
          font-size: 11px; color: var(--secondary-text-color, #9e9e9e);
          margin: -10px 0 14px; line-height: 1.4;
        }
        .url-dialog-actions { display: flex; gap: 10px; justify-content: flex-end; }

        .layout {
          display: grid;
          grid-template-columns: 260px 1fr;
          height: calc(100vh - 70px);
        }

        /* ── Sidebar ── */
        .sidebar {
          background: var(--card-background-color, #fff);
          border-right: 1px solid var(--divider-color, #e0e0e0);
          overflow-y: auto;
          padding: 16px;
        }
        .sidebar-header {
          display: flex; align-items: center; justify-content: space-between;
          margin-bottom: 12px;
        }
        .sidebar-title {
          font-size: 11px; font-weight: 600; letter-spacing: 0.08em;
          text-transform: uppercase; color: var(--secondary-text-color, #727272);
          margin: 0;
        }
        .btn-icon {
          width: 26px; height: 26px; border-radius: 6px; border: none;
          background: #1d5fa8; color: #fff; font-size: 18px; line-height: 1;
          cursor: pointer; display: flex; align-items: center; justify-content: center;
          padding: 0;
        }
        .btn-icon:hover { opacity: 0.85; }
        #new-zone-form input {
          width: 100%; padding: 8px 10px; border-radius: 6px;
          border: 1px solid var(--divider-color, #e0e0e0);
          font-size: 13px; font-family: inherit;
          background: var(--primary-background-color, #fff);
          color: var(--primary-text-color, #212121);
          box-sizing: border-box; display: block;
        }
        #zone-list { display: flex; flex-direction: column; gap: 6px; }
        .zone-chip {
          display: flex; align-items: center; gap: 10px;
          padding: 10px 12px; border-radius: 8px;
          border: 1px solid var(--divider-color, #e0e0e0);
          border-left: 3px solid transparent;
          cursor: pointer; transition: border-color 0.15s;
          background: var(--secondary-background-color, #f5f5f5);
        }
        .zone-chip:hover { border-left-color: var(--secondary-text-color, #727272); }
        .zone-chip.active {
          border-color: var(--divider-color, #e0e0e0);
          border-left: 3px solid #1d5fa8;
          background: var(--secondary-background-color, #f5f5f5);
        }
        .zone-chip.active .zone-name { font-weight: 600; color: var(--primary-text-color, #212121); }
        .zone-dot {
          width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
        }
        .zone-dot.playing { background: #1d9e75; }
        .zone-dot.online  { background: #ef9f27; }
        .zone-dot.offline { background: #9e9e9e; }
        .zone-dot.empty   { background: transparent; border: 2px solid #9e9e9e; }
        .zone-chip.zone-empty { opacity: 0.5; }
        .zone-chip.zone-empty:hover { opacity: 0.75; }
        .zone-info { display: flex; flex-direction: column; }
        .zone-name { font-size: 14px; font-weight: 500; }
        .zone-sub  { font-size: 11px; color: var(--secondary-text-color, #727272); }
        .empty-hint {
          font-size: 14px; color: var(--primary-text-color, #e8f6ff);
          text-align: left; padding: 16px; line-height: 1.6;
          border: 1px dashed var(--divider-color, #1f3a44); border-radius: 8px;
        }
        .empty-hint code {
          background: var(--secondary-background-color, #0d1418);
          padding: 2px 6px; border-radius: 4px; font-size: 12px;
        }
        #pi-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
        #pi-cards.is-empty { display: block; }

        /* ── Main area ── */
        .main { padding: 24px; overflow-y: auto; }

        /* ── Placeholder ── */
        #main-placeholder { text-align: center; padding: 80px 32px; color: var(--secondary-text-color, #727272); }
        #main-placeholder svg { opacity: 0.2; margin-bottom: 16px; }

        /* ── Zone detail ── */
        #zone-detail { display: none; }
        .zone-detail-header {
          display: flex; align-items: center; gap: 16px; margin-bottom: 20px; flex-wrap: wrap;
        }
        .zone-detail-header h2 { margin: 0; font-size: 18px; font-weight: 500; flex: 1; }
        .now-playing-box {
          background: var(--card-background-color, #fff);
          border: 1px solid var(--divider-color, #e0e0e0);
          border-radius: 12px; padding: 16px 20px; margin-bottom: 16px;
        }
        .playback-row { display: flex; gap: 12px; margin-bottom: 8px; font-size: 14px; }
        .playback-row:last-child { margin-bottom: 0; }
        .playback-label { min-width: 90px; color: var(--secondary-text-color, #727272); font-weight: 500; }
        .playback-value { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .playback-idle { margin: 0; color: var(--secondary-text-color, #727272); font-size: 13px; }

        /* ── Cards ── */
        .card {
          background: var(--card-background-color, #fff);
          border: 1px solid var(--divider-color, #e0e0e0);
          border-radius: 12px; padding: 20px; margin-bottom: 16px;
        }
        .card-title {
          font-size: 11px; font-weight: 600; letter-spacing: 0.06em;
          text-transform: uppercase; color: var(--secondary-text-color, #727272);
          margin: 0 0 16px;
        }

        /* ── Zone controls ── */
        .zone-controls { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
        label { display: block; font-size: 13px; margin-bottom: 4px; color: var(--secondary-text-color, #727272); }
        select, input[type="range"] {
          width: 100%; padding: 9px 12px;
          border: 1px solid var(--divider-color, #e0e0e0); border-radius: 8px;
          font-size: 14px; font-family: inherit;
          background: var(--primary-background-color, #fff);
          color: var(--primary-text-color, #212121); box-sizing: border-box;
        }
        input[type="range"] { padding: 4px 0; accent-color: #1d5fa8; }
        .slider-row { display: flex; align-items: center; gap: 10px; }
        .slider-row input { flex: 1; }
        .slider-val { min-width: 36px; text-align: right; font-size: 13px; font-weight: 500; }

        /* ── Pi cards ── */
        .pi-card {
          background: var(--card-background-color, #fff);
          border: 1px solid var(--divider-color, #e0e0e0); border-radius: 10px; padding: 14px;
        }
        .pi-card.pi-offline { opacity: 0.55; }
        .pi-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
        .pi-header strong { flex: 1; font-size: 14px; }
        .status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
        .status-dot.online  { background: #1d9e75; }
        .status-dot.offline { background: #e24b4a; }
        .pi-state { font-size: 11px; padding: 2px 7px; border-radius: 10px; font-weight: 500; }
        .state-playing     { background: #e1f5ee; color: #0f6e56; }
        .state-interrupted { background: #fff3e0; color: #e65100; }
        .state-stopped     { background: #f5f5f5; color: #757575; }
        .pi-meta { font-size: 12px; color: var(--secondary-text-color, #727272); margin-bottom: 10px; display: flex; flex-direction: column; gap: 2px; }
        .pi-meta span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .pi-area select { margin-left: 6px; max-width: 100%; }
        .pi-actions { display: flex; gap: 6px; }

        /* ── Buttons ── */
        .btn {
          padding: 9px 18px; border-radius: 8px; border: none; cursor: pointer;
          font-size: 14px; font-weight: 500; font-family: inherit;
          transition: opacity 0.15s, transform 0.1s;
        }
        .btn:hover { opacity: 0.85; }
        .btn:active { transform: scale(0.97); }
        .btn-primary  { background: #1d5fa8; color: #fff; }
        .btn-success  { background: #1d9e75; color: #fff; }
        .btn-danger   { background: #e24b4a; color: #fff; }
        .btn-warning  { background: #ef9f27; color: #fff; }
        .btn-secondary { background: var(--secondary-background-color, #f0f0f0); color: var(--primary-text-color, #212121); }
        .btn-sm { padding: 6px 12px; font-size: 12px; }

        /* ── Broadcast banner ── */
        .broadcast-card {
          background: linear-gradient(135deg, #0d3a6e, #1d5fa8);
          border-radius: 12px; padding: 20px; color: #fff; margin-bottom: 20px;
        }
        .broadcast-card h3 { margin: 0 0 4px; font-size: 15px; font-weight: 500; }
        .broadcast-card p  { margin: 0 0 12px; font-size: 13px; opacity: 0.8; }
      </style>

      <!-- Server URL settings dialog -->
      <div class="url-dialog-overlay" id="server-url-dialog">
        <div class="url-dialog">
          <h3>Server Connection</h3>
          <p>Set the AlleycatTV streaming server URL. This override is saved in your browser and persists across HA restarts.</p>
          <input id="server-url-input" type="url" placeholder="http://alleycat-streaming-server.local" autocomplete="off" />
          <p class="url-dialog-hint">Tip: use a hostname like <code>alleycat-streaming-server.local</code> so the URL never changes when the server gets a new IP.</p>
          <div class="url-dialog-actions">
            <button class="btn btn-secondary btn-sm" id="btn-url-clear">Clear override</button>
            <button class="btn btn-secondary btn-sm" id="btn-url-cancel">Cancel</button>
            <button class="btn btn-primary btn-sm" id="btn-url-save">Save &amp; Reload</button>
          </div>
        </div>
      </div>

      <div class="page-header">
        <div class="brand-icon">
          <svg viewBox="0 0 24 24"><path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14zM10 8l6 4-6 4V8z"/></svg>
        </div>
        <div>
          <h1>AlleycatTV</h1>
          <p class="subtitle">Zone video distribution</p>
        </div>
        <span id="feedback"></span>
        <button class="btn-settings" id="btn-server-settings" title="Server connection settings">⚙</button>
      </div>

      <div class="layout">
        <aside class="sidebar">
          <div class="sidebar-header">
            <p class="sidebar-title">Zones</p>
            <button class="btn-icon" id="btn-new-zone" title="Create zone">+</button>
          </div>
          <div id="new-zone-form" style="display:none;margin-bottom:12px;">
            <input id="new-zone-id" type="text" placeholder="Zone ID (e.g. zone-lobby)" style="margin-bottom:6px;" />
            <input id="new-zone-name" type="text" placeholder="Display name (optional)" style="margin-bottom:8px;" />
            <div style="display:flex;gap:6px;">
              <button class="btn btn-primary btn-sm" id="btn-zone-save" style="flex:1">Create</button>
              <button class="btn btn-secondary btn-sm" id="btn-zone-cancel">Cancel</button>
            </div>
          </div>
          <div id="zone-list"><p class="empty-hint">Waiting for devices…</p></div>
        </aside>

        <main class="main">
          <!-- Placeholder before zone selected -->
          <div id="main-placeholder">
            <div class="broadcast-card">
              <h3>Broadcast Interrupt to All Zones</h3>
              <p>Play an announcement on every connected Pi simultaneously.</p>
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                <select id="file-picker-global" style="flex:1;min-width:200px;background:rgba(255,255,255,0.15);color:#fff;border-color:rgba(255,255,255,0.3)">
                  <option value="">-- select announcement --</option>
                </select>
                <span id="file-picker-global-duration-wrap">
                  <select id="file-picker-global-duration" style="min-width:180px;background:rgba(255,255,255,0.15);color:#fff;border-color:rgba(255,255,255,0.3)">
                    ${this._interruptDurationOptions()}
                  </select>
                </span>
                <span id="bcast-rtsp-volume-wrap" style="display:none;align-items:center;gap:8px;">
                  <label style="font-size:12px;opacity:0.9">Vol</label>
                  <input type="range" id="bcast-rtsp-volume" min="0" max="100" value="80" style="width:100px"
                    oninput="this.nextElementSibling.textContent=this.value+'%'" />
                  <span style="font-size:12px;min-width:36px">80%</span>
                </span>
                <button class="btn btn-sm" style="background:rgba(255,255,255,0.2);color:#fff;border:1px solid rgba(255,255,255,0.3);" id="bcast-interrupt">
                  Interrupt All
                </button>
                <button class="btn btn-sm" style="display:none;background:#1d9e75;color:#fff;border:none;" id="bcast-start">
                  Start broadcasting
                </button>
                <button class="btn btn-sm" style="display:none;background:#e24b4a;color:#fff;border:none;" id="bcast-stop">
                  Stop broadcasting
                </button>
              </div>
            </div>
            <svg width="64" height="64" viewBox="0 0 24 24" fill="currentColor">
              <path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14zM10 8l6 4-6 4V8z"/>
            </svg>
            <p>Select a zone from the sidebar to manage it.</p>
          </div>

          <!-- Per-zone detail panel -->
          <div id="zone-detail">
            <div class="zone-detail-header">
              <h2 id="zone-title">—</h2>
              <div class="zone-controls">
                <button class="btn btn-success" id="btn-play" title="Resume playlist playback">▶ Play</button>
                <button class="btn btn-danger"  id="btn-stop" title="Stop playback on all displays in this zone">■ Stop</button>
                <button class="btn btn-warning" id="btn-reload" title="Reload playlist from server">↺ Reload</button>
                <button class="btn btn-secondary" id="btn-delete-zone" style="margin-left:8px;color:#e24b4a;">🗑 Delete Zone</button>
              </div>
            </div>

            <div class="now-playing-box" id="now-playing-summary">
              <p class="playback-idle">Select a zone to see playback status</p>
            </div>

            <!-- Interrupt card -->
            <div class="card">
              <p class="card-title">Interrupt Announcement</p>
              <label>Announcement</label>
              <select id="file-picker">
                <option value="">-- loading… --</option>
              </select>
              <div id="file-picker-duration-wrap">
                <label style="margin-top:10px;display:block">Display duration</label>
                <select id="file-picker-duration">
                  ${this._interruptDurationOptions()}
                </select>
              </div>
              <p id="interrupt-hint" style="font-size:12px;color:var(--secondary-text-color,#888);margin-top:8px;line-height:1.4">
                Photos and scoreboards use the duration above (default 30s). Videos play in full.
                "Until stopped" stays on screen until you press Play or Stop.
              </p>
              <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">
                <button class="btn btn-warning" id="btn-interrupt">⚡ Interrupt Zone</button>
                <button class="btn btn-success" id="btn-rtsp-start" style="display:none">Start broadcasting</button>
                <button class="btn btn-danger" id="btn-rtsp-stop" style="display:none">Stop broadcasting</button>
              </div>
            </div>

            <!-- Volume card -->
            <div class="card">
              <p class="card-title">Volume</p>
              <div class="slider-row">
                <input type="range" id="vol-slider" min="0" max="100" value="80" data-zone=""
                  oninput="this.parentElement.querySelector('.slider-val').textContent=this.value+'%'" />
                <span class="slider-val">80%</span>
              </div>
              <div style="margin-top:12px">
                <button class="btn btn-secondary" id="btn-vol">Set Volume</button>
              </div>
            </div>

            <!-- Pi status cards -->
            <div class="card">
              <p class="card-title">Displays in this Zone</p>
              <div id="pi-cards"></div>
            </div>
          </div>
        </main>
      </div>
    `;

    this._attachEventListeners();
  }

  _attachEventListeners() {
    const root = this.shadowRoot;

    // Server URL settings dialog
    root.getElementById("btn-server-settings")?.addEventListener("click", () => {
      this._openServerUrlDialog();
    });
    root.getElementById("btn-url-cancel")?.addEventListener("click", () => {
      root.getElementById("server-url-dialog").style.display = "none";
    });
    root.getElementById("btn-url-clear")?.addEventListener("click", async () => {
      await this._loadDirectoryUrl();
      root.getElementById("server-url-dialog").style.display = "none";
      this._showFeedback("Reloaded streaming URL from Core Configurator", "info");
    });
    root.getElementById("btn-url-save")?.addEventListener("click", async () => {
      const inp = root.getElementById("server-url-input");
      const val = (inp?.value || "").trim().replace(/\/$/, "");
      if (!val) return this._showFeedback("Enter a server URL first", "warn");
      try {
        if (window.AlleycatDirectory) {
          await window.AlleycatDirectory.setService(this._hass, "alleycattv", { url: val });
        } else {
          await this._hass.connection.sendMessagePromise({
            type: "alleycat_directory/set_service",
            key: "alleycattv",
            url: val,
          });
        }
        this._serverUrl = val;
        root.getElementById("server-url-dialog").style.display = "none";
        this._showFeedback(`Streaming server saved in Core Configurator`, "success");
      } catch (err) {
        this._showFeedback(`Save failed: ${err.message || err}`, "warn");
      }
    });
    // Close dialog on overlay click
    root.getElementById("server-url-dialog")?.addEventListener("click", (e) => {
      if (e.target === root.getElementById("server-url-dialog"))
        root.getElementById("server-url-dialog").style.display = "none";
    });

    // Zone detail controls
    root.getElementById("btn-play")?.addEventListener("click", () => {
      if (this._selectedZone) this._playZone(this._selectedZone);
    });
    root.getElementById("btn-stop")?.addEventListener("click", () => {
      if (this._selectedZone) this._stopZone(this._selectedZone);
    });
    root.getElementById("btn-reload")?.addEventListener("click", () => {
      if (this._selectedZone) this._reloadPlaylist(this._selectedZone);
    });
    root.getElementById("btn-interrupt")?.addEventListener("click", () => {
      if (this._selectedZone) this._interruptZone(this._selectedZone);
    });
    root.getElementById("btn-rtsp-start")?.addEventListener("click", () => {
      if (this._selectedZone) this._startZoneBroadcast(this._selectedZone);
    });
    root.getElementById("btn-rtsp-stop")?.addEventListener("click", () => {
      if (this._selectedZone) this._stopZoneBroadcast(this._selectedZone);
    });
    root.getElementById("file-picker")?.addEventListener("change", () => {
      this._syncInterruptUi("file-picker");
    });
    root.getElementById("file-picker-global")?.addEventListener("change", () => {
      this._syncInterruptUi("file-picker-global");
    });
    root.getElementById("btn-vol")?.addEventListener("click", () => {
      const slider = root.getElementById("vol-slider");
      if (this._selectedZone && slider) this._setVolume(this._selectedZone, slider.value);
    });

    // New zone form
    root.getElementById("btn-new-zone")?.addEventListener("click", () => {
      const form = root.getElementById("new-zone-form");
      form.style.display = form.style.display === "none" ? "block" : "none";
      if (form.style.display === "block") root.getElementById("new-zone-id")?.focus();
    });
    root.getElementById("btn-zone-cancel")?.addEventListener("click", () => {
      root.getElementById("new-zone-form").style.display = "none";
      root.getElementById("new-zone-id").value = "";
      root.getElementById("new-zone-name").value = "";
    });
    root.getElementById("btn-zone-save")?.addEventListener("click", () => {
      const id = root.getElementById("new-zone-id").value.trim();
      const name = root.getElementById("new-zone-name").value.trim();
      if (!id) return this._showFeedback("Zone ID is required", "warn");
      root.getElementById("new-zone-form").style.display = "none";
      root.getElementById("new-zone-id").value = "";
      root.getElementById("new-zone-name").value = "";
      this._createZone(id, name);
    });

    // Delete zone
    root.getElementById("btn-delete-zone")?.addEventListener("click", () => {
      if (this._selectedZone) this._deleteZone(this._selectedZone);
    });

    // Broadcast interrupt (file / webpage announcements)
    root.getElementById("bcast-interrupt")?.addEventListener("click", () => {
      const sel = root.getElementById("file-picker-global");
      const url = this._buildInterruptUrl(sel ? sel.value : "", "file-picker-global");
      if (!url) return this._showFeedback("Select an announcement file", "warn");
      Object.keys(this._zones).forEach(zid => {
        this._hass?.callService("alleycattv", "interrupt_zone", { zone_id: zid, file_url: url });
      });
      this._showFeedback("Broadcast interrupt sent to all zones", "success");
    });
    root.getElementById("bcast-start")?.addEventListener("click", () => this._broadcastStartRtsp());
    root.getElementById("bcast-stop")?.addEventListener("click", () => this._broadcastStopRtsp());
  }
}

customElements.define("alleycattv-panel", AlleycatTVPanel);
