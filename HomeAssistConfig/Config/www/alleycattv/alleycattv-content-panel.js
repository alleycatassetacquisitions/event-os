/**
 * AlleycatTV Content Manager — HA sidebar panel (feature parity with /manage).
 * JSON goes through /api/alleycattv/proxy; large files use chunked /api/alleycattv/uploads.
 */
class AlleycatTVContentPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._initialized = false;
    this._zones = [];
    this._playlists = {};
    this._content = [];
    this._devices = [];
    this._bumpers = [];
    this._confirmCb = null;
    this._promptCb = null;
    this._libDrag = null;
  }

  set hass(hass) {
    this._hass = hass;
    this._tryInit();
  }

  set panel(panel) {
    this._panel = panel;
    if (this._initialized) this._loadAll();
    else this._tryInit();
  }

  _tryInit() {
    if (this._initialized || !this._hass) return;
    this._initialized = true;
    this._render();
    this._loadAll();
  }

  _serverUrl() {
    // 0. User override stored in browser localStorage (survives HA restarts)
    const stored = localStorage.getItem("alleycattv_server_url");
    if (stored) return stored.replace(/\/$/, "");
    const raw =
      this._panel?.config?.server_url ||
      this.panel?.config?.server_url ||
      "http://headless-alleycat-streaming-server.local";
    return String(raw).replace(/\/$/, "");
  }

  async _openServerUrlDialog() {
    const dlg = this.shadowRoot.getElementById("server-url-dialog");
    const inp = this.shadowRoot.getElementById("server-url-input");
    if (!dlg || !inp) return;
    inp.value = this._serverUrl() || "";

    // Prefill RTSP settings from server (single live-1 source for now)
    const rtspUrl = this.shadowRoot.getElementById("rtsp-url-input");
    const rtspLabel = this.shadowRoot.getElementById("rtsp-label-input");
    const rtspEnabled = this.shadowRoot.getElementById("rtsp-enabled-input");
    if (rtspUrl) rtspUrl.value = "";
    if (rtspLabel) rtspLabel.value = "Live RTSP";
    if (rtspEnabled) rtspEnabled.checked = false;
    try {
      const settings = await this._api("GET", "/api/settings/");
      const sources = Array.isArray(settings?.rtsp_sources) ? settings.rtsp_sources : [];
      const live = sources.find((s) => s.id === "live-1") || sources[0];
      if (live) {
        if (rtspUrl) rtspUrl.value = live.url || "";
        if (rtspLabel) rtspLabel.value = live.label || "Live RTSP";
        if (rtspEnabled) rtspEnabled.checked = !!live.enabled;
      }
    } catch (_) {
      // settings optional if older server
    }

    dlg.style.display = "flex";
    inp.focus();
    inp.select();
  }

  _token() {
    return this._hass?.auth?.data?.access_token || "";
  }

  _headers(json = false) {
    const h = {};
    const token = this._token();
    if (token) h.Authorization = `Bearer ${token}`;
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  async _api(method, path, body) {
    const attempts = [
      { url: `/api/alleycattv/proxy${path}`, auth: true },
      { url: `${this._serverUrl()}${path}`, auth: false },
    ];
    let lastErr = "request failed";
    for (const attempt of attempts) {
      try {
        const headers = { "cache-control": "no-store" };
        if (attempt.auth && this._token()) {
          headers.Authorization = `Bearer ${this._token()}`;
        }
        const opts = { method, headers, cache: "no-store", credentials: attempt.auth ? "same-origin" : "omit" };
        if (body !== undefined) {
          headers["Content-Type"] = "application/json";
          opts.body = typeof body === "string" ? body : JSON.stringify(body);
        }
        const resp = await fetch(attempt.url, opts);
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          lastErr = data.detail || data.error || `${resp.status} ${resp.statusText}`;
          continue;
        }
        return data;
      } catch (err) {
        lastErr = err.message || String(err);
      }
    }
    throw new Error(lastErr);
  }

  async _loadAll() {
    const errors = [];
    let zones = [];
    let playlists = {};
    let content = [];
    try {
      const z = await this._api("GET", "/api/zones");
      zones = Array.isArray(z) ? z : Array.isArray(z?.zones) ? z.zones : [];
    } catch (err) {
      errors.push(`zones: ${err.message}`);
    }
    try {
      const pl = await this._api("GET", "/api/playlists");
      playlists = pl && typeof pl === "object" && !Array.isArray(pl) ? pl : {};
    } catch (err) {
      errors.push(`playlists: ${err.message}`);
    }
    try {
      const c = await this._api(
        "GET",
        `/api/content/?base_url=${encodeURIComponent(this._serverUrl())}`
      );
      content = Array.isArray(c) ? c : [];
    } catch (err) {
      errors.push(`content: ${err.message}`);
    }
    let devices = [];
    try {
      const d = await this._api("GET", "/api/devices/");
      devices = Array.isArray(d) ? d : [];
    } catch (_) {
      // devices endpoint is optional — no error toast if unreachable
    }
    let bumpers = [];
    try {
      const b = await this._api("GET", `/api/content/bumpers?base_url=${encodeURIComponent(this._serverUrl())}`);
      bumpers = Array.isArray(b) ? b : [];
    } catch (_) {
      // bumpers endpoint optional
    }
    this._zones = zones;
    this._playlists = playlists;
    this._content = content;
    this._devices = devices;
    this._bumpers = bumpers;
    this._paint();
    this._paintBumpers();
    this._paintDevices();
    if (errors.length) {
      this._toast(`Load failed (${this._serverUrl()}): ${errors.join("; ")}`, "err");
    } else {
      this._toast(
        `Library loaded — ${zones.length} zone(s), ${content.length} file(s)`,
        "ok"
      );
    }
  }

  _esc(v) {
    return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  }

  _toast(msg, type) {
    const el = this.shadowRoot.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.className = `toast show ${type}`;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove("show"), type === "err" ? 12000 : 3000);
  }

  _isAnnounce(f) {
    if (f.media_type === "rtsp") return false;
    return !!f.entry_id || f.subdir === "announcements";
  }

  _isLibrary(f) {
    return f.subdir === "videos" || f.subdir === "photos";
  }

  async _uploadFile(file, subdir, zoneId, onProgress) {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("subdir", subdir);
    if (zoneId) fd.append("zone_id", zoneId);
    try {
      const direct = await fetch(`${this._serverUrl()}/api/content/upload`, {
        method: "POST",
        body: fd,
      });
      if (direct.ok) {
        if (onProgress) onProgress(1, file.name);
        return;
      }
    } catch (_) {
      /* fall through to HA chunked upload */
    }
    const start = await fetch("/api/alleycattv/uploads", {
      method: "POST",
      headers: this._headers(true),
      body: JSON.stringify({
        filename: file.name,
        subdir,
        size_bytes: file.size,
        zone_id: zoneId || null,
      }),
    });
    const info = await start.json().catch(() => ({}));
    if (!start.ok) throw new Error(info.detail || "upload start failed");
    const chunkSize = info.chunk_size || 4 * 1024 * 1024;
    const uploadId = info.upload_id;
    let offset = 0;
    let index = 0;
    try {
      while (offset < file.size) {
        const chunk = file.slice(offset, offset + chunkSize);
        const buf = await chunk.arrayBuffer();
        let attempt = 0;
        while (true) {
          const resp = await fetch(`/api/alleycattv/uploads/${uploadId}/chunks/${index}`, {
            method: "PUT",
            headers: { Authorization: `Bearer ${this._token()}` },
            body: buf,
          });
          if (resp.ok) break;
          attempt += 1;
          if (attempt >= 3) throw new Error(`chunk ${index} failed`);
        }
        offset += chunkSize;
        index += 1;
        if (onProgress) onProgress(Math.min(offset / file.size, 1), file.name);
      }
      const done = await fetch(`/api/alleycattv/uploads/${uploadId}/complete`, {
        method: "POST",
        headers: this._headers(),
      });
      if (!done.ok) {
        const err = await done.json().catch(() => ({}));
        throw new Error(err.detail || "complete failed");
      }
    } catch (err) {
      await fetch(`/api/alleycattv/uploads/${uploadId}`, {
        method: "DELETE",
        headers: this._headers(),
      }).catch(() => {});
      throw err;
    }
  }

  _subdirForFile(file) {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    return ["jpg", "jpeg", "png", "webp"].includes(ext) ? "photos" : "videos";
  }

  async _handleFiles(files, zoneId, announce) {
    const list = [...files];
    if (!list.length) return;
    const prog = this.shadowRoot.getElementById(zoneId ? `prog-${this._domId(zoneId)}` : "announce-prog");
    const bar = this.shadowRoot.getElementById(zoneId ? `bar-${this._domId(zoneId)}` : "announce-bar");
    const lbl = this.shadowRoot.getElementById(zoneId ? `plbl-${this._domId(zoneId)}` : "announce-lbl");
    if (prog) prog.classList.add("visible");
    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      if (lbl) lbl.textContent = `${i + 1}/${list.length}: ${file.name}`;
      try {
        await this._uploadFile(
          file,
          announce ? "announcements" : this._subdirForFile(file),
          announce ? null : zoneId,
          (pct) => {
            if (bar) bar.style.width = `${Math.round(((i + pct) / list.length) * 100)}%`;
          }
        );
      } catch (err) {
        this._toast(`${file.name}: ${err.message}`, "err");
      }
    }
    if (bar) bar.style.width = "100%";
    if (lbl) lbl.textContent = "Done";
    setTimeout(() => prog?.classList.remove("visible"), 2000);
    await this._loadAll();
  }

  _domId(zoneId) {
    return String(zoneId).replace(/[^a-zA-Z0-9_-]+/g, "-");
  }

  _confirm(message) {
    return new Promise((resolve) => {
      this._confirmCb = resolve;
      this.shadowRoot.getElementById("confirm-message").textContent = message;
      this.shadowRoot.getElementById("confirm-backdrop").hidden = false;
    });
  }

  _promptUrl(title) {
    return new Promise((resolve) => {
      this._promptCb = resolve;
      this.shadowRoot.getElementById("prompt-title").textContent = title;
      this.shadowRoot.getElementById("prompt-label").value = "";
      this.shadowRoot.getElementById("prompt-url").value = "";
      this.shadowRoot.getElementById("prompt-duration").value = "30";
      this.shadowRoot.getElementById("prompt-backdrop").hidden = false;
    });
  }

  _paint() {
    const root = this.shadowRoot;
    const announces = this._content.filter((f) => this._isAnnounce(f));
    const lib = this._content.filter((f) => this._isLibrary(f));
    const alist = root.getElementById("announce-list");
    alist.innerHTML = announces.length
      ? announces.map((f) => `
          <div class="item">
            <span class="grow" title="${this._esc(f.filename)}">${this._esc(f.filename)}</span>
            <button class="del" data-kind="announce" data-entry="${this._esc(f.entry_id || "")}" data-filename="${this._esc(f.filename)}">×</button>
          </div>`).join("")
      : `<p class="muted">No announcements yet.</p>`;

    const zonesEl = root.getElementById("zones");
    const addCard = root.getElementById("add-zone-card");
    zonesEl.querySelectorAll(".zone-card").forEach((c) => c.remove());
    this._zones.forEach((z) => {
      const pl = this._playlists[z.zone_id] || { items: [], mode: "manual", photo_interval: 5 };
      const items = pl.items || [];
      const card = document.createElement("div");
      card.className = "zone-card";
      card.dataset.zoneId = z.zone_id;
      const domId = this._domId(z.zone_id);
      const bumperOpts = [
        `<option value="">None (blank screen)</option>`,
        ...this._bumpers.map((b) =>
          `<option value="${this._esc(b.url)}" ${pl.bumper_url === b.url ? "selected" : ""}>${this._esc(b.filename)}</option>`
        ),
      ].join("");
      card.innerHTML = `
        <div class="zone-head"><strong>${this._esc(z.name || z.zone_id)}</strong><span>${items.length} items</span></div>
        <div class="controls">
          <label>Order <select class="mode">
            <option value="manual" ${pl.mode === "auto" ? "" : "selected"}>Manual</option>
            <option value="auto" ${pl.mode === "auto" ? "selected" : ""}>Auto shuffle</option>
          </select></label>
          <label>Photo every <input class="photo" type="number" min="0" max="99" value="${pl.photo_interval ?? 5}" style="width:52px"> videos</label>
          <label>Transition bumper <select class="bumper">${bumperOpts}</select></label>
          <button class="btn ghost save">Save settings</button>
          <button class="btn primary score">+ Scoreboard URL</button>
        </div>
        <div class="drop">Drop library items or files, or click to upload
          <input type="file" multiple accept="video/*,image/*,.mp4,.mkv,.mov,.avi,.jpg,.jpeg,.png,.webp" />
        </div>
        <div class="prog" id="prog-${domId}"><div class="bar-bg"><div class="bar" id="bar-${domId}"></div></div><p id="plbl-${domId}"></p></div>
        <div class="playlist">${items.length ? items.map((it, idx) => `
          <div class="pl-item" draggable="true" data-idx="${idx}">
            <span>☰</span><span class="grow">${this._esc(it.filename || it.url)}</span>
            <span class="muted">${this._esc(it.media_type)}</span>
            <button class="del" data-kind="pl" data-idx="${idx}">×</button>
          </div>`).join("") : `<p class="muted">No content yet — drag from the library below</p>`}</div>`;
      card.querySelector(".save").addEventListener("click", () => this._saveSettings(z.zone_id, card));
      card.querySelector(".score").addEventListener("click", () => this._addScoreboard(z.zone_id));
      const fileInput = card.querySelector("input[type=file]");
      fileInput.addEventListener("change", (e) => this._handleFiles(e.target.files, z.zone_id, false));
      card.querySelector(".drop").addEventListener("click", (e) => {
        if (!e.isTrusted) return;
        fileInput.click();
      });
      card.querySelectorAll(".pl-item .del").forEach((btn) => {
        btn.addEventListener("click", () => this._removeItem(z.zone_id, parseInt(btn.dataset.idx, 10)));
      });
      this._bindPlaylistDrag(card, z.zone_id);
      card.addEventListener("dragover", (e) => {
        if (this._libDrag || this._hasFileDrag(e)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          card.classList.add("over");
        }
      });
      card.addEventListener("dragleave", () => card.classList.remove("over"));
      card.addEventListener("drop", (e) => {
        if (this._libDrag) {
          e.preventDefault();
          e.stopPropagation();
          card.classList.remove("over");
          const payload = this._libDrag;
          this._libDrag = null;
          this._addLibraryToPlaylist(z.zone_id, payload);
          return;
        }
        if (e.dataTransfer.files?.length) {
          e.preventDefault();
          card.classList.remove("over");
          this._handleFiles(e.dataTransfer.files, z.zone_id, false);
        }
      });
      zonesEl.insertBefore(card, addCard);
    });

    const libEl = root.getElementById("library");
    const fmt = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`);
    libEl.innerHTML = lib.length
      ? lib.map((f, i) => `
          <div class="item lib-item" draggable="true" data-lib-idx="${i}">
            <div class="grow"><div>${this._esc(f.filename)}</div><div class="muted">${this._esc(f.media_type)} · ${fmt(f.size_bytes || 0)}</div></div>
            <button class="del" data-kind="lib" data-subdir="${this._esc(f.subdir)}" data-filename="${this._esc(f.filename)}">×</button>
          </div>`).join("")
      : `<p class="muted">No videos or photos yet.</p>`;
    libEl.querySelectorAll(".lib-item").forEach((el) => {
      el.addEventListener("dragstart", (e) => {
        if (e.target.closest(".del")) {
          e.preventDefault();
          return;
        }
        const f = lib[parseInt(el.dataset.libIdx, 10)];
        if (!f) return;
        this._libDrag = {
          filename: f.filename,
          media_type: f.media_type,
          subdir: f.subdir,
        };
        el.classList.add("dragging");
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData("text/plain", f.filename);
      });
      el.addEventListener("dragend", () => {
        el.classList.remove("dragging");
        this._libDrag = null;
      });
    });
  }

  _hasFileDrag(e) {
    return [...(e.dataTransfer?.types || [])].includes("Files");
  }

  async _addLibraryToPlaylist(zoneId, file) {
    if (!file?.filename) return;
    const mediaType = file.media_type === "photo" || file.subdir === "photos" ? "photo" : "video";
    const pl = await this._api("GET", `/api/playlists/${encodeURIComponent(zoneId)}`);
    const items = [...(pl.items || [])];
    const item = { filename: file.filename, media_type: mediaType };
    if (mediaType === "photo") item.photo_duration = 10;
    items.push(item);
    await this._api("PUT", `/api/playlists/${encodeURIComponent(zoneId)}`, {
      ...pl,
      zone_id: zoneId,
      items,
    });
    this._toast(`Added ${file.filename} to ${zoneId}`, "ok");
    await this._loadAll();
  }

  _bindPlaylistDrag(card, zoneId) {
    let from = null;
    card.querySelectorAll(".pl-item").forEach((el) => {
      el.addEventListener("dragstart", () => { from = parseInt(el.dataset.idx, 10); });
      el.addEventListener("dragover", (e) => e.preventDefault());
      el.addEventListener("drop", async (e) => {
        if (this._libDrag) return;
        e.preventDefault();
        e.stopPropagation();
        const to = parseInt(el.dataset.idx, 10);
        if (from == null || from === to) return;
        const pl = await this._api("GET", `/api/playlists/${encodeURIComponent(zoneId)}`);
        const items = pl.items || [];
        const [moved] = items.splice(from, 1);
        items.splice(to, 0, moved);
        await this._api("PUT", `/api/playlists/${encodeURIComponent(zoneId)}`, { ...pl, zone_id: zoneId, items });
        await this._loadAll();
      });
    });
  }

  async _saveSettings(zoneId, card) {
    const pl = await this._api("GET", `/api/playlists/${encodeURIComponent(zoneId)}`);
    const bumperUrl = card.querySelector(".bumper")?.value || "";
    await this._api("PUT", `/api/playlists/${encodeURIComponent(zoneId)}`, {
      ...pl,
      zone_id: zoneId,
      mode: card.querySelector(".mode").value,
      photo_interval: parseInt(card.querySelector(".photo").value, 10) || 0,
      bumper_url: bumperUrl,
    });
    this._toast("Zone settings saved", "ok");
    await this._loadAll();
  }

  async _addScoreboard(zoneId) {
    const data = await this._promptUrl("Add scoreboard URL");
    if (!data) return;
    const pl = await this._api("GET", `/api/playlists/${encodeURIComponent(zoneId)}`);
    const items = pl.items || [];
    items.push({ filename: data.label, media_type: "webpage", url: data.url, duration: data.duration });
    await this._api("PUT", `/api/playlists/${encodeURIComponent(zoneId)}`, { ...pl, zone_id: zoneId, items });
    await this._loadAll();
  }

  async _removeItem(zoneId, idx) {
    const pl = await this._api("GET", `/api/playlists/${encodeURIComponent(zoneId)}`);
    const items = pl.items || [];
    items.splice(idx, 1);
    await this._api("PUT", `/api/playlists/${encodeURIComponent(zoneId)}`, { ...pl, zone_id: zoneId, items });
    await this._loadAll();
  }

  async _createZone() {
    const id = this.shadowRoot.getElementById("nz-id").value.trim();
    const name = this.shadowRoot.getElementById("nz-name").value.trim();
    if (!id) return this._toast("Zone ID is required", "err");
    try {
      await this._api("POST", "/api/zones", { zone_id: id, name: name || id });
      this.shadowRoot.getElementById("new-zone-form").hidden = true;
      await this._loadAll();
    } catch (err) {
      this._toast(err.message, "err");
    }
  }

  _bind() {
    const root = this.shadowRoot;

    // Announcement upload — click + drag (input has pointer-events:none)
    const annDrop = root.getElementById("announce-drop");
    const annFiles = root.getElementById("announce-files");
    if (annDrop && annFiles) {
      annDrop.addEventListener("click", (e) => {
        if (!e.isTrusted) return;
        annFiles.click();
      });
      annFiles.addEventListener("change", (e) => this._handleFiles(e.target.files, null, true));
      annDrop.addEventListener("dragover", (e) => {
        if (this._hasFileDrag(e)) {
          e.preventDefault();
          annDrop.classList.add("over");
        }
      });
      annDrop.addEventListener("dragleave", () => annDrop.classList.remove("over"));
      annDrop.addEventListener("drop", (e) => {
        if (e.dataTransfer.files?.length) {
          e.preventDefault();
          annDrop.classList.remove("over");
          this._handleFiles(e.dataTransfer.files, null, true);
        }
      });
    }

    const libDrop = root.getElementById("lib-drop");
    const libFiles = root.getElementById("lib-files");
    if (libDrop && libFiles) {
      libDrop.addEventListener("click", (e) => {
        if (!e.isTrusted) return;
        libFiles.click();
      });
      libFiles.addEventListener("change", (e) => this._handleFiles(e.target.files, null, false));
      libDrop.addEventListener("dragover", (e) => {
        if (this._hasFileDrag(e)) {
          e.preventDefault();
          libDrop.classList.add("over");
        }
      });
      libDrop.addEventListener("drop", (e) => {
        if (e.dataTransfer.files?.length) {
          e.preventDefault();
          libDrop.classList.remove("over");
          this._handleFiles(e.dataTransfer.files, null, false);
        }
      });
    }
    root.getElementById("btn-refresh-devices")?.addEventListener("click", () => this._reloadDevices());

    // Bumper upload
    root.getElementById("bumper-files")?.addEventListener("change", async (e) => {
      const files = [...e.target.files];
      if (!files.length) return;
      for (const file of files) {
        const fd = new FormData();
        fd.append("file", file);
        try {
          const resp = await fetch(`${this._serverUrl()}/api/content/bumpers/upload`, { method: "POST", body: fd });
          if (!resp.ok) { const d = await resp.json().catch(() => ({})); throw new Error(d.detail || resp.statusText); }
          this._toast(`Uploaded ${file.name}`, "ok");
        } catch (err) {
          this._toast(`${file.name}: ${err.message}`, "err");
        }
      }
      e.target.value = "";
      await this._reloadBumpers();
    });
    root.getElementById("bumper-drop")?.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      root.getElementById("bumper-files").click();
    });
    root.getElementById("bumper-drop")?.addEventListener("dragover", (e) => {
      if ([...(e.dataTransfer?.types || [])].includes("Files")) { e.preventDefault(); e.currentTarget.classList.add("over"); }
    });
    root.getElementById("bumper-drop")?.addEventListener("dragleave", (e) => e.currentTarget.classList.remove("over"));
    root.getElementById("bumper-drop")?.addEventListener("drop", async (e) => {
      if (!e.dataTransfer.files?.length) return;
      e.preventDefault();
      e.currentTarget.classList.remove("over");
      const files = [...e.dataTransfer.files];
      for (const file of files) {
        const fd = new FormData();
        fd.append("file", file);
        try {
          const resp = await fetch(`${this._serverUrl()}/api/content/bumpers/upload`, { method: "POST", body: fd });
          if (!resp.ok) { const d = await resp.json().catch(() => ({})); throw new Error(d.detail || resp.statusText); }
          this._toast(`Uploaded ${file.name}`, "ok");
        } catch (err) {
          this._toast(`${file.name}: ${err.message}`, "err");
        }
      }
      await this._reloadBumpers();
    });

    // Server URL settings dialog
    root.getElementById("btn-server-settings")?.addEventListener("click", () => this._openServerUrlDialog());
    root.getElementById("btn-url-cancel")?.addEventListener("click", () => {
      root.getElementById("server-url-dialog").style.display = "none";
    });
    root.getElementById("btn-url-clear")?.addEventListener("click", () => {
      if (!confirm("Clear the stored server URL override? The URL from configuration.yaml will be used instead.")) return;
      localStorage.removeItem("alleycattv_server_url");
      root.getElementById("server-url-dialog").style.display = "none";
      setTimeout(() => location.reload(), 500);
    });
    root.getElementById("btn-url-save")?.addEventListener("click", async () => {
      const inp = root.getElementById("server-url-input");
      const val = (inp?.value || "").trim().replace(/\/$/, "");
      if (!val) return this._toast("Enter a server URL first", "err");
      localStorage.setItem("alleycattv_server_url", val);

      const rtspUrl = (root.getElementById("rtsp-url-input")?.value || "").trim();
      const rtspLabel = (root.getElementById("rtsp-label-input")?.value || "").trim() || "Live RTSP";
      const rtspEnabled = !!root.getElementById("rtsp-enabled-input")?.checked;
      try {
        await this._api("PUT", "/api/settings/", {
          rtsp_sources: [{
            id: "live-1",
            label: rtspLabel,
            url: rtspUrl,
            enabled: rtspEnabled && !!rtspUrl,
          }],
        });
      } catch (err) {
        this._toast(`RTSP settings save failed: ${err.message}`, "err");
        return;
      }

      root.getElementById("server-url-dialog").style.display = "none";
      this._toast("Settings saved — reloading…", "ok");
      setTimeout(() => location.reload(), 1200);
    });
    root.getElementById("server-url-dialog")?.addEventListener("click", (e) => {
      if (e.target === root.getElementById("server-url-dialog"))
        root.getElementById("server-url-dialog").style.display = "none";
    });
    root.getElementById("btn-ann-url").addEventListener("click", async () => {
      const data = await this._promptUrl("Add scoreboard to announcements");
      if (!data) return;
      try {
        await this._api("POST", "/api/content/announcements/url", data);
        await this._loadAll();
      } catch (err) {
        this._toast(err.message, "err");
      }
    });
    root.getElementById("add-zone-card").addEventListener("click", () => {
      root.getElementById("new-zone-form").hidden = false;
    });
    root.getElementById("nz-create").addEventListener("click", () => this._createZone());
    root.getElementById("nz-cancel").addEventListener("click", () => {
      root.getElementById("new-zone-form").hidden = true;
    });
    root.getElementById("confirm-ok").addEventListener("click", () => {
      root.getElementById("confirm-backdrop").hidden = true;
      this._confirmCb?.(true);
      this._confirmCb = null;
    });
    root.getElementById("confirm-cancel").addEventListener("click", () => {
      root.getElementById("confirm-backdrop").hidden = true;
      this._confirmCb?.(false);
      this._confirmCb = null;
    });
    const closePrompt = (value) => {
      root.getElementById("prompt-backdrop").hidden = true;
      this._promptCb?.(value);
      this._promptCb = null;
    };
    root.getElementById("prompt-ok").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const label = root.getElementById("prompt-label").value.trim();
      const url = root.getElementById("prompt-url").value.trim();
      const duration = parseInt(root.getElementById("prompt-duration").value, 10) || 30;
      if (!label || !url) return this._toast("Name and URL required", "err");
      closePrompt({ label, url, duration });
    });
    root.getElementById("prompt-cancel").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closePrompt(null);
    });
    root.getElementById("prompt-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "prompt-backdrop") closePrompt(null);
    });
    root.getElementById("confirm-backdrop").addEventListener("click", (e) => {
      if (e.target.id !== "confirm-backdrop") return;
      root.getElementById("confirm-backdrop").hidden = true;
      this._confirmCb?.(false);
      this._confirmCb = null;
    });
    root.addEventListener("click", async (e) => {
      const btn = e.target.closest(".del");
      if (!btn) return;
      const kind = btn.dataset.kind;
      if (kind === "announce") {
        if (!(await this._confirm("Delete this announcement?"))) return;
        if (btn.dataset.entry) {
          await this._api("DELETE", `/api/content/announcements/url/${encodeURIComponent(btn.dataset.entry)}`);
        } else {
          await this._api("POST", "/api/content/announcements/delete-file", { filename: btn.dataset.filename });
        }
        await this._loadAll();
      } else if (kind === "lib") {
        let msg = `Delete "${btn.dataset.filename}"?`;
        try {
          const usage = await this._api("POST", "/api/content/usage-check", {
            subdir: btn.dataset.subdir,
            filename: btn.dataset.filename,
          });
          if (usage.zones?.length) msg = `"${btn.dataset.filename}" is used in: ${usage.zones.join(", ")}.\nDelete anyway?`;
        } catch (_) { /* usage check optional */ }
        if (!(await this._confirm(msg))) return;
        await this._api("POST", "/api/content/delete-file", {
          subdir: btn.dataset.subdir,
          filename: btn.dataset.filename,
        });
        await this._loadAll();
      }
    });
  }

  // ── Bumpers ───────────────────────────────────────────────────────────────

  _paintBumpers() {
    const el = this.shadowRoot.getElementById("bumpers-list");
    if (!el) return;
    const bumpers = this._bumpers || [];
    if (!bumpers.length) {
      el.innerHTML = `<p class="muted">No bumpers uploaded yet. Upload a short video, image, or GIF to play between playlist items.</p>`;
      return;
    }
    const fmt = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`);
    el.innerHTML = bumpers.map((f) => `
      <div class="item">
        <div class="grow">
          <div>${this._esc(f.filename)}</div>
          <div class="muted" style="font-size:11px">${fmt(f.size_bytes || 0)}</div>
        </div>
        <button class="btn ghost btn-copy-url" data-url="${this._esc(f.url)}" title="Copy URL for Pi config">Copy URL</button>
        <button class="del bumper-del" data-filename="${this._esc(f.filename)}" title="Delete bumper">×</button>
      </div>`).join("");
    el.querySelectorAll(".btn-copy-url").forEach((btn) => {
      btn.addEventListener("click", () => {
        navigator.clipboard.writeText(btn.dataset.url).then(() => {
          btn.textContent = "Copied!";
          setTimeout(() => { btn.textContent = "Copy URL"; }, 1800);
        });
      });
    });
    el.querySelectorAll(".bumper-del").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!(await this._confirm(`Delete bumper "${btn.dataset.filename}"?`))) return;
        try {
          await this._api("DELETE", `/api/content/bumpers/${encodeURIComponent(btn.dataset.filename)}`);
          this._toast(`Deleted ${btn.dataset.filename}`, "ok");
        } catch (err) {
          this._toast(`Delete failed: ${err.message}`, "err");
        }
        await this._reloadBumpers();
      });
    });
  }

  async _reloadBumpers() {
    try {
      const b = await this._api("GET", `/api/content/bumpers?base_url=${encodeURIComponent(this._serverUrl())}`);
      this._bumpers = Array.isArray(b) ? b : [];
    } catch (_) {
      this._bumpers = [];
    }
    this._paintBumpers();
  }

  // ── Devices (cache management) ────────────────────────────────────────────

  _fmtBytes(bytes) {
    if (bytes == null || bytes < 0) return "—";
    const gb = bytes / (1024 ** 3);
    if (gb >= 1) return `${gb.toFixed(1)} GB`;
    const mb = bytes / (1024 ** 2);
    return `${mb.toFixed(0)} MB`;
  }

  _paintDevices() {
    const el = this.shadowRoot.getElementById("devices-list");
    if (!el) return;
    if (!this._devices || this._devices.length === 0) {
      el.innerHTML = `<p class="muted">No Pi devices have reported cache status yet. Status is published every 30 s once the cache is enabled and the player is running.</p>`;
      return;
    }
    el.innerHTML = this._devices.map((dev) => {
      const piId   = this._esc(dev.pi_id || dev.pi_id || "unknown");
      const maxB   = dev.cache_max_bytes || 0;
      const usedB  = (dev.disk_used || 0) - Math.max((dev.disk_free || 0), 0);
      const cacheB = (dev.files || []).reduce((s, f) => s + (f.size_bytes || 0), 0);
      const pct    = maxB > 0 ? Math.min(100, Math.round(cacheB / maxB * 100)) : 0;
      const barCls = pct > 85 ? "dev-bar-warn" : "dev-bar";

      const fileRows = (dev.files || []).map((f) => `
        <div class="dev-file">
          <span class="grow" title="${this._esc(f.subdir + "/" + f.filename)}">${this._esc(f.filename)}</span>
          <span class="muted" style="white-space:nowrap">${this._fmtBytes(f.size_bytes)}</span>
          <button class="del dev-del"
            data-pi="${piId}"
            data-subdir="${this._esc(f.subdir)}"
            data-filename="${this._esc(f.filename)}"
            title="Remove from device cache">×</button>
        </div>`).join("") || `<p class="muted" style="margin:6px 0">Cache is empty.</p>`;

      return `
        <div class="dev-card">
          <div class="dev-head">
            <span class="dev-id">${piId}</span>
            <span class="muted">${this._fmtBytes(dev.disk_free || 0)} free</span>
          </div>
          <div class="dev-bar-wrap">
            <div class="${barCls}" style="width:${pct}%"></div>
          </div>
          <div class="dev-disk-label">
            <span>${this._fmtBytes(cacheB)} cached</span>
            <span>${this._fmtBytes(maxB)} max</span>
          </div>
          <div class="dev-files">${fileRows}</div>
          <div class="dev-actions">
            <button class="btn ghost dev-purge" data-pi="${piId}">Purge all</button>
            <button class="btn ghost dev-sync" data-pi="${piId}">Sync now</button>
          </div>
        </div>`;
    }).join("");

    el.querySelectorAll(".dev-del").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const { pi, subdir, filename } = btn.dataset;
        if (!(await this._confirm(`Remove ${filename} from ${pi}'s cache?`))) return;
        await this._deleteDeviceFile(pi, subdir, filename);
      });
    });
    el.querySelectorAll(".dev-purge").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!(await this._confirm(`Purge the entire cache on ${btn.dataset.pi}?`))) return;
        await this._purgeDevice(btn.dataset.pi);
      });
    });
    el.querySelectorAll(".dev-sync").forEach((btn) => {
      btn.addEventListener("click", () => this._syncDevice(btn.dataset.pi));
    });
  }

  async _deleteDeviceFile(piId, subdir, filename) {
    try {
      await this._api("DELETE", `/api/devices/${encodeURIComponent(piId)}/cache/${encodeURIComponent(subdir)}/${encodeURIComponent(filename)}`);
      this._toast(`Deleted ${filename} from ${piId}`, "ok");
    } catch (err) {
      this._toast(`Delete failed: ${err.message}`, "err");
    }
    await this._reloadDevices();
  }

  async _purgeDevice(piId) {
    try {
      await this._api("POST", `/api/devices/${encodeURIComponent(piId)}/cache/purge`);
      this._toast(`Cache purge sent to ${piId}`, "ok");
    } catch (err) {
      this._toast(`Purge failed: ${err.message}`, "err");
    }
    setTimeout(() => this._reloadDevices(), 3000);
  }

  async _syncDevice(piId) {
    try {
      await this._api("POST", `/api/devices/${encodeURIComponent(piId)}/cache/sync`);
      this._toast(`Cache sync sent to ${piId}`, "ok");
    } catch (err) {
      this._toast(`Sync failed: ${err.message}`, "err");
    }
  }

  async _reloadDevices() {
    try {
      const d = await this._api("GET", "/api/devices/");
      this._devices = Array.isArray(d) ? d : [];
    } catch (_) {
      this._devices = [];
    }
    this._paintDevices();
  }

  _render() {
    this.shadowRoot.innerHTML = `
      <link rel="stylesheet" href="/local/alleycattv/alleycat-panel.css">
      <style>
        :host { display:block; font-family: var(--primary-font-family, ui-sans-serif, sans-serif); background: var(--primary-background-color, #0b0d12); color: var(--primary-text-color, #e8f6ff); min-height:100vh; }
        header { padding:16px 24px; border-bottom:1px solid var(--divider-color,#1f3a44); display:flex; align-items:center; gap:12px; background: var(--card-background-color,#10151c); }
        h1 { margin:0; font-size:20px; letter-spacing:0.06em; text-transform:uppercase; }
        main { padding:24px; max-width:1280px; margin:0 auto; }
        .muted { color: var(--secondary-text-color,#7aa8b8); font-size:13px; }
        .toast { margin-left:auto; opacity:0; padding:6px 12px; border-radius:16px; font-size:13px; }
        .toast.show { opacity:1; }
        .toast.ok { background:#1a3d2b; color:#4cde97; }
        .toast.err { background:#3d1a1a; color:#de4c4c; }
        .section { font-size:11px; letter-spacing:0.1em; text-transform:uppercase; color: var(--secondary-text-color); margin: 8px 0; }
        .card, .zone-card, .item { background: var(--card-background-color,#10151c); border:1px solid var(--divider-color,#1f3a44); border-radius:12px; }
        .card { padding:16px; margin-bottom:24px; }
        .drop { border:2px dashed var(--divider-color); border-radius:10px; padding:18px; text-align:center; position:relative; margin:12px 0; }
        .drop input { position:absolute; inset:0; opacity:0; cursor:pointer; pointer-events:none; }
        #zones { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:16px; }
        .zone-card { overflow:hidden; }
        .zone-card.over, .drop.over { border-color: var(--primary-color,#00e5ff); }
        .zone-head, .controls, .playlist { padding:12px 14px; }
        .zone-head { display:flex; justify-content:space-between; border-bottom:1px solid var(--divider-color); }
        .controls { display:flex; flex-wrap:wrap; gap:8px; align-items:center; font-size:13px; border-bottom:1px solid var(--divider-color); }
        select, input, button { font:inherit; }
        select, input[type=text], input[type=number], input[type=url] {
          background: var(--secondary-background-color,#0d1418); color:inherit; border:1px solid var(--divider-color); border-radius:6px; padding:6px 8px;
        }
        .btn { padding:8px 12px; border-radius:8px; border:0; cursor:pointer; }
        .primary { background: var(--primary-color,#00e5ff); color:#041016; }
        .ghost { background: transparent; color: var(--primary-text-color); border:1px solid var(--divider-color); }
        .item { display:flex; gap:8px; align-items:center; padding:10px 12px; margin-bottom:8px; }
        .lib-item { cursor:grab; }
        .lib-item.dragging { opacity:0.45; }
        .grow { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .del { background:none; border:0; color:#888; cursor:pointer; font-size:18px; }
        .pl-item { display:flex; gap:8px; align-items:center; padding:8px; background: var(--secondary-background-color); border-radius:8px; margin-bottom:6px; cursor:grab; }
        .prog { display:none; padding:0 14px 12px; }
        .prog.visible { display:block; }
        .bar-bg { background: var(--divider-color); height:6px; border-radius:4px; overflow:hidden; }
        .bar { height:100%; width:0; background: var(--primary-color,#00e5ff); }
        #add-zone-card { min-height:140px; display:flex; align-items:center; justify-content:center; border:2px dashed var(--divider-color); cursor:pointer; border-radius:14px; }
        .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:10px; }
        .backdrop { position:fixed; inset:0; background:rgba(0,0,0,.65); display:flex; align-items:center; justify-content:center; z-index:20; }
        .backdrop[hidden] { display:none !important; }
        .dialog { background: var(--card-background-color); padding:20px; border-radius:12px; width:90%; max-width:420px; border:1px solid var(--divider-color); }
        label { display:block; margin:8px 0; font-size:13px; }
        .dev-card { background: var(--card-background-color,#10151c); border:1px solid var(--divider-color,#1f3a44); border-radius:12px; padding:16px; margin-bottom:16px; }
        .dev-head { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:8px; }
        .dev-id { font-weight:600; letter-spacing:0.04em; }
        .dev-bar-wrap { background: var(--divider-color,#1f3a44); border-radius:4px; height:8px; overflow:hidden; margin-bottom:4px; }
        .dev-bar { height:100%; background: var(--primary-color,#00e5ff); border-radius:4px; transition:width .4s; }
        .dev-bar-warn { height:100%; background:#e67e22; border-radius:4px; transition:width .4s; }
        .dev-disk-label { display:flex; justify-content:space-between; font-size:12px; color: var(--secondary-text-color,#7aa8b8); margin-bottom:10px; }
        .dev-files { border-top:1px solid var(--divider-color,#1f3a44); padding-top:8px; margin-bottom:10px; }
        .dev-file { display:flex; gap:8px; align-items:center; padding:5px 0; font-size:13px; border-bottom:1px solid var(--divider-color,#1f3a44); }
        .dev-file:last-child { border-bottom:none; }
        .dev-actions { display:flex; gap:8px; }
        .btn-settings {
          background: none; border: 1px solid var(--divider-color,#1f3a44);
          border-radius: 8px; padding: 6px 10px; cursor: pointer;
          font-size: 16px; color: var(--secondary-text-color,#7aa8b8);
          line-height: 1; transition: background 0.15s;
        }
        .btn-settings:hover { background: var(--secondary-background-color,#0d1418); }
        .url-dialog-overlay {
          display: none; position: fixed; inset: 0;
          background: rgba(0,0,0,0.6); z-index: 9999;
          align-items: center; justify-content: center;
        }
        .url-dialog {
          background: var(--card-background-color,#10151c);
          border: 1px solid var(--divider-color,#1f3a44);
          border-radius: 14px; padding: 28px 32px; min-width: 360px; max-width: 90vw;
          box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        }
        .url-dialog h3 { margin: 0 0 6px; font-size: 16px; font-weight: 600; }
        .url-dialog p  { margin: 0 0 16px; font-size: 13px; color: var(--secondary-text-color,#7aa8b8); }
        .url-dialog input[type=url] {
          width: 100%; padding: 10px 12px; border-radius: 8px;
          border: 1px solid var(--divider-color,#1f3a44);
          font-size: 14px; font-family: inherit;
          background: var(--secondary-background-color,#0d1418);
          color: var(--primary-text-color,#e8f6ff);
          box-sizing: border-box; margin-bottom: 8px;
        }
        .url-dialog-hint {
          font-size: 11px; color: var(--secondary-text-color,#7aa8b8);
          margin: 0 0 14px; line-height: 1.4;
        }
        .url-dialog-sep {
          border: none; border-top: 1px solid rgba(122,168,184,0.25);
          margin: 16px 0;
        }
        .url-dialog-label {
          display: block; font-size: 12px; color: var(--secondary-text-color,#7aa8b8);
          margin: 0 0 10px;
        }
        .url-dialog-label input {
          display: block; width: 100%; margin-top: 4px;
          background: #0d1a22; border: 1px solid rgba(122,168,184,0.35);
          color: var(--primary-text-color,#e8f4f8); border-radius: 6px;
          padding: 8px 10px; font-size: 13px; box-sizing: border-box;
        }
        .url-dialog-check {
          display: flex; align-items: center; gap: 8px;
          font-size: 13px; margin: 4px 0 14px;
          color: var(--primary-text-color,#e8f4f8);
        }
        .url-dialog-actions { display: flex; gap: 10px; justify-content: flex-end; }
      </style>
      <div class="url-dialog-overlay" id="server-url-dialog">
        <div class="url-dialog">
          <h3>Server Connection</h3>
          <p>Set the AlleycatTV streaming server URL. Saved in your browser — persists across HA restarts.</p>
          <input id="server-url-input" type="url" placeholder="http://alleycat-streaming-server.local" autocomplete="off" />
          <p class="url-dialog-hint">Tip: use a hostname like <code>alleycat-streaming-server.local</code> so the URL never changes when the server gets a new IP.</p>
          <hr class="url-dialog-sep" />
          <h3>Live RTSP Interrupt</h3>
          <p>One shared live stream for venue broadcasts. When enabled, it appears in AlleycatTV announcement pickers.</p>
          <label class="url-dialog-label">Label
            <input id="rtsp-label-input" type="text" placeholder="Live RTSP" autocomplete="off" />
          </label>
          <label class="url-dialog-label">RTSP URL
            <input id="rtsp-url-input" type="url" placeholder="rtsp://192.168.1.50:554/stream1" autocomplete="off" />
          </label>
          <label class="url-dialog-check">
            <input id="rtsp-enabled-input" type="checkbox" />
            Enable as announcement source
          </label>
          <div class="url-dialog-actions">
            <button class="btn ghost" id="btn-url-clear" type="button">Clear override</button>
            <button class="btn ghost" id="btn-url-cancel" type="button">Cancel</button>
            <button class="btn primary" id="btn-url-save" type="button">Save &amp; Reload</button>
          </div>
        </div>
      </div>
      <header>
        <h1>Content Manager</h1>
        <span class="muted">AlleycatTV library — uploads go through Mission Control in chunks</span>
        <div id="toast" class="toast"></div>
        <button class="btn-settings" id="btn-server-settings" title="Server connection settings">⚙</button>
      </header>
      <main>
        <p class="section">Announcements</p>
        <div class="card">
          <div class="drop" id="announce-drop">Drop interrupt videos/photos or click to browse
            <input id="announce-files" type="file" multiple accept="video/*,image/*,.mp4,.mkv,.mov,.avi,.jpg,.jpeg,.png,.webp" />
          </div>
          <button class="btn primary" id="btn-ann-url" type="button">+ Scoreboard URL</button>
          <div class="prog" id="announce-prog"><div class="bar-bg"><div class="bar" id="announce-bar"></div></div><p id="announce-lbl"></p></div>
          <div id="announce-list" class="grid" style="margin-top:12px"></div>
        </div>
        <p class="section">Zones</p>
        <p class="muted">Free-text zone ids — create whatever booths you need. Location (Mission Control Area) is assigned on devices, not here.</p>
        <div id="zones">
          <div id="add-zone-card">+ Create new zone</div>
        </div>
        <div id="new-zone-form" class="card" hidden>
          <label>Zone ID <input id="nz-id" type="text" /></label>
          <label>Display name <input id="nz-name" type="text" /></label>
          <button class="btn primary" id="nz-create" type="button">Create Zone</button>
          <button class="btn ghost" id="nz-cancel" type="button">Cancel</button>
        </div>
        <p class="section">Content library</p>
        <p class="muted">Drop files here to add them to the library (not a playlist). Drag a library item onto a zone card to add it to that playlist.</p>
        <div class="drop" id="lib-drop">Drop videos/photos into the library, or click to upload
          <input id="lib-files" type="file" multiple accept="video/*,image/*,.mp4,.mkv,.mov,.avi,.jpg,.jpeg,.png,.webp" />
        </div>
        <div id="library" class="grid"></div>
        <p class="section" style="margin-top:28px">Transition Bumpers</p>
        <p class="muted">Short videos, images, or GIFs that play between playlist items on each Pi. Upload a file, then copy its URL into the Pi's <code>ALLEYCATV_BUMPER</code> setting.</p>
        <div class="drop" id="bumper-drop" style="margin-bottom:12px">Drop a video / image / GIF here, or click to upload
          <input id="bumper-files" type="file" multiple accept="video/*,image/*,.mp4,.mkv,.mov,.avi,.jpg,.jpeg,.png,.webp,.gif" />
        </div>
        <div id="bumpers-list" style="margin-bottom:24px"></div>

        <p class="section" style="margin-top:28px">Devices</p>
        <p class="muted">Per-Pi cache status. Files marked cached will play locally instead of streaming over the network.</p>
        <button class="btn ghost" id="btn-refresh-devices" type="button" style="margin-bottom:12px">Refresh</button>
        <div id="devices-list"></div>
      </main>
      <div id="confirm-backdrop" class="backdrop" hidden><div class="dialog">
        <p id="confirm-message"></p>
        <button class="btn ghost" id="confirm-cancel" type="button">Cancel</button>
        <button class="btn primary" id="confirm-ok" type="button">Delete</button>
      </div></div>
      <div id="prompt-backdrop" class="backdrop" hidden><div class="dialog">
        <p id="prompt-title">Add URL</p>
        <label>Display name <input id="prompt-label" type="text" /></label>
        <label>URL <input id="prompt-url" type="url" /></label>
        <label>Duration (s) <input id="prompt-duration" type="number" value="30" /></label>
        <button class="btn ghost" id="prompt-cancel" type="button">Cancel</button>
        <button class="btn primary" id="prompt-ok" type="button">Add</button>
      </div></div>
    `;
    this._bind();
  }
}

customElements.define("alleycattv-content-panel", AlleycatTVContentPanel);
