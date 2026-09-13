/**
 * Shared Service Directory client for Mission Control panels.
 * Loaded via extra_module_url before feature panels.
 *
 * window.AlleycatDirectory.getUrl(hass, key, fallback)
 * window.AlleycatDirectory.setService(hass, key, { url, extra })
 * window.AlleycatDirectory.getServices(hass)
 * window.AlleycatDirectory.subscribe(hass, callback) → unsub
 */
(function attachAlleycatDirectory(global) {
  const TYPE_GET = "alleycat_directory/get_url";
  const TYPE_LIST = "alleycat_directory/get_services";
  const TYPE_SET = "alleycat_directory/set_service";
  const EVENT = "alleycat_directory_updated";

  function strip(url) {
    return String(url || "").replace(/\/$/, "");
  }

  async function getUrl(hass, key, fallback = "") {
    if (!hass?.connection) return strip(fallback);
    try {
      const res = await hass.connection.sendMessagePromise({ type: TYPE_GET, key });
      return strip(res.url || fallback);
    } catch (_) {
      return strip(fallback);
    }
  }

  async function getServices(hass) {
    if (!hass?.connection) return [];
    try {
      const res = await hass.connection.sendMessagePromise({ type: TYPE_LIST });
      return res.services || [];
    } catch (_) {
      return [];
    }
  }

  async function setService(hass, key, { url, extra } = {}) {
    const msg = { type: TYPE_SET, key };
    if (url != null) msg.url = url;
    if (extra != null) msg.extra = extra;
    return hass.connection.sendMessagePromise(msg);
  }

  async function subscribe(hass, callback) {
    if (!hass?.connection) return () => {};
    return hass.connection.subscribeEvents((ev) => {
      callback(ev.data || {});
    }, EVENT);
  }

  global.AlleycatDirectory = { getUrl, getServices, setService, subscribe };
})(typeof window !== "undefined" ? window : globalThis);
