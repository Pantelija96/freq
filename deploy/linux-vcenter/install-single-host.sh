#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Device Efficiency single-host installer

Usage:
  sudo ./deploy/linux-vcenter/install-single-host.sh \
    --public-host freq.local \
    --db-admin-password '...' \
    --db-app-password '...' \
    --dashboard-secret '...' \
    --provision-secret '...'

Required:
  --public-host            Hostname or IP used by operators and devices
  --db-admin-password      Password for the maintenance MySQL user
  --db-app-password        Password for the backend MySQL app user
  --dashboard-secret       JWT / dashboard auth secret
  --provision-secret       Device provision secret

Optional:
  --db-bootstrap-user      MySQL bootstrap/admin user used for initial CREATE DATABASE/USER
  --db-bootstrap-password  Password for the bootstrap MySQL user
  --use-sudo-mysql         Use sudo mysql socket authentication for bootstrap SQL
  --frontend-repo-url      Frontend repository URL
  --backend-dir            Backend install directory
  --frontend-dir           Frontend install directory
  --cert-dir               Certificate directory
  --db-name                MySQL database name
  --db-admin-user          Maintenance DB username
  --db-app-user            Backend DB username
  --db-admin-host          Maintenance DB host pattern
  --backend-port           Backend HTTPS/WSS port
  --frontend-dev-port      Frontend Vite dev port
  --system-user            Linux service user
  --install-packages       Install nginx, mysql-server, git, curl, ca-certificates
  --skip-db-reset          Skip npm run db:reset
  --skip-start             Do not enable/start system services

Notes:
  - Run this script from inside the backend repository.
  - TLS certificate files must already exist in the certificate directory.
  - The frontend repository will be cloned automatically if missing.
EOF
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "This script must be run as root." >&2
    exit 1
  fi
}

require_command() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "Required command not found: ${cmd}" >&2
    exit 1
  fi
}

escape_squote() {
  printf "%s" "$1" | sed "s/'/'\\\\''/g"
}

SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_SOURCE_DIR="$(cd "${SCRIPT_PATH}/../.." && pwd)"

PUBLIC_HOST=""
FRONTEND_REPO_URL="https://github.com/Pantelija96/freq_front.git"
BACKEND_DIR="${BACKEND_SOURCE_DIR}"
FRONTEND_DIR="/opt/freq/frontend"
CERT_DIR="/opt/freq/cert"
DB_NAME="freq"
DB_ADMIN_USER="freq_admin"
DB_APP_USER="freq_app"
DB_ADMIN_HOST="127.0.0.1"
BACKEND_PORT="3000"
FRONTEND_DEV_PORT="5173"
SYSTEM_USER="freq"
INSTALL_PACKAGES="false"
SKIP_DB_RESET="false"
SKIP_START="false"
USE_SUDO_MYSQL="false"

DB_ADMIN_PASSWORD=""
DB_APP_PASSWORD=""
DASHBOARD_SECRET=""
PROVISION_SECRET=""
DB_BOOTSTRAP_USER="root"
DB_BOOTSTRAP_PASSWORD=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --public-host) PUBLIC_HOST="$2"; shift 2 ;;
    --frontend-repo-url) FRONTEND_REPO_URL="$2"; shift 2 ;;
    --backend-dir) BACKEND_DIR="$2"; shift 2 ;;
    --frontend-dir) FRONTEND_DIR="$2"; shift 2 ;;
    --cert-dir) CERT_DIR="$2"; shift 2 ;;
    --db-name) DB_NAME="$2"; shift 2 ;;
    --db-admin-user) DB_ADMIN_USER="$2"; shift 2 ;;
    --db-app-user) DB_APP_USER="$2"; shift 2 ;;
    --db-admin-host) DB_ADMIN_HOST="$2"; shift 2 ;;
    --db-admin-password) DB_ADMIN_PASSWORD="$2"; shift 2 ;;
    --db-app-password) DB_APP_PASSWORD="$2"; shift 2 ;;
    --dashboard-secret) DASHBOARD_SECRET="$2"; shift 2 ;;
    --provision-secret) PROVISION_SECRET="$2"; shift 2 ;;
    --db-bootstrap-user) DB_BOOTSTRAP_USER="$2"; shift 2 ;;
    --db-bootstrap-password) DB_BOOTSTRAP_PASSWORD="$2"; shift 2 ;;
    --use-sudo-mysql) USE_SUDO_MYSQL="true"; shift ;;
    --backend-port) BACKEND_PORT="$2"; shift 2 ;;
    --frontend-dev-port) FRONTEND_DEV_PORT="$2"; shift 2 ;;
    --system-user) SYSTEM_USER="$2"; shift 2 ;;
    --install-packages) INSTALL_PACKAGES="true"; shift ;;
    --skip-db-reset) SKIP_DB_RESET="true"; shift ;;
    --skip-start) SKIP_START="true"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "${PUBLIC_HOST}" || -z "${DB_ADMIN_PASSWORD}" || -z "${DB_APP_PASSWORD}" || -z "${DASHBOARD_SECRET}" || -z "${PROVISION_SECRET}" ]]; then
  echo "Missing required arguments." >&2
  usage
  exit 1
fi

require_root

if [[ "${INSTALL_PACKAGES}" == "true" ]]; then
  apt update
  apt install -y nginx mysql-server git curl ca-certificates
fi

require_command git
require_command mysql
require_command systemctl
require_command nginx
require_command npm
require_command node

if ! id -u "${SYSTEM_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "${SYSTEM_USER}"
fi

mkdir -p "${BACKEND_DIR}" "${FRONTEND_DIR}" "${CERT_DIR}" /var/log/freq
chown -R "${SYSTEM_USER}:${SYSTEM_USER}" "$(dirname "${BACKEND_DIR}")" /var/log/freq

if [[ "${BACKEND_SOURCE_DIR}" != "${BACKEND_DIR}" ]]; then
  mkdir -p "${BACKEND_DIR}"
  cp -a "${BACKEND_SOURCE_DIR}/." "${BACKEND_DIR}/"
fi

if [[ ! -d "${FRONTEND_DIR}/.git" ]]; then
  rm -rf "${FRONTEND_DIR}"
  git clone "${FRONTEND_REPO_URL}" "${FRONTEND_DIR}"
fi

if [[ ! -f "${CERT_DIR}/server.crt" || ! -f "${CERT_DIR}/server.key" ]]; then
  echo "Certificate files are missing in ${CERT_DIR}." >&2
  echo "Expected files:" >&2
  echo "  ${CERT_DIR}/server.crt" >&2
  echo "  ${CERT_DIR}/server.key" >&2
  exit 1
fi

systemctl enable mysql
systemctl start mysql

MYSQL_ADMIN_PASSWORD_ESCAPED="$(escape_squote "${DB_ADMIN_PASSWORD}")"
MYSQL_APP_PASSWORD_ESCAPED="$(escape_squote "${DB_APP_PASSWORD}")"
MYSQL_BOOTSTRAP_PASSWORD_ESCAPED="$(escape_squote "${DB_BOOTSTRAP_PASSWORD}")"

MYSQL_SQL=$(cat <<SQL
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS '${DB_ADMIN_USER}'@'${DB_ADMIN_HOST}' IDENTIFIED BY '${MYSQL_ADMIN_PASSWORD_ESCAPED}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_ADMIN_USER}'@'${DB_ADMIN_HOST}';

CREATE USER IF NOT EXISTS '${DB_ADMIN_USER}'@'127.0.0.1' IDENTIFIED BY '${MYSQL_ADMIN_PASSWORD_ESCAPED}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_ADMIN_USER}'@'127.0.0.1';

CREATE USER IF NOT EXISTS '${DB_APP_USER}'@'127.0.0.1' IDENTIFIED BY '${MYSQL_APP_PASSWORD_ESCAPED}';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, INDEX, ALTER
ON \`${DB_NAME}\`.* TO '${DB_APP_USER}'@'127.0.0.1';

FLUSH PRIVILEGES;
SQL
)

if [[ "${USE_SUDO_MYSQL}" == "true" ]]; then
  sudo mysql <<< "${MYSQL_SQL}"
else
  if [[ -n "${DB_BOOTSTRAP_PASSWORD}" ]]; then
    mysql -u "${DB_BOOTSTRAP_USER}" -p"${DB_BOOTSTRAP_PASSWORD}" <<< "${MYSQL_SQL}"
  else
    mysql -u "${DB_BOOTSTRAP_USER}" <<< "${MYSQL_SQL}"
  fi
fi

cat > "${BACKEND_DIR}/.env" <<EOF
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=${DB_APP_USER}
DB_PASSWORD=${DB_APP_PASSWORD}
DB_NAME=${DB_NAME}
DB_ADMIN_HOST=127.0.0.1
DB_ADMIN_PORT=3306
DB_ADMIN_USER=${DB_ADMIN_USER}
DB_ADMIN_PASSWORD=${DB_ADMIN_PASSWORD}
DB_BOOTSTRAP_USER=${DB_BOOTSTRAP_USER}
DB_BOOTSTRAP_PASSWORD=${DB_BOOTSTRAP_PASSWORD}

PORT=${BACKEND_PORT}
NODE_ENV=production
PUBLIC_URL=https://${PUBLIC_HOST}

CERT_KEY=${CERT_DIR}/server.key
CERT_CERT=${CERT_DIR}/server.crt

WSS_URL=wss://${PUBLIC_HOST}/dashboard

DASHBOARD_SECRET=${DASHBOARD_SECRET}
PROVISION_SECRET=${PROVISION_SECRET}

AUTH_MODE=local
AUTH_JWT_EXPIRES_IN=12h

DEV_TOOLS_ENABLED=false
EOF

cat > "${FRONTEND_DIR}/.env" <<EOF
VITE_DEV_PORT=${FRONTEND_DEV_PORT}
VITE_API_BASE_URL=https://${PUBLIC_HOST}/api
VITE_WS_BASE_URL=wss://${PUBLIC_HOST}/dashboard
EOF

chown "${SYSTEM_USER}:${SYSTEM_USER}" "${BACKEND_DIR}/.env" "${FRONTEND_DIR}/.env"

pushd "${BACKEND_DIR}" >/dev/null
npm install --omit=dev
if [[ "${SKIP_DB_RESET}" != "true" ]]; then
  npm run db:reset
fi
popd >/dev/null

pushd "${FRONTEND_DIR}" >/dev/null
npm install
npm run build
popd >/dev/null

NODE_BIN="$(command -v node)"

cat > /etc/systemd/system/freq-backend.service <<EOF
[Unit]
Description=Freq Backend Service
After=network.target mysql.service

[Service]
Type=simple
User=${SYSTEM_USER}
Group=${SYSTEM_USER}
WorkingDirectory=${BACKEND_DIR}
EnvironmentFile=${BACKEND_DIR}/.env
ExecStart=${NODE_BIN} ${BACKEND_DIR}/src/server.js
Restart=always
RestartSec=5
StandardOutput=append:/var/log/freq/backend.log
StandardError=append:/var/log/freq/backend.error.log

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/nginx/sites-available/freq <<EOF
server {
    listen 80;
    server_name ${PUBLIC_HOST};
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ${PUBLIC_HOST};

    ssl_certificate ${CERT_DIR}/server.crt;
    ssl_certificate_key ${CERT_DIR}/server.key;

    root ${FRONTEND_DIR}/dist;
    index index.html;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location /api/ {
        proxy_pass https://127.0.0.1:${BACKEND_PORT}/api/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    location /health {
        proxy_pass https://127.0.0.1:${BACKEND_PORT}/health;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    location /downloads/ {
        proxy_pass https://127.0.0.1:${BACKEND_PORT}/downloads/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    location /dashboard {
        proxy_pass https://127.0.0.1:${BACKEND_PORT}/dashboard;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
EOF

ln -sf /etc/nginx/sites-available/freq /etc/nginx/sites-enabled/freq
nginx -t

systemctl daemon-reload

if [[ "${SKIP_START}" != "true" ]]; then
  systemctl enable freq-backend
  systemctl restart freq-backend
  systemctl reload nginx
fi

cat <<EOF

Installation completed.

Backend directory:  ${BACKEND_DIR}
Frontend directory: ${FRONTEND_DIR}
Public host:        ${PUBLIC_HOST}
Backend port:       ${BACKEND_PORT}

Default dashboard users after db:reset:
  admin / admin
  user / user

Remember to:
  - change dashboard passwords after first login
  - keep DB admin credentials private
  - ensure ${PUBLIC_HOST} resolves correctly on the local network
EOF
