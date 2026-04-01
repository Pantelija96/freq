# Device Efficiency Linux Installation Guide

This guide describes how to install the full Device Efficiency stack on a single Linux machine.

The setup covered here runs:

- the Vue frontend
- the Node.js backend
- the MySQL database
- nginx as the local entry point

on the same host.

This is a valid deployment model for the project and fits the intended operating environment well:

- local ship network
- no internet dependency during normal operation
- Android devices connecting over LAN or vessel Wi-Fi
- operators using the web interface from the same local network

## 1. Can everything run on one machine?

Yes.

The project is suitable for a single-machine deployment because:

- the frontend is a static build served by nginx
- the backend is a single Node.js service
- the database is a standard MySQL instance
- machine power is not a constraint in your case
- the application is designed to work fully inside a private local network

### Recommended single-machine layout

- Hostname: `freq.local` or another local DNS name used on the ship
- Frontend: `/opt/freq/frontend/dist`
- Backend: `/opt/freq/backend`
- Certificates: `/opt/freq/cert`
- Logs: `/var/log/freq`
- Database: local MySQL service on `127.0.0.1:3306`

### Recommended services on the host

- `nginx`
- `mysql`
- `freq-backend` systemd service

## 2. Offline-first deployment principles

This project should be treated as a fully local system.

## 3. Prepare the Linux host

Update the machine:

```bash
sudo apt update
sudo apt upgrade -y
```

Install the base packages:

```bash
sudo apt install -y nginx mysql-server curl ca-certificates
```

Install Node.js LTS.

If Node.js is not already available from your local package mirror, install it from a trusted source before boarding or place the package locally in your maintenance bundle.

Confirm versions:

```bash
node -v
npm -v
mysql --version
nginx -v
```

## 4. Create the application user and folders

Create a dedicated service user:

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin freq
```

Create required directories:

```bash
sudo mkdir -p /opt/freq/backend
sudo mkdir -p /opt/freq/frontend
sudo mkdir -p /opt/freq/cert
sudo mkdir -p /var/log/freq
```

Set ownership:

```bash
sudo chown -R freq:freq /opt/freq
sudo chown -R freq:freq /var/log/freq
```

## 5. Copy the project to the server

Copy these two projects to the Linux machine:

- backend repo -> `/opt/freq/backend`
- frontend repo -> `/opt/freq/frontend`

Expected result:

```text
/opt/freq/backend
/opt/freq/frontend
```

## 6. Configure the local database

Start and enable MySQL:

```bash
sudo systemctl enable mysql
sudo systemctl start mysql
```

Open MySQL:

```bash
sudo mysql
```

Create the application database and the user model.

This guide recommends two database users:

1. a private maintenance user known only to your team
2. a restricted application user used by the backend

The maintenance user is for:

- installation
- maintenance
- direct DBA work
- access over VPN or controlled administration channels

The application user is for:

- backend access only
- local host only
- limited privileges on the application database

Example SQL:

```sql
CREATE DATABASE freq CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER 'freq_admin'@'10.%' IDENTIFIED BY 'change-me-admin-password';
GRANT ALL PRIVILEGES ON freq.* TO 'freq_admin'@'10.%';

CREATE USER 'freq_admin'@'127.0.0.1' IDENTIFIED BY 'change-me-admin-password';
GRANT ALL PRIVILEGES ON freq.* TO 'freq_admin'@'127.0.0.1';

CREATE USER 'freq_app'@'127.0.0.1' IDENTIFIED BY 'change-me-app-password';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, INDEX, ALTER
ON freq.* TO 'freq_app'@'127.0.0.1';

FLUSH PRIVILEGES;
EXIT;
```

Important:

- the backend should use `freq_app`
- the backend should not use the private maintenance user
- MySQL should not be opened broadly to the ship network
- direct DB access should remain restricted to your administration path

## 7. Configure backend environment

Inside `/opt/freq/backend`, create the `.env` file.

Use the backend `.env.example` as the base and set it for local ship deployment.

Example:

```env
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=freq_app
DB_PASSWORD=change-me-app-password
DB_NAME=freq

PORT=3000
NODE_ENV=production
PUBLIC_URL=https://freq.local

CERT_KEY=/opt/freq/cert/server.key
CERT_CERT=/opt/freq/cert/server.crt

WSS_URL=wss://freq.local/dashboard

DASHBOARD_SECRET=replace-with-a-long-random-secret
PROVISION_SECRET=replace-with-a-long-random-secret

AUTH_MODE=local
AUTH_JWT_EXPIRES_IN=12h

DEV_TOOLS_ENABLED=false
```

Important notes:

- `DB_HOST` must stay `127.0.0.1` for a same-machine installation
- `PORT` is configurable, but keeping `3000` is recommended unless the local infrastructure requires a different backend port
- `WSS_URL` must match the exact hostname devices will use
- `PUBLIC_URL` should match the operator-facing URL
- `DEV_TOOLS_ENABLED` should be `false` in production

## 8. Install backend dependencies

```bash
cd /opt/freq/backend
npm install --omit=dev
```


## 9. Initialize or rebuild the database

The project already has a reset script that:

- drops and recreates the database
- applies the schema
- creates two initial users

Run:

```bash
cd /opt/freq/backend
npm run db:reset
```

The initial dashboard users are:

- `admin / admin`
- `user / user`

Change those passwords immediately after first installation.

## 11. Install and build the frontend

Create the frontend environment file in `/opt/freq/frontend/.env`:

```env
VITE_DEV_PORT=5173
VITE_API_BASE_URL=https://freq.local/api
VITE_WS_BASE_URL=wss://freq.local/dashboard
```

`VITE_DEV_PORT` is only for local frontend development. In production, the built frontend is served by nginx and does not need its own public application port.

Install and build:

```bash
cd /opt/freq/frontend
npm install
npm run build
```

The production build will be created in:

```text
/opt/freq/frontend/dist
```

This built frontend is what nginx will serve. Do not use the Vite dev server in production.

## 11. Install local certificates

For a ship or other isolated environment, the normal approach is to use an internal certificate.

Place certificate files here:

```text
/opt/freq/cert/server.crt
/opt/freq/cert/server.key
```

The certificate should match the hostname used by operators and devices, for example:

- `freq.local`
- or the exact local IP, if you choose IP-based access

If your operators and Android devices need trusted HTTPS and WSS, the certificate authority used to sign this certificate must be trusted on those devices.

## 12. Install the backend systemd service

Copy the provided service file:

```bash
sudo cp /opt/freq/backend/deploy/linux-vcenter/freq-backend.service /etc/systemd/system/freq-backend.service
```

Reload systemd and enable the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable freq-backend
sudo systemctl start freq-backend
```

Check service status:

```bash
sudo systemctl status freq-backend
```

Check logs:

```bash
sudo tail -f /var/log/freq/backend.log
sudo tail -f /var/log/freq/backend.error.log
```

## 13. Install nginx as the local entry point

Copy the nginx configuration:

```bash
sudo cp /opt/freq/backend/deploy/linux-vcenter/nginx-freq.conf /etc/nginx/sites-available/freq
```

Enable the site:

```bash
sudo ln -s /etc/nginx/sites-available/freq /etc/nginx/sites-enabled/freq
```

Test and reload nginx:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

This nginx configuration serves:

- the built frontend from `/opt/freq/frontend/dist`
- backend API under `/api`
- WebSocket endpoint under `/dashboard`
- document and APK downloads under `/downloads`

## 14. DNS or local IP planning

Choose one access model and stay consistent across backend, frontend, and Android clients.

### Preferred option: local DNS

Use a local name such as:

```text
freq.local
```

Then use:

- frontend: `https://freq.local`
- backend API: `https://freq.local/api`
- websocket: `wss://freq.local/dashboard`

### Alternative option: fixed local IP

Use a single static host IP and configure:

- `PUBLIC_URL`
- `WSS_URL`
- frontend `.env`
- Android app target

to that exact IP.

Do not mix hostnames and IPs randomly. Certificate trust and WebSocket connectivity will be more predictable if everything uses one canonical address.

## 15. Verify the full stack

After installation, verify each layer in order.

### Backend

Open:

```text
https://freq.local/health
```

Expected result:

- JSON health response

### Frontend

Open:

```text
https://freq.local
```

Expected result:

- login screen loads

### Authentication

Sign in using:

- `admin / admin`

Expected result:

- dashboard opens

### Downloads

Test:

- Documentation menu item
- Download APK menu item

Expected result:

- PDF opens in a new tab
- APK downloads

### Device connectivity

Verify Android devices can:

- provision
- login
- open websocket tunnel
- appear online in the dashboard