# Core Configurator

Single source of truth for Alleycat app endpoints (P2 authority, P8 reusable primitive).

When the venue LAN changes, edit IPs here — Registration, AlleycatTV, Content Manager, GBN, and Bug Buster follow.

```
alleycat_directory/
  custom_components/alleycat_directory/
  www/directory/                 # sidebar panel + shared directory-client.js
```

## Services

| Key | Used by |
|-----|---------|
| `registration_primary` | Registration (online / DigitalOcean) |
| `registration_secondary` | Registration (local / LAN) |
| `alleycattv` | AlleycatTV, Content Manager, Digital Node Nexus zone list |
| `bounty` | Galactic Bounty Network, Registration poster column |
| `proxmox` | Bug Buster (`extra.node`, `extra.token_id`, `extra.token_secret`) |

## Other integrations

```python
from custom_components.alleycat_directory.helpers import get_url, apply_service

url = get_url(hass, "alleycattv")
```

Or read `hass.data["alleycat_directory"]["services"]`. Listen for `alleycat_directory_updated`.

Panels: `window.AlleycatDirectory.getUrl(hass, key)` (loaded via `directory-client.js`).

## Deploy

Copy `custom_components/alleycat_directory/` into HA `config/custom_components/alleycat_directory/`.
Copy `www/directory/` into `config/www/directory/`.

YAML seed is already in `Config/configuration.yaml` (`alleycat_directory:`). Restart HA, hard-refresh, open **Core Configurator** in the sidebar.
