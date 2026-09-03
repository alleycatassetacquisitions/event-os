/* Alleycat CRT overlay + dark form controls. extra_module_url — not card-mod. */
const STYLE_ID = "alleycat-scanlines";
const INPUT_STYLE_ATTR = "data-alleycat-inputs";
const FILL = "#0d1418";
const INK = "#e6fbff";
const MUTED = "#7aa8b8";
const LINE = "#1f3a44";

const INPUT_CSS = `
  :host, :root { color-scheme: dark; }
  input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="file"]):not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]),
  textarea,
  select {
    background-color: ${FILL} !important;
    color: ${INK} !important;
    border-color: ${LINE};
    color-scheme: dark;
    caret-color: ${INK};
  }
  input::placeholder, textarea::placeholder { color: ${MUTED}; opacity: 1; }
`;

function injectInputStyle(root) {
  if (!root || (root.querySelector && root.querySelector(`style[${INPUT_STYLE_ATTR}]`))) {
    return;
  }
  try {
    const style = document.createElement("style");
    style.setAttribute(INPUT_STYLE_ATTR, "");
    style.textContent = INPUT_CSS;
    (root.head || root).appendChild(style);
  } catch {
    /* closed or detached root */
  }
}

function walkShadows(node) {
  if (!node) return;
  const root = node.shadowRoot;
  if (root) {
    injectInputStyle(root);
    walkShadows(root);
  }
  const kids = node.querySelectorAll ? node.querySelectorAll("*") : [];
  for (const el of kids) {
    if (el.shadowRoot) {
      injectInputStyle(el.shadowRoot);
      walkShadows(el.shadowRoot);
    }
  }
}

if (!document.getElementById(STYLE_ID)) {
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    html {
      color-scheme: dark;
      --ha-color-form-background: ${FILL};
      --ha-color-form-background-hover: #121820;
      --ha-color-form-background-disabled: #10151c;
      --ha-color-form-ink-color: ${INK};
      --ha-color-text-primary: ${INK};
      --ha-color-on-surface-default: ${INK};
      --input-fill-color: ${FILL};
      --input-ink-color: ${INK};
      --input-label-ink-color: ${MUTED};
      --mdc-text-field-fill-color: ${FILL};
      --mdc-text-field-ink-color: ${INK};
      --mdc-select-fill-color: ${FILL};
      --mdc-select-ink-color: ${INK};
      --md-sys-color-surface: #10151c;
      --md-sys-color-on-surface: ${INK};
      --md-sys-color-on-surface-variant: ${MUTED};
      --md-sys-color-surface-container: #10151c;
      --md-sys-color-surface-container-high: #121820;
      --md-sys-color-surface-container-highest: #162028;
      --md-filled-text-field-container-color: ${FILL};
      --md-filled-text-field-input-text-color: ${INK};
      --md-outlined-text-field-input-text-color: ${INK};
    }
    html::after {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 2147483646;
      background-image: repeating-linear-gradient(
        180deg,
        transparent 0,
        transparent 2px,
        rgba(0, 229, 255, 0.09) 3px
      );
    }
    ${INPUT_CSS}
  `;
  document.documentElement.appendChild(style);
}

const origAttachShadow = Element.prototype.attachShadow;
Element.prototype.attachShadow = function alleycatAttachShadow(init) {
  const root = origAttachShadow.call(this, init);
  injectInputStyle(root);
  return root;
};

injectInputStyle(document);
walkShadows(document.documentElement);

const pending = new Set();
let walkQueued = false;
new MutationObserver((records) => {
  for (const rec of records) {
    for (const node of rec.addedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) pending.add(node);
    }
  }
  if (walkQueued) return;
  walkQueued = true;
  requestAnimationFrame(() => {
    walkQueued = false;
    for (const node of pending) walkShadows(node);
    pending.clear();
  });
}).observe(document.documentElement, { childList: true, subtree: true });

export {};
