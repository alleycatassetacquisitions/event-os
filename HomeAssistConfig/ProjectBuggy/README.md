# Bug Buster (ProjectBuggy)

Mission Control debug tab: LXC fleet from Proxmox, MQTT spy, in-browser container console.

```
ProjectBuggy/
  ha_integration/custom_components/bugbuster/
  www/bugbuster/                 # panel JS + xterm vendor
```

## Deploy

Copy `ha_integration/custom_components/bugbuster/` → HA `config/custom_components/bugbuster/`.
Copy `www/bugbuster/` → `config/www/bugbuster/` (already in `Config/www/bugbuster/` in this tree).

YAML is already in `Config/configuration.yaml` (`panel_custom` + `bugbuster:` tokens). Proxmox URL and node live in **Core Configurator**. Restart HA and hard-refresh.

Put a real Proxmox API token in `secrets.yaml` (`bugbuster_token_id` / `bugbuster_token_secret`). Directory does not store tokens.
