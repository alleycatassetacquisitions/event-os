/**
 * Core Configurator — Mission Control source of truth for app endpoints.
 * Deploy: config/www/directory/
 */
class AlleycatDirectoryPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._initialized = false;
    this._services = [];
    this._unsub = null;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) {
      this._initialized = true;
      this._render();
      this._boot();
    }
  }

  connectedCallback() {
    if (this._hass && !this._initialized) {
      this._initialized = true;
      this._render();
      this._boot();
    }
  }

  disconnectedCallback() {
    this._initialized = false;
    if (this._unsub) {
      try { this._unsub(); } catch (_) { /* ignore */ }
      this._unsub = null;
    }
  }

  _dir() {
    return (typeof window !== "undefined" && window.AlleycatDirectory) || null;
  }

  async _boot() {
    this.shadowRoot.getElementById("btn-reload")?.addEventListener("click", () => this._load());
    await this._load();
    const dir = this._dir();
    if (dir?.subscribe) {
      this._unsub = await dir.subscribe(this._hass, () => this._load());
    }
  }

  async _load() {
    const dir = this._dir();
    try {
      this._services = dir
        ? await dir.getServices(this._hass)
        : (await this._hass.connection.sendMessagePromise({
            type: "alleycat_directory/get_services",
          })).services || [];
    } catch (err) {
      this._feedback(`Load failed: ${err.message || err}`, "err");
      return;
    }
    this._paint();
  }

  _feedback(msg, kind = "ok") {
    const el = this.shadowRoot.getElementById("feedback");
    if (!el) return;
    el.textContent = msg;
    el.className = `feedback ${kind}`;
  }

  _esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  _paint() {
    const list = this.shadowRoot.getElementById("cards");
    if (!list) return;
    if (!this._services.length) {
      list.innerHTML = `<p class="empty">No services yet. Check that Core Configurator is loaded.</p>`;
      return;
    }
    list.innerHTML = this._services.map((svc) => {
      const extras = (svc.extra_fields || []).map((f) => {
        const secret = Boolean(f.secret);
        const setFlag = Boolean((svc.extra || {})[`${f.key}_set`]);
        const raw = (svc.extra || {})[f.key] || "";
        const value = secret ? "" : raw;
        const placeholder = secret
          ? (setFlag ? "unchanged — type a new value to replace" : (f.placeholder || ""))
          : (f.placeholder || "");
        return `
        <label for="extra-${this._esc(svc.key)}-${this._esc(f.key)}">${this._esc(f.label)}</label>
        <input id="extra-${this._esc(svc.key)}-${this._esc(f.key)}" data-extra="${this._esc(f.key)}"
          type="${secret ? "password" : "text"}" value="${this._esc(value)}"
          placeholder="${this._esc(placeholder)}" autocomplete="${secret ? "new-password" : "off"}" />
      `;
      }).join("");
      const apps = (svc.apps || []).join(" · ");
      return `
        <article class="card" data-key="${this._esc(svc.key)}">
          <header>
            <h2>${this._esc(svc.label)}</h2>
            <span class="apps">${this._esc(apps)}</span>
          </header>
          <p class="hint">${this._esc(svc.hint || "")}</p>
          <label for="url-${this._esc(svc.key)}">URL or IP</label>
          <input id="url-${this._esc(svc.key)}" class="url" type="text"
            value="${this._esc(svc.url || "")}" placeholder="${this._esc(svc.placeholder || "")}" />
          ${extras}
          <div class="row">
            <button type="button" class="save">Apply</button>
            <span class="key">${this._esc(svc.key)}</span>
          </div>
        </article>`;
    }).join("");
    list.querySelectorAll(".card").forEach((card) => {
      card.querySelector(".save")?.addEventListener("click", () => this._save(card));
    });
  }

  async _save(card) {
    const key = card.dataset.key;
    const url = (card.querySelector(".url")?.value || "").trim();
    const extra = {};
    card.querySelectorAll("[data-extra]").forEach((inp) => {
      const val = inp.value.trim();
      if (inp.type === "password" && !val) return;
      extra[inp.dataset.extra] = val;
    });
    const dir = this._dir();
    try {
      if (dir) {
        await dir.setService(this._hass, key, { url, extra });
      } else {
        await this._hass.connection.sendMessagePromise({
          type: "alleycat_directory/set_service",
          key,
          url,
          extra,
        });
      }
      this._feedback(`Saved ${key}`, "ok");
      await this._load();
    } catch (err) {
      this._feedback(`Save failed: ${err.message || err}`, "err");
    }
  }

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        @import url("/local/directory/alleycat-panel.css");
        :host {
          display: block; height: 100%; overflow: auto;
          background: var(--primary-background-color, #0b1020);
          color: var(--primary-text-color, #e8eefc);
        }
        .wrap { max-width: 980px; margin: 0 auto; padding: 1rem 1.25rem 2rem; }
        .page-header { display: flex; align-items: flex-end; gap: 16px; padding-bottom: 12px; margin-bottom: 16px; }
        .page-header h1 { margin: 0; font-size: 20px; }
        .sub { margin: 4px 0 0; font-size: 13px; color: var(--secondary-text-color, #9aa8c7); }
        .stats { margin-left: auto; display: flex; gap: 8px; align-items: center; }
        .ghost {
          background: transparent; color: var(--ac-cyan, #00e5ff);
          border: 1px solid rgba(0,229,255,0.4); border-radius: 6px;
          padding: 6px 12px; cursor: pointer; font-family: inherit;
        }
        .feedback { font-size: 13px; min-height: 18px; }
        .feedback.ok { color: #7dffb3; }
        .feedback.err { color: #ff6b8a; }
        #cards {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: 12px;
        }
        .card {
          background: #12192e;
          border: 1px solid #2a3a5c;
          border-radius: 10px;
          padding: 16px;
        }
        .card h2 { margin: 0; font-size: 14px; letter-spacing: 0.06em; text-transform: uppercase; }
        .apps { display: block; font-size: 11px; color: var(--ac-cyan, #00e5ff); margin-top: 4px; }
        .hint { font-size: 12px; color: #9aa8c7; margin: 8px 0 12px; }
        label { display: block; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: #9aa8c7; margin: 8px 0 4px; }
        input {
          width: 100%; box-sizing: border-box; font-family: inherit;
          background: #0d1426; color: inherit; border: 1px solid #2a3a5c;
          border-radius: 6px; padding: 8px 10px;
        }
        .row { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
        .save {
          background: var(--ac-cyan, #00e5ff); color: #041016; border: 0;
          border-radius: 6px; padding: 8px 14px; font-weight: 600;
          cursor: pointer; font-family: inherit;
        }
        .key { font-size: 11px; color: #9aa8c7; }
        .empty { color: #9aa8c7; padding: 24px; text-align: center; }
      </style>
      <div class="wrap">
        <header class="page-header">
          <div>
            <h1>Core Configurator</h1>
            <p class="sub">Source of truth for Alleycat endpoints and Proxmox credentials. Change the network here — panels follow.</p>
          </div>
          <div class="stats">
            <span id="feedback" class="feedback"></span>
            <button type="button" class="ghost" id="btn-reload">Reload</button>
          </div>
        </header>
        <div id="cards"><p class="empty">Loading…</p></div>
      </div>
    `;
  }
}

if (!customElements.get("alleycat-directory-panel")) {
  customElements.define("alleycat-directory-panel", AlleycatDirectoryPanel);
}
