# ProjectBounty — Galactic Bounty Network

Cyberpunk bounty-poster capture and display for Alleycat Mission Control.

## Layout

```
ProjectBounty/
  server/             # FastAPI — posters, media, flavor, active playlist
  ha_integration/     # custom_components/bounty
  www/bounty/         # Mission Control panel JS/CSS
```

### Media on Bounty-Server

```
media/
  videos/{player_id}.webm   # subject clips (stable URL for other Alleycat apps)
  assets/
    neocorp/                # reboot.svg, helix.svg, endline.svg, freelancer.svg
    animations/             # future overlays
    marks/                  # Fixer's Mark, badges (future)
```

Drop final NeoCorp SVGs into `media/assets/neocorp/` on the server — no Python redeploy needed.

## Deploy to Ubuntu (Bounty-Server)

Production host: `root@Bounty-Server` (`192.168.1.206`), Ubuntu 24.04 LTS.

```powershell
cd HomeAssistConfig\ProjectBounty\server
.\setup\deploy-to-server.ps1
```

On the server after code updates:

```bash
systemctl restart bounty-server
```

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | liveness |
| GET | `/api/posters` | list player profiles |
| GET | `/api/posters/by-player/{player_id}` | profile for player |
| GET | `/api/players/{player_id}` | same as by-player (Registration helper) |
| POST | `/api/posters` | multipart upsert — **requires `player_id`** |
| GET | `/poster/player/{player_id}` | canonical animated poster page |
| GET | `/poster/{legacy_id}` | legacy poster id or redirect to player |
| POST | `/api/flavor/generate` | `{ name, allegiance, role }` templates |
| GET/POST | `/api/active-players` | kiosk playlist state |
| GET | `/active-players` | full-screen 30s rotation page |

### Video URL convention (other projects)

`{BOUNTY_PUBLIC_BASE}/media/videos/{player_id}.webm`

### Active playlist (game server)

```bash
curl -X POST http://192.168.1.206:8100/api/active-players \
  -H "Content-Type: application/json" \
  -d '{"player_ids":["12","34"],"interval_sec":30}'
```

Open `http://192.168.1.206:8100/active-players` on a display machine.

Optional: set `BOUNTY_ACTIVE_PLAYERS_SECRET` and send `Authorization: Bearer …` on POST.

## Poster UX

- **Hunter** → headline `GUN FOR HIRE`, list `REASONS TO HIRE`
- **Bounty** → `WANTED` + `DEAD OR ALIVE`, list `WANTED FOR`
- NeoCorp shown via **logo** in footer (`/media/assets/neocorp/{allegiance}.svg`), not theme colors
- **STATUS** block under PHYSICAL (live overlay when Registration exposes score fields)
- Flavor ticker at bottom (score news feed)

## Home Assistant

Panel flow: pick roster player → Generate (role-aware) → record/upload → upsert poster.

Registration table **Poster** column: video thumb + link to `/poster/player/{id}`.

### Camera permissions

HTTPS required for persistent camera “Remember” on Zen/Firefox. Session Allow works on HTTP.

## Env

| Variable | Default |
|---|---|
| `BOUNTY_PUBLIC_BASE` | `http://127.0.0.1:8100` |
| `BOUNTY_REGISTRATION_BASE` | empty (no live overlay) |
| `BOUNTY_ACTIVE_PLAYERS_SECRET` | empty (open POST) |
| `BOUNTY_MEDIA` | `server/media` |
