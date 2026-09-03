#!/usr/bin/env bash
##############################################################################
# install-server.sh — ProjectBounty FastAPI server for Ubuntu 24.04
#
# Installs: python3 venv, uvicorn, avahi (mDNS), systemd service
# Creates:  /opt/projectbounty/
#
# Usage (as root, after scp of the server tree):
#   bash /opt/projectbounty-deploy/setup/install-server.sh
##############################################################################
set -euo pipefail

INSTALL_DIR="/opt/projectbounty"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "============================================"
echo "  ProjectBounty Server Install"
echo "============================================"
echo ""
echo "  Deploy root: $DEPLOY_ROOT"
echo ""

# Public URL used in poster links returned by the API
HOSTNAME_FQDN="$(hostname -f 2>/dev/null || hostname)"
DEFAULT_PUBLIC="http://${HOSTNAME_FQDN}:8100"
read -rp "Public base URL for poster links [${DEFAULT_PUBLIC}]: " PUBLIC_BASE
PUBLIC_BASE="${PUBLIC_BASE:-$DEFAULT_PUBLIC}"
PUBLIC_BASE="${PUBLIC_BASE%/}"

read -rp "Registration / Central API base (blank = MAC stub only): " REG_BASE
REG_BASE="${REG_BASE%/}"

echo ""
echo "Configuration:"
echo "  Install dir:   $INSTALL_DIR"
echo "  Public base:   $PUBLIC_BASE"
echo "  Registration:  ${REG_BASE:-<stub>}"
echo ""
read -rp "Continue? [y/N]: " CONFIRM
[[ "${CONFIRM,,}" == "y" ]] || { echo "Aborted."; exit 0; }

# ── System packages ───────────────────────────────────────────────────────────
echo ""
echo "Updating apt and installing packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv curl ca-certificates \
    avahi-daemon openssh-server

systemctl enable --now ssh 2>/dev/null || true
systemctl enable --now avahi-daemon 2>/dev/null || true

# ── Service user ──────────────────────────────────────────────────────────────
if ! id bounty &>/dev/null; then
    useradd --system --no-create-home --shell /usr/sbin/nologin bounty
    echo "Created system user: bounty"
fi

# ── Directories ───────────────────────────────────────────────────────────────
echo "Creating $INSTALL_DIR ..."
mkdir -p "$INSTALL_DIR"/{media/videos,media/assets/neocorp,media/assets/animations,media/assets/marks,data,server,venv,setup}
chown -R bounty:bounty "$INSTALL_DIR"

# ── Python venv ───────────────────────────────────────────────────────────────
echo "Setting up Python venv..."
python3 -m venv "$INSTALL_DIR/venv"
"$INSTALL_DIR/venv/bin/pip" install --upgrade pip -q
"$INSTALL_DIR/venv/bin/pip" install -r "$DEPLOY_ROOT/requirements.txt" -q

# ── App files ─────────────────────────────────────────────────────────────────
echo "Copying application..."
rm -rf "$INSTALL_DIR/server/app"
cp -a "$DEPLOY_ROOT/app" "$INSTALL_DIR/server/"
cp -f "$DEPLOY_ROOT/requirements.txt" "$INSTALL_DIR/server/"
chown -R bounty:bounty "$INSTALL_DIR/server" "$INSTALL_DIR/media" "$INSTALL_DIR/data"

# ── Environment file ──────────────────────────────────────────────────────────
cat > "$INSTALL_DIR/bounty.env" <<EOF
BOUNTY_HOST=0.0.0.0
BOUNTY_PORT=8100
BOUNTY_PUBLIC_BASE=${PUBLIC_BASE}
BOUNTY_MEDIA=${INSTALL_DIR}/media
BOUNTY_DATA=${INSTALL_DIR}/data
BOUNTY_POSTERS=${INSTALL_DIR}/data/posters.json
BOUNTY_REGISTRATION_BASE=${REG_BASE}
BOUNTY_MAX_UPLOAD_MB=100
EOF
chown bounty:bounty "$INSTALL_DIR/bounty.env"
chmod 640 "$INSTALL_DIR/bounty.env"

# ── systemd unit ──────────────────────────────────────────────────────────────
echo "Installing systemd service..."
cp -f "$SCRIPT_DIR/bounty-server.service" /etc/systemd/system/bounty-server.service
systemctl daemon-reload
systemctl enable bounty-server.service
systemctl restart bounty-server.service

# ── Firewall (if ufw is active) ───────────────────────────────────────────────
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow 8100/tcp comment "ProjectBounty" || true
fi

sleep 1
echo ""
echo "============================================"
echo "  Install complete"
echo "============================================"
systemctl --no-pager --full status bounty-server.service || true
echo ""
echo "Health check:"
curl -sS "http://127.0.0.1:8100/health" || echo "(service may still be starting — retry in a few seconds)"
echo ""
echo "From Mission Control / HA, set secrets.yaml:"
echo "  bounty_base: ${PUBLIC_BASE}"
echo ""
