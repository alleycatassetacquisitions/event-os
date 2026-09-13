"""Constants for Alleycat Service Directory — source of truth for app endpoints."""

DOMAIN = "alleycat_directory"
EVENT_UPDATED = f"{DOMAIN}_updated"

# Stable keys other integrations and panels look up. Do not rename.
KEY_REGISTRATION_PRIMARY = "registration_primary"
KEY_REGISTRATION_SECONDARY = "registration_secondary"
KEY_ALLEYCATTV = "alleycattv"
KEY_BOUNTY = "bounty"
KEY_PROXMOX = "proxmox"

SERVICE_CATALOG = (
    {
        "key": KEY_REGISTRATION_PRIMARY,
        "label": "Registration · online",
        "hint": "Cloud / DigitalOcean player API",
        "apps": ["Registration"],
        "placeholder": "https://alleycat-dl83g.ondigitalocean.app",
    },
    {
        "key": KEY_REGISTRATION_SECONDARY,
        "label": "Registration · local",
        "hint": "LAN player API",
        "apps": ["Registration"],
        "placeholder": "http://192.168.1.234:8090",
    },
    {
        "key": KEY_ALLEYCATTV,
        "label": "AlleycatTV streaming server",
        "hint": "Content API, media, zones",
        "apps": ["AlleycatTV", "Content Manager", "Digital Node Nexus"],
        "placeholder": "http://headless-alleycat-streaming-server.local",
    },
    {
        "key": KEY_BOUNTY,
        "label": "Galactic Bounty Network",
        "hint": "Poster capture and display server",
        "apps": ["GBN", "Registration posters"],
        "placeholder": "http://192.168.1.206:8100",
    },
    {
        "key": KEY_PROXMOX,
        "label": "Proxmox",
        "hint": "Hypervisor API (Bug Buster)",
        "apps": ["Bug Buster"],
        "placeholder": "https://192.168.1.1:8006",
        "extra_fields": (
            {"key": "node", "label": "Node name", "placeholder": "pve"},
            {"key": "token_id", "label": "API token ID", "placeholder": "root@pam!bugbuster"},
            {
                "key": "token_secret",
                "label": "API token secret",
                "placeholder": "UUID from Proxmox",
                "secret": True,
            },
        ),
    },
)

DEFAULTS = {
    KEY_REGISTRATION_PRIMARY: "https://alleycat-dl83g.ondigitalocean.app",
    KEY_REGISTRATION_SECONDARY: "http://192.168.1.234:8090",
    KEY_ALLEYCATTV: "http://headless-alleycat-streaming-server.local",
    KEY_BOUNTY: "http://192.168.1.206:8100",
    KEY_PROXMOX: "https://192.168.1.1:8006",
}

YAML_KEYS = (
    KEY_REGISTRATION_PRIMARY,
    KEY_REGISTRATION_SECONDARY,
    KEY_ALLEYCATTV,
    KEY_BOUNTY,
    KEY_PROXMOX,
    "proxmox_node",
    "proxmox_token_id",
    "proxmox_token_secret",
)
