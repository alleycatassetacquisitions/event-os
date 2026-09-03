"""Constants for Registration player HTTP client."""

DOMAIN = "registration"

CONF_BASE_URL = "base_url"
CONF_FALLBACK_URL = "fallback_url"
CONF_API_TOKEN = "api_token"
CONF_MODE = "mode"

DEFAULT_BASE_URL = "https://alleycat-dl83g.ondigitalocean.app"
DEFAULT_FALLBACK_URL = "http://192.168.1.234:8090"

MODE_ONLINE = "online"
MODE_LOCAL = "local"

SERVICE_LIST_PLAYERS = "list_players"
SERVICE_CHECK_NAME = "check_name"
SERVICE_REGISTER_PLAYER = "register_player"
SERVICE_REFRESH_PLAYERS = "refresh_players"

STORAGE_KEY = f"{DOMAIN}_cache"
