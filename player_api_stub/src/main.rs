//! Player API stub — REST + JSON contract for Mission Control.
//!
//! Implements the photobooth GET shape and the check/create/update routes HA needs.
//! Bind on LAN (default 0.0.0.0:8090). Point HA `base_url` here until Rust Central is live.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tower_http::cors::{Any, CorsLayer};
use utoipa::{OpenApi, ToSchema};
use utoipa_swagger_ui::SwaggerUi;
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct Player {
    pub id: String,
    pub name: String,
    /// 0 = civilian, 1 = hunter, 2 = bounty (legacy int kept for compat)
    pub hunter: u8,
    /// "hunter" | "bounty"
    pub role: String,
    pub allegiance: String,
    pub faction: String,
    pub neo_id: String,
}

#[derive(Clone, Serialize, ToSchema)]
pub struct PlayerList {
    pub data: Vec<Player>,
}

#[derive(Deserialize, ToSchema)]
pub struct PlayerCreate {
    pub name: String,
    #[serde(default)]
    pub role: String,
    /// legacy int field; ignored when `role` is present
    #[serde(default)]
    pub hunter: u8,
    #[serde(default)]
    pub allegiance: String,
    #[serde(default)]
    pub faction: String,
    #[serde(default)]
    pub neo_id: String,
}

#[derive(Deserialize, ToSchema)]
pub struct PlayerUpdate {
    pub name: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub allegiance: String,
    #[serde(default)]
    pub faction: String,
    #[serde(default)]
    pub neo_id: String,
}

#[derive(Serialize, ToSchema)]
pub struct NameCheck {
    pub available: bool,
}

#[derive(Serialize, ToSchema)]
pub struct Health {
    pub status: String,
}

#[derive(Deserialize)]
pub struct ListQuery {
    pub rows: Option<usize>,
    pub page: Option<usize>,
}

#[derive(Deserialize)]
pub struct CheckQuery {
    pub name: String,
}

#[derive(Serialize, ToSchema)]
pub struct ErrorBody {
    pub error: String,
}

struct AppState {
    players: RwLock<HashMap<String, Player>>,
}

#[derive(OpenApi)]
#[openapi(
    paths(health, list_players, check_name, create_player, update_player),
    components(schemas(Player, PlayerList, PlayerCreate, PlayerUpdate, NameCheck, Health, ErrorBody)),
    tags((name = "players", description = "Player registry"))
)]
struct ApiDoc;

fn resolve_role(role: &str, hunter: u8) -> (String, u8) {
    match role {
        "bounty" => ("bounty".to_string(), 2),
        "hunter" => ("hunter".to_string(), 1),
        _ if hunter == 2 => ("bounty".to_string(), 2),
        _ if hunter == 1 => ("hunter".to_string(), 1),
        _ => ("hunter".to_string(), 1),
    }
}

fn seed_players() -> HashMap<String, Player> {
    let samples = [
        ("1001", "Nyx",    "hunter", 1u8, "endline",  "", ""),
        ("1002", "Rook",   "bounty",  2,  "helix",    "", ""),
        ("1003", "Vesper", "hunter", 1,   "reboot",   "", ""),
    ];
    samples
        .into_iter()
        .map(|(id, name, role, hunter, allegiance, faction, neo_id)| {
            (
                id.to_string(),
                Player {
                    id: id.to_string(),
                    name: name.to_string(),
                    hunter,
                    role: role.to_string(),
                    allegiance: allegiance.to_string(),
                    faction: faction.to_string(),
                    neo_id: neo_id.to_string(),
                },
            )
        })
        .collect()
}

#[utoipa::path(get, path = "/health", responses((status = 200, body = Health)))]
async fn health() -> Json<Health> {
    Json(Health {
        status: "ok".to_string(),
    })
}

#[utoipa::path(
    get,
    path = "/api/players",
    params(
        ("rows" = Option<usize>, Query, description = "Page size"),
        ("page" = Option<usize>, Query, description = "1-based page")
    ),
    responses((status = 200, body = PlayerList))
)]
async fn list_players(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ListQuery>,
) -> Json<PlayerList> {
    let mut list: Vec<Player> = state.players.read().await.values().cloned().collect();
    list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    let rows = q.rows.unwrap_or(100).max(1);
    let page = q.page.unwrap_or(1).max(1);
    let start = (page - 1).saturating_mul(rows);
    let data = list.into_iter().skip(start).take(rows).collect();
    Json(PlayerList { data })
}

fn names_equal(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

#[utoipa::path(
    get,
    path = "/api/players/check",
    params(("name" = String, Query, description = "Player display name")),
    responses((status = 200, body = NameCheck))
)]
async fn check_name(
    State(state): State<Arc<AppState>>,
    Query(q): Query<CheckQuery>,
) -> Json<NameCheck> {
    let taken = state
        .players
        .read()
        .await
        .values()
        .any(|p| names_equal(&p.name, &q.name));
    Json(NameCheck {
        available: !taken && !q.name.trim().is_empty(),
    })
}

#[utoipa::path(
    post,
    path = "/api/players",
    request_body = PlayerCreate,
    responses(
        (status = 200, body = Player),
        (status = 409, body = ErrorBody)
    )
)]
async fn create_player(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PlayerCreate>,
) -> impl IntoResponse {
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "name is required"})),
        )
            .into_response();
    }
    let mut players = state.players.write().await;
    if players.values().any(|p| names_equal(&p.name, &name)) {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({"error": "name already in use"})),
        )
            .into_response();
    }
    let (role, hunter) = resolve_role(&body.role, body.hunter);
    let player = Player {
        id: Uuid::new_v4().simple().to_string(),
        name,
        hunter,
        role,
        allegiance: body.allegiance,
        faction: body.faction,
        neo_id: body.neo_id,
    };
    players.insert(player.id.clone(), player.clone());
    (StatusCode::OK, Json(player)).into_response()
}

#[utoipa::path(
    put,
    path = "/api/players/{id}",
    params(("id" = String, Path, description = "Player ID")),
    request_body = PlayerUpdate,
    responses(
        (status = 200, body = Player),
        (status = 404, body = ErrorBody)
    )
)]
async fn update_player(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(body): Json<PlayerUpdate>,
) -> impl IntoResponse {
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "name is required"})),
        )
            .into_response();
    }
    let mut players = state.players.write().await;
    if !players.contains_key(&id) {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "player not found"})),
        )
            .into_response();
    }
    let (role, hunter) = resolve_role(&body.role, 0);
    let updated = Player {
        id: id.clone(),
        name,
        hunter,
        role,
        allegiance: body.allegiance,
        faction: body.faction,
        neo_id: body.neo_id,
    };
    players.insert(id, updated.clone());
    (StatusCode::OK, Json(updated)).into_response()
}

#[tokio::main]
async fn main() {
    let bind = std::env::var("PLAYER_API_BIND").unwrap_or_else(|_| "0.0.0.0:8090".to_string());
    let state = Arc::new(AppState {
        players: RwLock::new(seed_players()),
    });

    let app = Router::new()
        .route("/health", get(health))
        .route("/api/players", get(list_players).post(create_player))
        .route("/api/players/check", get(check_name))
        .route("/api/players/{id}", put(update_player))
        .merge(SwaggerUi::new("/docs").url("/openapi.json", ApiDoc::openapi()))
        .layer(CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .expect("bind failed");
    eprintln!("player_api_stub listening on http://{bind}");
    eprintln!("  GET  /health");
    eprintln!("  GET  /api/players?rows=&page=");
    eprintln!("  GET  /api/players/check?name=");
    eprintln!("  POST /api/players");
    eprintln!("  PUT  /api/players/:id");
    eprintln!("  GET  /openapi.json  (Swagger at /docs)");
    axum::serve(listener, app).await.expect("server failed");
}
