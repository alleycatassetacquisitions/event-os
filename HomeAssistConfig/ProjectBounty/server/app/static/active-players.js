(function () {
  const cfg = window.GBN_ACTIVE || {};
  const ids = Array.isArray(cfg.playerIds) ? cfg.playerIds.map(String) : [];
  const intervalMs = Math.max(5000, (cfg.intervalSec || 30) * 1000);
  const base = (cfg.publicBase || "").replace(/\/$/, "");
  const frame = document.getElementById("poster-frame");
  const hud = document.getElementById("hud");
  const hudLabel = document.getElementById("hud-label");
  let index = 0;

  function posterUrl(playerId) {
    return `${base}/poster/player/${encodeURIComponent(playerId)}`;
  }

  function showCurrent() {
    if (!ids.length) {
      frame.src = "about:blank";
      if (hud) hud.hidden = false;
      if (hudLabel) hudLabel.textContent = "NO ACTIVE PLAYERS";
      return;
    }
    const pid = ids[index % ids.length];
    const next = ids[(index + 1) % ids.length];
    frame.src = posterUrl(pid);
    if (hud) hud.hidden = false;
    if (hudLabel) {
      hudLabel.textContent = `PLAYER ${pid} · ${index % ids.length + 1}/${ids.length}`;
    }
    if (next && next !== pid) {
      const prefetch = document.createElement("link");
      prefetch.rel = "prefetch";
      prefetch.href = posterUrl(next);
      document.head.appendChild(prefetch);
    }
  }

  async function refreshPlaylist() {
    try {
      const resp = await fetch("/api/active-players");
      if (!resp.ok) return;
      const data = await resp.json();
      if (Array.isArray(data.player_ids) && data.player_ids.length) {
        cfg.playerIds = data.player_ids.map(String);
        ids.length = 0;
        ids.push(...cfg.playerIds);
      }
    } catch (_) {
      /* keep local boot config */
    }
  }

  showCurrent();
  setInterval(() => {
    if (!ids.length) return;
    index = (index + 1) % ids.length;
    showCurrent();
  }, intervalMs);

  setInterval(refreshPlaylist, 15000);
})();
