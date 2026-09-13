# Registration Home Assistant package

**Canonical tree** (edit only here):

`Z:\CodingProjects\Alleycat\ProjectMissionControl\HomeAssistConfig`

Do not use `Z:\CodingProjects\Alleycat\ProjectAlleycatTV` or `Z:\CodingProjects\Alleycat\ProjectBounty` if they still exist on disk â€” leftover duplicates.

```
HomeAssistConfig/
  Config/                    â† HA YAML, themes, www (panel JS may be junctions)
  ProjectAlleycatTV/          â† Pi client, content server, alleycattv integration
  registration/
  digital_node_nexus/
  ProjectBounty/
  alleycat_directory/        ← Core Configurator (app endpoint authority)
  ProjectBuggy/              ← Bug Buster (Proxmox LXC debug)
```

Copy into the HA config directory (OS / Supervised):

```
config/
  configuration.yaml          â† from Config/
  secrets.yaml
  rest.yaml
  rest_commands.yaml
  automations.yaml
  scripts.yaml
  scenes.yaml
  themes/alleycat.yaml
  custom_components/
    digital_node_nexus/          â† from digital_node_nexus/ha_digital_node_nexus/custom_components/digital_node_nexus/
    alleycattv/                â† from ProjectAlleycatTV/ha_integration/custom_components/alleycattv/
    registration/          â† from registration/custom_components/registration/
    bounty/                â† from ProjectBounty/ha_integration/custom_components/bounty/
    alleycat_directory/      â† from alleycat_directory/custom_components/alleycat_directory/
    bugbuster/               â† from ProjectBuggy/ha_integration/custom_components/bugbuster/
  www/
    custom-sidebar-config.yaml â† HACS custom-sidebar title (Alleycat Registration)
    alleycat-scanlines.js     â† CRT overlay (Home dashboard is not hui-view)
    alleycat-panel.css        â† shared neon chrome (optional extra copy)
    digital_node_nexus/          â† panel JS + alleycat-panel.css
    alleycattv/                â† alleycattv-panel.js + alleycattv-content-panel.js + alleycat-panel.css
    registration/          â† registration-panel.js + alleycat-panel.css
    bounty/                â† bounty-panel.js (copy or junction from ProjectBounty/www/bounty)
    directory/               â† Core Configurator panel + directory-client.js
    bugbuster/               â† Bug Buster panel + xterm vendor
```

1. Edit `secrets.yaml` so `player_api_base` / `bounty_base` are LAN URLs Home Assistant can reach (not localhost if HA is a VM).
2. Run `player_api_stub` (`cargo run --release` in `player_api_stub/`). Requires Rust (`rustup`). Run ProjectBounty (`ProjectBounty/README.md`).
3. Settings → Devices → add Core Configurator, Registration, Digital Node Nexus, AlleycatTV, ProjectBounty, Bug Buster if YAML import did not create entries.
4. Profile â†’ Theme â†’ **Alleycat**. Install HACS, then **card-mod** and **custom-sidebar**. Both also need `frontend.extra_module_url` in `configuration.yaml` (HACS download alone is not enough). Restart HA, then hard-refresh. Scanlines only appear on Lovelace (Overview), not the custom sidebar panels. If card-mod loads twice, copy the exact URL from Settings â†’ Dashboards â†’ â‹® â†’ Resources into `extra_module_url` (it may include `?hacstag=...`).
5. Create HA Areas for locations; create AlleycatTV zones in Content Manager; assign FDN placement in Digital Node Nexus â†’ Placement. Assign Pi location on the AlleycatTV live panel.
