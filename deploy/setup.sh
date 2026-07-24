#!/usr/bin/env bash
# cult of pons — Ubuntu 24.04 one-shot server setup.
# Installs Node.js 22 + PM2 + nginx + certbot + a local MongoDB, clones the repo
# to /var/www/cultofpons, and starts the API under PM2 (DRY_RUN by default).
#
# No domain required: nginx serves on the server's IP (port 80). When you have a
# domain, point its A record here, edit server_name, and run certbot (printed at
# the end).
#
# Run as root (or with sudo):
#   curl -fsSL https://raw.githubusercontent.com/blockfile/cultofpons/main/deploy/setup.sh | sudo bash
# or, after a manual clone:
#   sudo bash deploy/setup.sh
set -euo pipefail

APP_DIR="/var/www/cultofpons"
REPO="https://github.com/blockfile/cultofpons.git"
SITE="cultofpons"

echo "── system packages ──────────────────────────────────────────────────────"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git gnupg nginx certbot python3-certbot-nginx ufw

echo "── Node.js 22 (NodeSource) + PM2 ────────────────────────────────────────"
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v && npm -v
npm install -g pm2

echo "── MongoDB 8.0 (local, binds to 127.0.0.1 only) ─────────────────────────"
if ! command -v mongod >/dev/null; then
  curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc \
    | gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor
  echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" \
    > /etc/apt/sources.list.d/mongodb-org-8.0.list
  apt-get update -y
  apt-get install -y mongodb-org
fi
systemctl enable --now mongod

echo "── app: clone + install ─────────────────────────────────────────────────"
mkdir -p /var/www
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
npm ci --omit=dev

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo ""
  echo "*** Created $APP_DIR/.env from the example (DRY_RUN=true — safe). ***"
  echo "*** MONGODB_URI defaults to the local mongod, so the DB works as-is. ***"
  echo "*** Before going live, edit: WALLET_PRIVATE_KEY, TOKEN_ADDRESS,       ***"
  echo "*** REWARD_TOKEN, API_KEY, CORS_ORIGINS — then set DRY_RUN=false.      ***"
fi
chmod 600 .env

echo "── PM2 (single fork instance) ───────────────────────────────────────────"
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | bash || true

echo "── nginx (default_server on this box's IP; no domain needed yet) ────────"
cp deploy/nginx.conf "/etc/nginx/sites-available/$SITE"
ln -sf "/etc/nginx/sites-available/$SITE" "/etc/nginx/sites-enabled/$SITE"
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "── firewall (allow SSH + HTTP/HTTPS; the app's 3000 stays private) ──────"
ufw allow OpenSSH || true
ufw allow 'Nginx Full' || true
yes | ufw enable || true

IP="$(curl -fsS4 ifconfig.me 2>/dev/null || echo YOUR_SERVER_IP)"
echo ""
echo "── done ─────────────────────────────────────────────────────────────────"
echo "API    : http://$IP            (nginx → 127.0.0.1:3000)"
echo "Health : curl http://$IP/"
echo "Logs   : pm2 logs cultofpons-api"
echo "Config : edit $APP_DIR/.env then: pm2 restart cultofpons-api"
echo ""
echo "When you have a DOMAIN:"
echo "  1) point its A record at $IP"
echo "  2) edit /etc/nginx/sites-available/$SITE → server_name your.domain;"
echo "  3) sudo nginx -t && sudo systemctl reload nginx"
echo "  4) sudo certbot --nginx -d your.domain --redirect"
