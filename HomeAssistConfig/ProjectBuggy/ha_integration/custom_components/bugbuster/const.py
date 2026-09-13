"""Constants for Bug Buster (ProjectBuggy)."""

from datetime import timedelta

DOMAIN = "bugbuster"

CONF_TOKEN_ID = "token_id"
CONF_TOKEN_SECRET = "token_secret"
CONF_VERIFY_SSL = "verify_ssl"
CONF_MQTT_TOPIC = "mqtt_topic"

DEFAULT_MQTT_TOPIC = "#"
DEFAULT_VERIFY_SSL = False

POLL_INTERVAL = timedelta(seconds=5)
CONFIG_CACHE_TTL = timedelta(seconds=60)
MQTT_BUFFER_SIZE = 200
MQTT_PREVIEW_CHARS = 2000
MQTT_HEX_BYTES = 64
TERM_PING_INTERVAL = 30

SIGNAL_NEW_HOST = f"{DOMAIN}_new_host"
SIGNAL_UPDATE = f"{DOMAIN}_update"

EVENT_HOSTS_UPDATE = f"{DOMAIN}_hosts_update"
EVENT_MQTT_MESSAGE = f"{DOMAIN}_mqtt_message"
EVENT_HOST_UPDATE = f"{DOMAIN}_host_update"
