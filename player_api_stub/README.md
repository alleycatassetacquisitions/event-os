# Player API stub

LAN HTTP stub for Mission Control. Same JSON shape as today’s photobooth `GET /api/players`, plus name check and create. Swap Home Assistant `base_url` to the real Rust Central later without changing the panel.

## Run

```bash
cd player_api_stub
cargo run --release
```

Default bind: `0.0.0.0:8090`. Override with `PLAYER_API_BIND=0.0.0.0:8090`.

Home Assistant on the LAN must be able to reach this host (not `localhost` from inside the HA OS VM — use the Windows/LAN IP).

## Contract

| Method | Path | Response |
|---|---|---|
| GET | `/health` | `{ "status": "ok" }` |
| GET | `/api/players?rows=&page=` | `{ "data": [ { "id", "name", "hunter", "allegiance" } ] }` |
| GET | `/api/players/check?name=` | `{ "available": true\|false }` |
| POST | `/api/players` | body `{ name, hunter, allegiance }` → player or **409** |
| GET | `/openapi.json` | OpenAPI 3 spec |
| GET | `/docs` | Swagger UI |
