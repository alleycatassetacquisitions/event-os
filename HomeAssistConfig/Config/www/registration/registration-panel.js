/**
 * Registration panel — player table + registration + inline edit.
 * Talks to Mission Control websocket (registration/*), not the player API directly.
 */
class MissionControlPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._players = [];
    this._initialized = false;
    this._checkTimer = null;
    this._nameStatus = "";
    this._editingId = null;
    this._postersByPlayer = {};
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) {
      this._initialized = true;
      this._render();
      this._loadStatus();
      this._loadPlayers();
    }
  }

  set panel(panel) {
    this._panel = panel;
  }

  connectedCallback() {
    if (this._hass && !this._initialized) {
      this._initialized = true;
      this._render();
      this._loadStatus();
      this._loadPlayers();
    }
  }

  disconnectedCallback() {
    this._initialized = false;
    if (this._checkTimer) clearTimeout(this._checkTimer);
  }

  // ── data loading ──────────────────────────────────────────────────────────

  async _loadPlayers() {
    if (!this._hass) return;
    try {
      const result = await this._hass.connection.sendMessagePromise({
        type: "registration/list_players",
        rows: 100,
        page: 1,
        refresh: true,
      });
      this._players = result.players || [];
      await this._loadBountyPosters();
      this._applySearch();
      this._feedback(`Loaded ${this._players.length} player(s)`, "ok");
    } catch (err) {
      this._feedback(`Roster fetch failed: ${this._errText(err)}`, "err");
    }
  }

  _bountyBaseUrl() {
    const stored = localStorage.getItem("bounty_server_url");
    if (stored) return stored.replace(/\/$/, "");
    return "http://192.168.1.206:8100";
  }

  _posterUrlForPlayer(playerId) {
    return `${this._bountyBaseUrl()}/poster/player/${encodeURIComponent(playerId)}`;
  }

  _videoUrlForPlayer(playerId) {
    return `${this._bountyBaseUrl()}/media/videos/${encodeURIComponent(playerId)}.webm`;
  }

  async _loadBountyPosters() {
    this._postersByPlayer = {};
    try {
      const resp = await fetch(`${this._bountyBaseUrl()}/api/posters`);
      if (!resp.ok) return;
      const list = await resp.json();
      if (!Array.isArray(list)) return;
      for (const poster of list) {
        const pid = String(poster.player_id || "");
        if (!pid) continue;
        const prev = this._postersByPlayer[pid];
        const stamp = poster.updated_at || poster.created_at || "";
        if (!prev || stamp >= (prev.updated_at || prev.created_at || "")) {
          this._postersByPlayer[pid] = poster;
        }
      }
    } catch (_) {
      /* Bounty server offline — poster column stays empty */
    }
  }

  // ── server mode settings ──────────────────────────────────────────────────

  async _loadStatus() {
    if (!this._hass) return;
    try {
      const s = await this._hass.connection.sendMessagePromise({ type: "registration/get_status" });
      this._applyStatusToSettings(s);
    } catch (_) { /* silent — settings box shows defaults */ }
  }

  _applyStatusToSettings(s) {
    const root = this.shadowRoot;
    const modeOnline = root.getElementById("btn-mode-online");
    const modeLocal = root.getElementById("btn-mode-local");
    if (!modeOnline) return;

    const isLocal = s.mode === "local";
    modeOnline.classList.toggle("mode-active", !isLocal);
    modeLocal.classList.toggle("mode-active", isLocal);

    const onlineInput = root.getElementById("modal-online-url");
    const localInput = root.getElementById("modal-local-url");
    if (onlineInput && s.online_url) onlineInput.value = s.online_url;
    if (localInput && s.local_url) localInput.value = s.local_url;
  }

  async _applyMode() {
    const root = this.shadowRoot;
    const isLocal = root.getElementById("btn-mode-local").classList.contains("mode-active");
    const mode = isLocal ? "local" : "online";
    const onlineUrl = (root.getElementById("modal-online-url")?.value || "").trim();
    const localUrl = (root.getElementById("modal-local-url")?.value || "").trim();
    const feedbackEl = root.getElementById("modal-feedback");
    try {
      await this._hass.connection.sendMessagePromise({
        type: "registration/set_server",
        mode,
        online_url: onlineUrl,
        local_url: localUrl,
      });
      if (feedbackEl) feedbackEl.textContent = `Saved — active: ${mode}`;
      setTimeout(() => { root.getElementById("settings-modal").hidden = true; }, 800);
      this._feedback(`Server mode: ${mode} — reloading roster…`, "ok");
      await this._loadPlayers();
    } catch (err) {
      if (feedbackEl) feedbackEl.textContent = `Failed: ${this._errText(err)}`;
    }
  }

  // ── search ────────────────────────────────────────────────────────────────

  _applySearch() {
    const term = (this.shadowRoot.getElementById("search")?.value || "").trim().toLowerCase();
    const filtered = term
      ? this._players.filter(
          (p) =>
            String(p.id).toLowerCase().includes(term) ||
            String(p.name).toLowerCase().includes(term)
        )
      : this._players;
    this._renderTable(filtered);
  }

  // ── name availability check ───────────────────────────────────────────────

  async _checkName(name) {
    if (this._editingId) return; // skip check while editing
    const el = this.shadowRoot.getElementById("name-status");
    if (!name.trim()) {
      this._nameStatus = "";
      if (el) el.textContent = "";
      return;
    }
    try {
      const result = await this._hass.connection.sendMessagePromise({
        type: "registration/check_name",
        name: name.trim(),
      });
      const available = result.content?.available;
      if (available === null || available === undefined) {
        // Endpoint not yet live — clear status silently
        this._nameStatus = "";
        if (el) { el.textContent = ""; el.className = ""; }
      } else if (available === true) {
        this._nameStatus = "available";
        if (el) { el.textContent = "Name is available"; el.className = "status-ok"; }
      } else {
        this._nameStatus = "taken";
        if (el) { el.textContent = "Name is already in use"; el.className = "status-err"; }
      }
    } catch (err) {
      this._nameStatus = "";
      if (el) { el.textContent = ""; el.className = ""; }
    }
  }

  _onNameInput(ev) {
    const name = ev.target.value;
    if (this._checkTimer) clearTimeout(this._checkTimer);
    this._checkTimer = setTimeout(() => this._checkName(name), 300);
  }

  // ── register (create) ─────────────────────────────────────────────────────

  async _register() {
    const root = this.shadowRoot;
    const name = root.getElementById("reg-name").value.trim();
    const role = root.getElementById("reg-role").value;
    const allegiance = root.getElementById("reg-allegiance").value;
    const faction = root.getElementById("reg-faction").value.trim();
    const neo_id = root.getElementById("reg-neo-id").value.trim();
    if (!name) return this._feedback("Enter a name", "warn");
    if (this._nameStatus === "taken") return this._feedback("Pick an unused name", "warn");
    try {
      const result = await this._hass.connection.sendMessagePromise({
        type: "registration/register_player",
        name,
        role,
        allegiance,
        faction,
        neo_id,
      });
      if (result.status === 409) {
        this._feedback("Name is already in use", "err");
        this._nameStatus = "taken";
        return;
      }
      if (result.status !== 200) {
        const err = result.content?.error || result.status;
        this._feedback(`Register failed: ${err}`, "err");
        return;
      }
      this._feedback(`Registered ${result.content?.name || name}`, "ok");
      root.getElementById("reg-name").value = "";
      root.getElementById("reg-faction").value = "";
      root.getElementById("reg-neo-id").value = "";
      root.getElementById("name-status").textContent = "";
      await this._loadPlayers();
    } catch (err) {
      this._feedback(`Register failed: ${this._errText(err)}`, "err");
    }
  }

  // ── edit flow ─────────────────────────────────────────────────────────────

  _selectPlayer(player) {
    const root = this.shadowRoot;
    this._editingId = player.id;

    // fill form fields
    root.getElementById("reg-name").value = player.name || "";
    root.getElementById("reg-role").value = player.mode || player.role || (player.hunter === 1 ? "hunter" : player.hunter === 2 ? "bounty" : "hunter");
    root.getElementById("reg-allegiance").value = player.allegiance || "freelancer";
    root.getElementById("reg-faction").value = player.faction || "";
    root.getElementById("reg-neo-id").value = player.neo_id || "";
    root.getElementById("name-status").textContent = "";
    this._nameStatus = "";

    // switch form title and button visibility
    root.getElementById("form-title").textContent = "Edit Player Registration";
    root.getElementById("btn-register").hidden = true;
    root.getElementById("btn-save-edit").hidden = false;
    root.getElementById("btn-cancel-edit").hidden = false;

    // highlight selected row
    root.querySelectorAll("#player-body tr").forEach((tr) => tr.classList.remove("selected"));
    const row = root.querySelector(`#player-body tr[data-id="${CSS.escape(String(player.id))}"]`);
    if (row) row.classList.add("selected");
  }

  async _updatePlayer() {
    const root = this.shadowRoot;
    const name = root.getElementById("reg-name").value.trim();
    const role = root.getElementById("reg-role").value;
    const allegiance = root.getElementById("reg-allegiance").value;
    const faction = root.getElementById("reg-faction").value.trim();
    const neo_id = root.getElementById("reg-neo-id").value.trim();
    if (!name) return this._feedback("Enter a name", "warn");
    try {
      const result = await this._hass.connection.sendMessagePromise({
        type: "registration/update_player",
        id: this._editingId,
        name,
        role,
        allegiance,
        faction,
        neo_id,
      });
      if (result.status !== 200) {
        const err = result.content?.error || result.status;
        this._feedback(`Update failed: ${err}`, "err");
        return;
      }
      this._feedback(`Updated ${name}`, "ok");
      this._cancelEdit();
      await this._loadPlayers();
    } catch (err) {
      this._feedback(`Update failed: ${this._errText(err)}`, "err");
    }
  }

  _cancelEdit() {
    const root = this.shadowRoot;
    this._editingId = null;
    this._nameStatus = "";

    root.getElementById("reg-name").value = "";
    root.getElementById("reg-faction").value = "";
    root.getElementById("reg-neo-id").value = "";
    root.getElementById("name-status").textContent = "";

    root.getElementById("form-title").textContent = "Register player";
    root.getElementById("btn-register").hidden = false;
    root.getElementById("btn-save-edit").hidden = true;
    root.getElementById("btn-cancel-edit").hidden = true;

    root.querySelectorAll("#player-body tr").forEach((tr) => tr.classList.remove("selected"));
  }

  // ── utilities ─────────────────────────────────────────────────────────────

  _errText(err) {
    if (!err) return "Unknown error";
    if (typeof err === "string") return err;
    return err.message || err.error || err.code || JSON.stringify(err);
  }

  _feedback(msg, type) {
    const el = this.shadowRoot.getElementById("feedback");
    if (!el) return;
    el.textContent = msg;
    el.className = `feedback ${type}`;
  }

  // ── table render ──────────────────────────────────────────────────────────

  _renderTable(players) {
    const list = players ?? this._players;
    const tbody = this.shadowRoot.getElementById("player-body");
    if (!tbody) return;
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty">No players yet</td></tr>`;
      return;
    }
    tbody.innerHTML = list
      .map((p) => {
        const pid = String(p.id);
        const poster = this._postersByPlayer[pid];
        const hasPoster = poster?.has_video;
        const posterUrl = this._posterUrlForPlayer(pid);
        const videoUrl = this._videoUrlForPlayer(pid);
        const posterCell = hasPoster
          ? `<td class="poster-cell"><video class="poster-thumb" src="${this._esc(videoUrl)}" muted playsinline preload="metadata"></video> <a href="${this._esc(posterUrl)}" target="_blank" rel="noopener">open</a></td>`
          : `<td class="poster-cell">—</td>`;
        return `<tr data-id="${this._esc(pid)}">
          <td>${this._esc(p.id)}</td>
          <td>${this._esc(p.name)}</td>
          <td>${this._esc(p.mode || p.role || (p.hunter === 1 ? "hunter" : p.hunter === 2 ? "bounty" : ""))}</td>
          <td>${this._esc(p.allegiance || "")}</td>
          <td>${this._esc(p.faction || "")}</td>
          <td>${this._esc(p.neo_id || "")}</td>
          ${posterCell}
          <td><button class="edit-btn" data-id="${this._esc(String(p.id))}">Edit</button></td>
        </tr>`;
      })
      .join("");

    // re-apply selected highlight if still editing
    if (this._editingId != null) {
      const row = tbody.querySelector(`tr[data-id="${CSS.escape(String(this._editingId))}"]`);
      if (row) row.classList.add("selected");
    }

    // wire edit buttons
    tbody.querySelectorAll(".edit-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const player = this._players.find((p) => String(p.id) === id);
        if (player) this._selectPlayer(player);
      });
    });
  }

  _esc(v) {
    return String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ── render (initial HTML) ─────────────────────────────────────────────────

  _render() {
    this.shadowRoot.innerHTML = `
      <link rel="stylesheet" href="/local/registration/alleycat-panel.css">
      <style>
        :host {
          display: block;
          font-family: var(--primary-font-family, "Share Tech Mono", ui-monospace, sans-serif);
          background: var(--primary-background-color, #0b0d12);
          color: var(--primary-text-color, #e8f6ff);
          min-height: 100vh;
        }
        .page-header {
          padding: 18px 24px;
          border-bottom: 1px solid var(--divider-color, #1f3a44);
          background: var(--card-background-color, #10151c);
        }
        h1 { margin: 0; font-size: 20px; letter-spacing: 0.08em; text-transform: uppercase; }
        .sub { color: var(--secondary-text-color, #7aa8b8); font-size: 13px; margin-top: 4px; }
        .layout { display: grid; grid-template-columns: 340px 1fr; min-height: calc(100vh - 72px); }
        .form-col, .table-col { padding: 20px 24px; }
        .form-col { border-right: 1px solid var(--divider-color, #1f3a44); }
        label { display: block; font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--secondary-text-color, #7aa8b8); margin: 12px 0 6px; }
        input, select {
          width: 100%; box-sizing: border-box; padding: 10px 12px;
          background: var(--secondary-background-color, #0d1418);
          color: var(--primary-text-color, #e8f6ff);
          border: 1px solid var(--divider-color, #1f3a44); border-radius: 6px; font: inherit;
        }
        .search-row { margin-bottom: 14px; }
        .search-row input { padding: 8px 12px; }
        button {
          margin-top: 16px; padding: 10px 16px; cursor: pointer; font: inherit;
          background: var(--primary-color, #00e5ff); color: #041016; border: 0; border-radius: 6px; font-weight: 600;
        }
        .ghost { background: transparent; color: var(--primary-color, #00e5ff); border: 1px solid var(--primary-color, #00e5ff); margin-left: 8px; }
        .danger { background: transparent; color: #e24b4a; border: 1px solid #e24b4a; margin-left: 8px; }
        table { width: 100%; border-collapse: collapse; }
        th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--divider-color, #1f3a44); font-size: 14px; }
        th { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--secondary-text-color, #7aa8b8); }
        .empty { color: var(--secondary-text-color); text-align: center; padding: 32px; }
        .status-ok { color: #4cde97; font-size: 13px; margin-top: 6px; }
        .status-err { color: #e24b4a; font-size: 13px; margin-top: 6px; }
        .feedback { min-height: 20px; font-size: 13px; margin-top: 12px; }
        .feedback.ok { color: #4cde97; }
        .feedback.err { color: #e24b4a; }
        .feedback.warn { color: #ef9f27; }
        #player-body tr.selected { background: rgba(0, 229, 255, 0.07); outline: 1px solid var(--primary-color, #00e5ff); }
        .edit-btn {
          margin-top: 0; padding: 4px 10px; font-size: 12px;
          background: transparent; color: var(--primary-color, #00e5ff);
          border: 1px solid var(--primary-color, #00e5ff); border-radius: 4px;
          cursor: pointer; font: inherit;
        }
        .edit-btn:hover { background: rgba(0, 229, 255, 0.1); }
        .poster-cell a { color: var(--primary-color, #00e5ff); text-decoration: none; }
        .poster-cell a:hover { text-decoration: underline; }
        .poster-thumb {
          width: 56px; height: 32px; object-fit: cover; vertical-align: middle;
          border: 1px solid var(--divider-color, #1f3a44); margin-right: 6px;
          background: #000;
        }
        .header-row { display: flex; align-items: center; justify-content: space-between; }
        .settings-gear {
          margin-top: 0; padding: 6px 10px; font-size: 18px; line-height: 1;
          background: transparent; color: var(--secondary-text-color, #7aa8b8);
          border: 1px solid var(--divider-color, #1f3a44); border-radius: 6px; cursor: pointer;
        }
        .settings-gear:hover { color: var(--primary-color, #00e5ff); border-color: var(--primary-color, #00e5ff); }
        .modal-overlay {
          position: fixed; inset: 0; background: rgba(0,0,0,0.65);
          display: flex; align-items: center; justify-content: center; z-index: 1000;
        }
        .modal-overlay[hidden] { display: none; }
        .modal-card {
          background: var(--card-background-color, #10151c);
          border: 1px solid var(--divider-color, #1f3a44); border-radius: 10px;
          padding: 24px; width: 360px; max-width: 95vw;
        }
        .modal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
        .modal-header h3 { margin: 0; font-size: 14px; letter-spacing: 0.1em; text-transform: uppercase; }
        .modal-close { margin-top: 0; padding: 4px 8px; font-size: 16px; line-height: 1; background: transparent; color: var(--secondary-text-color, #7aa8b8); border: none; cursor: pointer; }
        .mode-row { display: flex; gap: 8px; margin-bottom: 16px; }
        .mode-btn {
          margin-top: 0; flex: 1; padding: 9px 0; font-size: 13px; font-weight: 600;
          background: transparent; color: var(--primary-text-color, #e8f6ff);
          border: 1px solid var(--divider-color, #1f3a44); border-radius: 6px; cursor: pointer; font: inherit;
        }
        .mode-btn.mode-active { background: var(--primary-color, #00e5ff); color: #041016; border-color: var(--primary-color, #00e5ff); }
        .modal-actions { display: flex; gap: 8px; margin-top: 20px; }
        .modal-actions button { margin-top: 0; flex: 1; }
        @media (max-width: 900px) { .layout { grid-template-columns: 1fr; } .form-col { border-right: 0; border-bottom: 1px solid var(--divider-color); } }
      </style>
      <div id="settings-modal" class="modal-overlay" hidden>
        <div class="modal-card">
          <div class="modal-header">
            <h3>Server Settings</h3>
            <button type="button" class="modal-close" id="btn-modal-close">&times;</button>
          </div>
          <div class="mode-row">
            <button type="button" id="btn-mode-online" class="mode-btn mode-active">Online</button>
            <button type="button" id="btn-mode-local" class="mode-btn">Local</button>
          </div>
          <label for="modal-online-url">Online URL (DigitalOcean)</label>
          <input id="modal-online-url" type="text" placeholder="https://alleycat-dl83g.ondigitalocean.app" autocomplete="off" />
          <label for="modal-local-url">Local Server URL</label>
          <input id="modal-local-url" type="text" placeholder="http://192.168.1.234:8090" autocomplete="off" />
          <div class="modal-actions">
            <button type="button" id="btn-apply-mode">Apply</button>
            <button type="button" class="ghost" id="btn-modal-cancel">Cancel</button>
          </div>
          <div id="modal-feedback" style="font-size:12px;margin-top:10px;min-height:16px;color:var(--secondary-text-color,#7aa8b8)"></div>
        </div>
      </div>
      <div class="page-header">
        <div class="header-row">
          <div>
            <h1>Registration</h1>
            <p class="sub">Player roster and registration via Mission Control</p>
          </div>
          <button type="button" class="settings-gear" id="btn-settings" title="Server settings">&#9881;</button>
        </div>
      </div>
      <div class="layout">
        <div class="form-col">
          <h2 id="form-title" style="margin:0 0 8px;font-size:16px">Register player</h2>
          <label for="reg-name">Name</label>
          <input id="reg-name" type="text" autocomplete="off" />
          <div id="name-status"></div>
          <label for="reg-role">Role</label>
          <select id="reg-role">
            <option value="hunter">Hunter</option>
            <option value="bounty">Bounty</option>
          </select>
          <label for="reg-allegiance">NeoCorp</label>
          <select id="reg-allegiance">
            <option value="freelancer">Freelancer</option>
            <option value="endline">Endline</option>
            <option value="helix">Helix</option>
            <option value="reboot">Reboot</option>
          </select>
          <label for="reg-faction">Faction</label>
          <input id="reg-faction" type="text" autocomplete="off" />
          <label for="reg-neo-id">Neo ID</label>
          <input id="reg-neo-id" type="text" autocomplete="off" />
          <div>
            <button type="button" id="btn-register">Create player</button>
            <button type="button" class="ghost" id="btn-refresh">Refresh table</button>
            <button type="button" id="btn-save-edit" hidden>Save changes</button>
            <button type="button" class="danger" id="btn-cancel-edit" hidden>Cancel</button>
          </div>
          <div id="feedback" class="feedback"></div>
        </div>
        <div class="table-col">
          <div class="search-row">
            <input id="search" type="search" placeholder="Search by name or ID&hellip;" />
          </div>
          <table>
            <thead>
              <tr><th>ID</th><th>Name</th><th>Role</th><th>NeoCorp</th><th>Faction</th><th>Neo ID</th><th>Poster</th><th></th></tr>
            </thead>
            <tbody id="player-body">
              <tr><td colspan="7" class="empty">Loading&hellip;</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;

    this.shadowRoot.getElementById("reg-name").addEventListener("input", (e) => this._onNameInput(e));
    this.shadowRoot.getElementById("btn-register").addEventListener("click", () => this._register());
    this.shadowRoot.getElementById("btn-refresh").addEventListener("click", () => this._loadPlayers());
    this.shadowRoot.getElementById("btn-save-edit").addEventListener("click", () => this._updatePlayer());
    this.shadowRoot.getElementById("btn-cancel-edit").addEventListener("click", () => this._cancelEdit());
    this.shadowRoot.getElementById("search").addEventListener("input", () => this._applySearch());

    this.shadowRoot.getElementById("btn-settings").addEventListener("click", () => {
      this.shadowRoot.getElementById("settings-modal").hidden = false;
    });
    const closeModal = () => { this.shadowRoot.getElementById("settings-modal").hidden = true; };
    this.shadowRoot.getElementById("btn-modal-close").addEventListener("click", closeModal);
    this.shadowRoot.getElementById("btn-modal-cancel").addEventListener("click", closeModal);
    this.shadowRoot.getElementById("settings-modal").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeModal();
    });

    const onlineBtn = this.shadowRoot.getElementById("btn-mode-online");
    const localBtn = this.shadowRoot.getElementById("btn-mode-local");
    onlineBtn.addEventListener("click", () => {
      onlineBtn.classList.add("mode-active");
      localBtn.classList.remove("mode-active");
    });
    localBtn.addEventListener("click", () => {
      localBtn.classList.add("mode-active");
      onlineBtn.classList.remove("mode-active");
    });
    this.shadowRoot.getElementById("btn-apply-mode").addEventListener("click", () => this._applyMode());
  }
}

customElements.define("registration-panel", MissionControlPanel);
