/**
 * Galactic Bounty Network — Mission Control capture + flavor editor.
 *
 * Roster: registration/list_players websocket
 * API: ProjectBounty HTTP (flavor, intake, posters)
 * Camera: getUserMedia + MediaRecorder (USB UVC webcam — not WebUSB)
 *
 * Deploy: config/www/bounty/
 */
class BountyPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._panel = null;
    this._initialized = false;
    this._players = [];
    this._selected = null;
    this._serverUrl = null;
    this._stream = null;
    this._recorder = null;
    this._chunks = [];
    this._blob = null;
    this._recordTimer = null;
    this._countdownTimer = null;
    this._cameraPermitted = false;
    this._existingPoster = null;
    this._comboOpen = false;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) {
      this._initialized = true;
      this._serverUrl = this._resolveServerUrl();
      this._render();
      this._boot();
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
      this._boot();
    }
  }

  disconnectedCallback() {
    this._initialized = false;
    this._teardownCamera();
  }

  _resolveServerUrl() {
    const stored = localStorage.getItem("bounty_server_url");
    if (stored) return stored.replace(/\/$/, "");
    if (this._panel?.config?.server_url) {
      return String(this._panel.config.server_url).replace(/\/$/, "");
    }
    return "http://192.168.1.206:8100";
  }

  async _boot() {
    await this._loadPlayers();
    await this._refreshCameras();
  }

  _feedback(msg, kind = "ok") {
    const el = this.shadowRoot.getElementById("feedback");
    if (!el) return;
    el.textContent = msg;
    el.className = `feedback ${kind}`;
  }

  _errText(err) {
    if (!err) return "unknown error";
    if (typeof err === "string") return err;
    return err.message || err.error || JSON.stringify(err);
  }

  _normAllegiance(v) {
    const s = String(v || "freelancer").toLowerCase();
    return ["reboot", "helix", "endline", "freelancer"].includes(s) ? s : "freelancer";
  }

  _playerRole(player) {
    if (!player) return "bounty";
    const r = String(player.mode || player.role || "").toLowerCase();
    if (r === "hunter" || r === "bounty") return r;
    if (player.hunter === 1) return "hunter";
    if (player.hunter === 2) return "bounty";
    return "bounty";
  }

  _getRole() {
    return this._selected ? this._playerRole(this._selected) : "bounty";
  }

  _updateRoleUi() {
    const root = this.shadowRoot;
    const role = this._getRole();
    const isHunter = role === "hunter";
    const lbl = root.getElementById("lbl-list-field");
    const crimes = root.getElementById("fld-crimes");
    const cardTitle = root.getElementById("flavor-card-title");
    if (lbl) {
      lbl.textContent = isHunter
        ? "Reasons to Hire (one per line)"
        : "Crimes / Wanted for (one per line)";
    }
    if (crimes) {
      crimes.placeholder = isHunter
        ? "What is your EIS?\nWhat do you want bounties to know about you?\nReviews from past clients."
        : "What are you wanted for?\nWhat are you known for?\nWhy are you dangerous?";
    }
    if (cardTitle) {
      cardTitle.textContent = isHunter ? "Flavor / reasons to hire" : "Flavor / crimes";
    }
  }

  _posterUrlForPlayer(playerId) {
    return `${this._serverUrl}/poster/player/${encodeURIComponent(playerId)}`;
  }

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
      this._renderComboList("");
      this._feedback(`Loaded ${this._players.length} player(s)`, "ok");
    } catch (err) {
      this._players = [];
      this._renderComboList("");
      this._feedback(
        `Roster fetch failed: ${this._errText(err)} — enter name manually`,
        "warn"
      );
    }
  }

  _renderComboList(term) {
    const list = this.shadowRoot.getElementById("player-combo-list");
    if (!list) return;
    const q = (term || "").trim().toLowerCase();
    const filtered = q
      ? this._players.filter((p) => String(p.name || "").toLowerCase().includes(q))
      : this._players;
    list.innerHTML = "";
    if (!filtered.length) {
      list.innerHTML = `<div class="combo-empty">No matches</div>`;
      return;
    }
    for (const p of filtered) {
      const alleg = p.allegiance || "";
      const row = document.createElement("button");
      row.type = "button";
      row.className = "combo-item";
      row.dataset.id = String(p.id);
      row.textContent = `${p.name}${alleg ? ` (${alleg})` : ""}`;
      row.onclick = () => this._selectPlayerById(String(p.id));
      list.appendChild(row);
    }
  }

  _setComboOpen(open) {
    this._comboOpen = open;
    const list = this.shadowRoot.getElementById("player-combo-list");
    if (list) list.hidden = !open;
  }

  async _selectPlayerById(id) {
    const player = this._players.find((p) => String(p.id) === id) || null;
    this._selected = player;
    this._setComboOpen(false);
    const root = this.shadowRoot;
    const input = root.getElementById("player-combo-input");
    if (!player) {
      if (input) input.value = "";
      return;
    }
    if (input) input.value = player.name || "";
    root.getElementById("fld-name").value = player.name || "";
    root.getElementById("fld-allegiance").value = this._normAllegiance(player.allegiance);
    root.getElementById("fld-faction").value = player.faction || "";
    this._updateRoleUi();
    await this._loadExistingPoster(String(player.id));
  }

  async _loadExistingPoster(playerId) {
    this._existingPoster = null;
    const root = this.shadowRoot;
    try {
      const { ok, status, body } = await this._api(`/api/posters/by-player/${encodeURIComponent(playerId)}`);
      if (status === 404 || !ok) {
        root.getElementById("success-box").hidden = true;
        this._feedback("No existing poster — capture or upload a new clip", "ok");
        return;
      }
      this._existingPoster = body;
      root.getElementById("fld-bounty").value = body.bounty_amount ?? "";
      root.getElementById("fld-crimes").value = (body.crimes || []).join("\n");
      root.getElementById("fld-height").value = body.stats?.height || "";
      root.getElementById("fld-weight").value = body.stats?.weight || "";
      root.getElementById("fld-age").value = body.stats?.age || "";
      root.getElementById("fld-flavor").value = body.flavor_text || "";
      if (body.faction) root.getElementById("fld-faction").value = body.faction;
      // Roster wins for live NeoCorp/name/faction display
      if (this._selected) {
        root.getElementById("fld-name").value = this._selected.name || body.name || "";
        root.getElementById("fld-allegiance").value = this._normAllegiance(
          this._selected.allegiance || body.allegiance
        );
        root.getElementById("fld-faction").value =
          this._selected.faction || body.faction || "";
      }
      const link = root.getElementById("poster-link");
      const url = body.poster_url || this._posterUrlForPlayer(playerId);
      link.href = url;
      link.textContent = url;
      root.getElementById("success-box").hidden = false;

      if (body.video_url) {
        const review = root.getElementById("review-video");
        const live = root.getElementById("live-video");
        review.src = body.video_url;
        review.classList.remove("hidden");
        live.classList.add("hidden");
        this._blob = null;
        this._setRecStatus("Existing clip loaded — retake or upload to replace");
      }
      this._feedback("Loaded existing poster for this player", "ok");
    } catch (err) {
      this._feedback(`Poster lookup failed: ${this._errText(err)}`, "warn");
    }
  }

  async _api(path, options = {}) {
    const resp = await fetch(`${this._serverUrl}${path}`, options);
    const text = await resp.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch (_) {
      body = text;
    }
    return { ok: resp.ok, status: resp.status, body };
  }

  async _generateFlavor() {
    const root = this.shadowRoot;
    const name = root.getElementById("fld-name").value.trim();
    const allegiance = root.getElementById("fld-allegiance").value;
    const role = this._getRole();
    if (!name) return this._feedback("Enter a name first", "warn");
    try {
      const { ok, status, body } = await this._api("/api/flavor/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, allegiance, role }),
      });
      if (!ok) {
        return this._feedback(`Generate failed (${status}): ${JSON.stringify(body)}`, "err");
      }
      root.getElementById("fld-bounty").value = body.bounty_amount ?? "";
      root.getElementById("fld-crimes").value = (body.crimes || []).join("\n");
      root.getElementById("fld-height").value = body.stats?.height || "";
      root.getElementById("fld-weight").value = body.stats?.weight || "";
      root.getElementById("fld-age").value = body.stats?.age || "";
      root.getElementById("fld-flavor").value = body.flavor_text || "";
      this._feedback(`Flavor generated (${body.source || "templates"})`, "ok");
    } catch (err) {
      this._feedback(`Generate failed: ${this._errText(err)}`, "err");
    }
  }

  async _simulateIntake() {
    const mac = this.shadowRoot.getElementById("fld-mac").value.trim();
    if (!mac) return this._feedback("Enter a MAC to simulate", "warn");
    try {
      const { status, body } = await this._api("/api/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mac }),
      });
      if (status === 501) {
        this._feedback(
          `MAC ${mac}: lookup not wired yet (${body?.reason || "stub"}). Select player manually.`,
          "warn"
        );
        return;
      }
      if (status === 200 && body?.player) {
        const p = body.player;
        this.shadowRoot.getElementById("fld-name").value = p.name || "";
        this.shadowRoot.getElementById("fld-allegiance").value = this._normAllegiance(
          p.allegiance
        );
        this.shadowRoot.getElementById("fld-faction").value = p.faction || "";
        this._feedback(`Resolved ${p.name} from MAC`, "ok");
        return;
      }
      this._feedback(`Intake ${status}: ${JSON.stringify(body)}`, "err");
    } catch (err) {
      this._feedback(`Intake failed: ${this._errText(err)}`, "err");
    }
  }

  _setRecStatus(text) {
    const el = this.shadowRoot.getElementById("rec-status");
    if (el) el.textContent = text || "";
  }

  _teardownCamera() {
    if (this._recordTimer) {
      clearTimeout(this._recordTimer);
      this._recordTimer = null;
    }
    if (this._countdownTimer) {
      clearInterval(this._countdownTimer);
      this._countdownTimer = null;
    }
    if (this._recorder && this._recorder.state !== "inactive") {
      try {
        this._recorder.stop();
      } catch (_) {}
    }
    this._recorder = null;
    if (this._stream) {
      this._stream.getTracks().forEach((t) => t.stop());
      this._stream = null;
    }
    const live = this.shadowRoot?.getElementById("live-video");
    if (live) live.srcObject = null;
  }

  _mediaDevices() {
    return (
      navigator.mediaDevices ||
      window.navigator?.mediaDevices ||
      window.top?.navigator?.mediaDevices ||
      null
    );
  }

  _cameraBlockedReason() {
    const origin = window.location.origin || "(unknown)";
    const md = this._mediaDevices();
    // Only hard-block when the API is missing. Insecure HTTP can still work for
    // this session (Zen/Firefox prefs or Chrome insecure-origin flag).
    if (!md?.getUserMedia) {
      return (
        `Camera API unavailable at ${origin}. ` +
        `Browsers hide getUserMedia on plain HTTP. ` +
        `Zen/Firefox: about:config → set media.devices.insecure.enabled and ` +
        `media.getusermedia.insecure.enabled to true, then restart the browser. ` +
        `Chrome/Edge: chrome://flags/#unsafely-treat-insecure-origin-as-secure ` +
        `→ add ${origin} → Relaunch. HTTPS is required for “Remember” to stick.`
      );
    }
    return null;
  }

  _cameraHttpHint() {
    if (window.isSecureContext) return null;
    return (
      "HTTP session: camera can work after Allow, but browsers will not Remember " +
      "permission until HA is on HTTPS."
    );
  }

  async _refreshCameras() {
    const sel = this.shadowRoot.getElementById("camera-select");
    const blocked = this._cameraBlockedReason();
    if (blocked) {
      this._feedback(blocked, "err");
      return;
    }
    const md = this._mediaDevices();
    if (!sel || !md?.enumerateDevices) {
      this._feedback("Camera API unavailable in this browser", "err");
      return;
    }
    // Do not call getUserMedia here — that causes a second permission prompt.
    // After Start camera once, labels usually populate.
    try {
      const devices = await md.enumerateDevices();
      const cams = devices.filter((d) => d.kind === "videoinput");
      const prev = sel.value;
      sel.innerHTML = "";
      if (!cams.length) {
        sel.innerHTML = `<option value="">No cameras found — Start camera first</option>`;
        return;
      }
      cams.forEach((d, i) => {
        const opt = document.createElement("option");
        opt.value = d.deviceId;
        opt.textContent = d.label || `Camera ${i + 1}`;
        sel.appendChild(opt);
      });
      if (prev) sel.value = prev;
      if (!this._cameraPermitted) {
        const hint = this._cameraHttpHint();
        this._feedback(
          hint
            ? `Camera list loaded — Start camera to grant access. ${hint}`
            : "Camera list loaded — Start camera if needed",
          "ok"
        );
      }
    } catch (err) {
      this._feedback(`Camera list failed: ${this._errText(err)}`, "err");
    }
  }

  async _startCamera() {
    const blocked = this._cameraBlockedReason();
    if (blocked) {
      this._feedback(blocked, "err");
      return;
    }
    const md = this._mediaDevices();
    this._teardownCamera();
    const deviceId = this.shadowRoot.getElementById("camera-select").value;
    const constraints = {
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { width: { ideal: 1280 }, height: { ideal: 720 } },
    };
    try {
      this._stream = await md.getUserMedia(constraints);
      this._cameraPermitted = true;
      const live = this.shadowRoot.getElementById("live-video");
      const review = this.shadowRoot.getElementById("review-video");
      live.srcObject = this._stream;
      live.classList.remove("hidden");
      review.classList.add("hidden");
      this._blob = null;
      const hint = this._cameraHttpHint();
      this._feedback(hint ? `Camera live. ${hint}` : "Camera live", "ok");
      this._setRecStatus("Ready");
      await this._refreshCameras();
    } catch (err) {
      const hint = this._cameraHttpHint();
      this._feedback(
        `Camera failed: ${this._errText(err)}${hint ? ` — ${hint}` : ""}`,
        "err"
      );
    }
  }

  _pickMime() {
    const candidates = [
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ];
    for (const m of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
    }
    return "";
  }

  async _recordClip() {
    if (!this._stream) {
      await this._startCamera();
      if (!this._stream) return;
    }
    if (this._recorder && this._recorder.state === "recording") {
      return this._feedback("Already recording", "warn");
    }

    let secs = Number(this.shadowRoot.getElementById("fld-seconds").value) || 4;
    secs = Math.min(5, Math.max(3, secs));
    this._chunks = [];
    this._blob = null;

    const mime = this._pickMime();
    try {
      this._recorder = mime
        ? new MediaRecorder(this._stream, { mimeType: mime })
        : new MediaRecorder(this._stream);
    } catch (err) {
      return this._feedback(`MediaRecorder failed: ${this._errText(err)}`, "err");
    }

    this._recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size) this._chunks.push(ev.data);
    };
    this._recorder.onstop = () => {
      this._blob = new Blob(this._chunks, {
        type: (this._recorder && this._recorder.mimeType) || "video/webm",
      });
      const review = this.shadowRoot.getElementById("review-video");
      const live = this.shadowRoot.getElementById("live-video");
      if (review.src && review.src.startsWith("blob:")) URL.revokeObjectURL(review.src);
      review.src = URL.createObjectURL(this._blob);
      review.classList.remove("hidden");
      live.classList.add("hidden");
      this._setRecStatus(`Captured ${(this._blob.size / 1024).toFixed(0)} KB`);
      this._feedback("Clip ready — review, retake, or create poster", "ok");
    };

    let left = 3;
    this._setRecStatus(`Recording in ${left}…`);
    this._countdownTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(this._countdownTimer);
        this._countdownTimer = null;
        this._recorder.start(200);
        this._setRecStatus(`Recording ${secs}s…`);
        this._recordTimer = setTimeout(() => {
          if (this._recorder && this._recorder.state === "recording") this._recorder.stop();
          this._recordTimer = null;
        }, secs * 1000);
      } else {
        this._setRecStatus(`Recording in ${left}…`);
      }
    }, 1000);
  }

  _retake() {
    const review = this.shadowRoot.getElementById("review-video");
    if (review.src && review.src.startsWith("blob:")) URL.revokeObjectURL(review.src);
    review.removeAttribute("src");
    review.classList.add("hidden");
    this._blob = null;
    this._chunks = [];
    const upload = this.shadowRoot.getElementById("fld-upload");
    if (upload) upload.value = "";
    this._startCamera();
  }

  _onUpload(ev) {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    this._blob = file;
    const review = this.shadowRoot.getElementById("review-video");
    const live = this.shadowRoot.getElementById("live-video");
    if (review.src && review.src.startsWith("blob:")) URL.revokeObjectURL(review.src);
    review.src = URL.createObjectURL(file);
    review.classList.remove("hidden");
    live.classList.add("hidden");
    this._setRecStatus(`Upload ready: ${file.name} (${(file.size / 1024).toFixed(0)} KB)`);
    this._feedback("Upload loaded — create poster to save", "ok");
  }

  async _submit() {
    const root = this.shadowRoot;
    const name = root.getElementById("fld-name").value.trim();
    const allegiance = root.getElementById("fld-allegiance").value;
    const faction = root.getElementById("fld-faction").value.trim();
    if (!name) return this._feedback("Name required", "warn");
    if (!this._blob) return this._feedback("Record or upload a clip first", "warn");

    const crimes = root
      .getElementById("fld-crimes")
      .value.split(/\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const stats = {
      height: root.getElementById("fld-height").value.trim() || "5'10\"",
      weight: root.getElementById("fld-weight").value.trim() || "165 LBS",
      age: root.getElementById("fld-age").value.trim() || "29",
    };
    const bounty = Number(root.getElementById("fld-bounty").value) || 1000000;
    const flavor = root.getElementById("fld-flavor").value.trim();
    const playerId = this._selected?.id != null ? String(this._selected.id) : "";
    if (!playerId) return this._feedback("Select a player from the roster first", "warn");
    const role = this._getRole();

    const form = new FormData();
    form.append("name", name);
    form.append("allegiance", allegiance);
    form.append("faction", faction);
    form.append("role", role);
    form.append("player_id", playerId);
    form.append("bounty_amount", String(bounty));
    form.append("crimes", JSON.stringify(crimes));
    form.append("stats", JSON.stringify(stats));
    form.append("flavor_text", flavor);
    const safe = name.replace(/\s+/g, "_").toLowerCase();
    const filename =
      this._blob instanceof File && this._blob.name
        ? this._blob.name
        : `${safe}.webm`;
    form.append("video", this._blob, filename);

    try {
      this._feedback("Uploading poster…", "ok");
      const resp = await fetch(`${this._serverUrl}/api/posters`, {
        method: "POST",
        body: form,
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        return this._feedback(`Upload failed (${resp.status}): ${JSON.stringify(body)}`, "err");
      }
      this._existingPoster = body;
      const link = root.getElementById("poster-link");
      const url = body.poster_url || this._posterUrlForPlayer(playerId);
      link.href = url;
      link.textContent = url;
      root.getElementById("success-box").hidden = false;
      this._feedback(`Poster saved for player ${playerId}`, "ok");
    } catch (err) {
      this._feedback(`Upload failed: ${this._errText(err)}`, "err");
    }
  }

  _saveServerUrl() {
    const inp = this.shadowRoot.getElementById("server-url-input");
    const url = (inp?.value || "").trim().replace(/\/$/, "");
    if (!url) return;
    localStorage.setItem("bounty_server_url", url);
    this._serverUrl = url;
    this.shadowRoot.getElementById("server-url-dialog").style.display = "none";
    this._feedback(`Bounty server: ${url}`, "ok");
  }

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        @import url("/local/bounty/alleycat-panel.css");
        :host {
          display: block; height: 100%; overflow: auto;
          background: var(--primary-background-color);
          color: var(--primary-text-color);
        }
        .wrap { max-width: 1200px; margin: 0 auto; padding: 1rem 1.25rem 2rem; }
        .page-header {
          display: flex; justify-content: space-between; align-items: center;
          padding-bottom: 0.75rem; margin-bottom: 1rem;
        }
        .page-header h1 { margin: 0; font-size: 1.25rem; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
        @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
        .card {
          background: var(--card-background-color, #111);
          border: 1px solid var(--divider-color, #1f3a44);
          border-radius: 4px; padding: 1rem;
        }
        .card h2 {
          margin: 0 0 0.75rem; font-size: 0.95rem;
          letter-spacing: 0.12em; text-transform: uppercase;
          color: var(--ac-cyan, #00e5ff);
        }
        label {
          display: block; font-size: 0.7rem; letter-spacing: 0.1em;
          margin: 0.55rem 0 0.2rem; opacity: 0.75;
        }
        input, select, textarea, button {
          font: inherit; width: 100%; box-sizing: border-box;
          background: rgba(0,0,0,0.35); color: inherit;
          border: 1px solid var(--divider-color, #1f3a44);
          border-radius: 3px; padding: 0.45rem 0.55rem;
        }
        textarea { min-height: 5.5rem; resize: vertical; }
        .row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0.5rem; }
        .actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.75rem; }
        .actions button { width: auto; cursor: pointer; }
        button.primary { border-color: var(--ac-cyan, #00e5ff); color: var(--ac-cyan, #00e5ff); }
        button.danger { border-color: #ff4d5a; color: #ff4d5a; }
        .preview {
          position: relative; background: #000; aspect-ratio: 16/9;
          border: 1px solid var(--divider-color, #1f3a44); overflow: hidden;
          margin-top: 0.75rem;
        }
        .preview video { width: 100%; height: 100%; object-fit: cover; display: block; }
        .preview video.hidden { display: none; }
        .rec-status {
          margin-top: 0.4rem; font-size: 0.8rem; min-height: 1.2em;
          color: var(--ac-cyan, #00e5ff);
        }
        .feedback { margin-top: 0.75rem; font-size: 0.85rem; min-height: 1.2em; }
        .feedback.ok { color: #6dffb0; }
        .feedback.warn { color: #ffd166; }
        .feedback.err { color: #ff6b7a; }
        #success-box {
          margin-top: 0.75rem; padding: 0.75rem;
          border: 1px solid var(--ac-cyan, #00e5ff);
        }
        #success-box a { color: var(--ac-cyan, #00e5ff); word-break: break-all; }
        .dialog {
          display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.55);
          align-items: center; justify-content: center; z-index: 20;
        }
        .dialog-inner {
          background: var(--card-background-color, #111); padding: 1rem;
          width: min(420px, 90vw); border: 1px solid var(--divider-color);
        }
        .hint { font-size: 0.7rem; opacity: 0.65; margin-top: 0.35rem; }
        .mac-row { display: flex; gap: 0.5rem; align-items: center; }
        .mac-row input { flex: 1; }
        .mac-row button { width: auto; }
        .cam-row {
          display: grid;
          grid-template-columns: 2fr 1fr auto auto;
          gap: 0.5rem;
          align-items: end;
        }
        @media (max-width: 700px) {
          .cam-row { grid-template-columns: 1fr 1fr; }
        }
        .combo { position: relative; }
        .combo-list {
          position: absolute; left: 0; right: 0; top: 100%; z-index: 5;
          max-height: 220px; overflow: auto;
          background: var(--card-background-color, #111);
          border: 1px solid var(--divider-color, #1f3a44);
        }
        .combo-item {
          display: block; width: 100%; text-align: left; cursor: pointer;
          border: 0; border-bottom: 1px solid var(--divider-color, #1f3a44);
          border-radius: 0; background: transparent;
        }
        .combo-item:hover { background: rgba(0, 229, 255, 0.08); }
        .combo-empty { padding: 0.5rem; opacity: 0.6; font-size: 0.8rem; }
        .upload-row { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
        .upload-row input[type=file] { flex: 1; min-width: 180px; }
      </style>
      <div class="wrap">
        <header class="page-header">
          <h1>Galactic Bounty Network</h1>
          <div class="actions">
            <button type="button" id="btn-reload">Reload roster</button>
            <button type="button" id="btn-server">Server URL</button>
          </div>
        </header>

        <div class="grid">
          <section class="card">
            <h2>Subject</h2>
            <label for="player-combo-input">Registration roster</label>
            <div class="combo">
              <input id="player-combo-input" autocomplete="off" placeholder="Type a name or open the list…" />
              <div id="player-combo-list" class="combo-list" hidden></div>
            </div>
            <label for="fld-name">Name</label>
            <input id="fld-name" autocomplete="off" />
            <label for="fld-allegiance">NeoCorp</label>
            <select id="fld-allegiance">
              <option value="reboot">reboot</option>
              <option value="helix">helix</option>
              <option value="endline">endline</option>
              <option value="freelancer" selected>freelancer</option>
            </select>
            <label for="fld-faction">Faction</label>
            <input id="fld-faction" autocomplete="off" />
            <label for="fld-mac">Simulate MAC intake (FDN later)</label>
            <div class="mac-row">
              <input id="fld-mac" placeholder="aa:bb:cc:dd:ee:ff" />
              <button type="button" id="btn-intake">Simulate</button>
            </div>
            <p class="hint">MAC → player lookup is stubbed (501) until Central supports it.</p>
          </section>

          <section class="card">
            <h2 id="flavor-card-title">Flavor / crimes</h2>
            <label for="fld-bounty">Mock bounty (₩)</label>
            <input id="fld-bounty" type="number" min="0" step="10000" value="1000000" />
            <label id="lbl-list-field" for="fld-crimes">Crimes / Wanted for (one per line)</label>
            <textarea id="fld-crimes"></textarea>
            <div class="row">
              <div>
                <label for="fld-height">Height</label>
                <input id="fld-height" />
              </div>
              <div>
                <label for="fld-weight">Weight</label>
                <input id="fld-weight" />
              </div>
              <div>
                <label for="fld-age">Age</label>
                <input id="fld-age" />
              </div>
            </div>
            <label for="fld-flavor">Flavor text</label>
            <textarea id="fld-flavor"></textarea>
            <div class="actions">
              <button type="button" class="primary" id="btn-generate">Generate</button>
            </div>
            <p class="hint">Templates now; later this can poll the on-site AI model.</p>
          </section>

          <section class="card" style="grid-column: 1 / -1">
            <h2>Capture (3–5s)</h2>
            <div class="cam-row">
              <div>
                <label for="camera-select">Camera</label>
                <select id="camera-select"></select>
              </div>
              <div>
                <label for="fld-seconds">Seconds</label>
                <input id="fld-seconds" type="number" min="3" max="5" value="4" />
              </div>
              <button type="button" id="btn-cam-refresh">Refresh cams</button>
              <button type="button" id="btn-cam-start">Start camera</button>
            </div>
            <div class="preview">
              <video id="live-video" autoplay muted playsinline></video>
              <video id="review-video" class="hidden" controls loop playsinline></video>
            </div>
            <div class="rec-status" id="rec-status"></div>
            <div class="actions">
              <button type="button" class="danger" id="btn-record">Record</button>
              <button type="button" id="btn-retake">Retake</button>
              <label class="upload-row" style="width:auto;margin:0">
                <input type="file" id="fld-upload" accept="video/*" />
              </label>
              <button type="button" class="primary" id="btn-submit">Create poster</button>
            </div>
            <p class="hint">Upload a video file instead of recording. Retake clears upload and returns to camera.</p>
            <div id="success-box" hidden>
              <strong>Poster live</strong>
              <div><a id="poster-link" href="#" target="_blank" rel="noopener"></a></div>
            </div>
          </section>
        </div>

        <div class="feedback" id="feedback"></div>
      </div>

      <div class="dialog" id="server-url-dialog">
        <div class="dialog-inner">
          <h2 style="margin-top:0">Bounty server URL</h2>
          <input id="server-url-input" />
          <div class="actions">
            <button type="button" class="primary" id="btn-server-save">Save</button>
            <button type="button" id="btn-server-cancel">Cancel</button>
          </div>
        </div>
      </div>
    `;

    const root = this.shadowRoot;
    root.getElementById("btn-reload").onclick = () => this._loadPlayers();
    root.getElementById("btn-generate").onclick = () => this._generateFlavor();
    root.getElementById("btn-intake").onclick = () => this._simulateIntake();
    root.getElementById("btn-cam-refresh").onclick = () => this._refreshCameras();
    root.getElementById("btn-cam-start").onclick = () => this._startCamera();
    root.getElementById("btn-record").onclick = () => this._recordClip();
    root.getElementById("btn-retake").onclick = () => this._retake();
    root.getElementById("btn-submit").onclick = () => this._submit();
    root.getElementById("fld-upload").onchange = (ev) => this._onUpload(ev);

    const combo = root.getElementById("player-combo-input");
    combo.onfocus = () => {
      this._renderComboList(combo.value);
      this._setComboOpen(true);
    };
    combo.oninput = () => {
      this._renderComboList(combo.value);
      this._setComboOpen(true);
    };
    combo.onkeydown = (ev) => {
      if (ev.key === "Escape") this._setComboOpen(false);
      if (ev.key === "ArrowDown") {
        this._renderComboList(combo.value);
        this._setComboOpen(true);
      }
    };
    root.addEventListener("click", (ev) => {
      const path = ev.composedPath();
      if (!path.includes(combo) && !path.includes(root.getElementById("player-combo-list"))) {
        this._setComboOpen(false);
      }
    });

    root.getElementById("btn-server").onclick = () => {
      root.getElementById("server-url-input").value = this._serverUrl || "";
      root.getElementById("server-url-dialog").style.display = "flex";
    };
    root.getElementById("btn-server-save").onclick = () => this._saveServerUrl();
    root.getElementById("btn-server-cancel").onclick = () => {
      root.getElementById("server-url-dialog").style.display = "none";
    };
    this._updateRoleUi();
  }
}

customElements.define("bounty-panel", BountyPanel);
