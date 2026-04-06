# Device Efficiency Single-Host Installer Guide

This guide explains how to install the full Device Efficiency platform on a single Linux machine by using the provided startup script.

It is intended for:

- customer installation teams
- internal developers
- operators preparing a test or proof-of-concept server

The installation script lives in the backend repository:

- [install-single-host.sh](C:/Users/PC/Desktop/freq/deploy/linux-vcenter/install-single-host.sh)

## 1. What this installer does

The installer prepares a full one-machine deployment of:

- the backend
- the frontend
- MySQL
- nginx
- the backend systemd service

on the same Linux host.

During a successful run, it can:

- install required Linux packages
- create the Linux service user
- create standard application directories
- clone the frontend repository if it is not already present
- create the MySQL database
- create the MySQL maintenance user
- create the MySQL backend app user
- write backend `.env`
- write frontend `.env`
- install backend dependencies
- reset the database schema
- create the default dashboard users
- install frontend dependencies
- build the frontend
- create the `freq-backend.service` systemd unit
- create the nginx site configuration
- enable and start the backend service
- reload nginx

## 2. What the installer does not do

The installer does **not** generate TLS certificates.

The installation team must provide:

- `/opt/freq/cert/server.crt`
- `/opt/freq/cert/server.key`

before running the script.

The certificate must match the hostname or IP they plan to use, for example:

- `freq.com`
- `freq.local`
- or a fixed local IP

The installer also does not manage:

- DNS setup
- `/etc/hosts` setup on client machines
- VPN configuration
- firewall configuration
- certificate trust distribution

Those are part of the customer or IT department environment.

## 3. Repository layout

The solution uses two repositories:

- Backend: [https://github.com/Pantelija96/freq.git](https://github.com/Pantelija96/freq.git)
- Frontend: [https://github.com/Pantelija96/freq_front.git](https://github.com/Pantelija96/freq_front.git)

The installer script remains in the **backend** repository.

That means:

1. cloning the backend repo gives the team the installer
2. the installer can then clone the frontend repo automatically

## 4. Recommended Linux layout

Default directories created or used by the installer:

- Backend: `/opt/freq/backend`
- Frontend: `/opt/freq/frontend`
- Certificates: `/opt/freq/cert`
- Logs: `/var/log/freq`

Default service user:

- `freq`

## 5. Required input values

The script needs a few deployment-specific values.

### Required arguments

- `--public-host`
  - hostname or IP used by operators and Android devices
- `--db-admin-password`
  - password for the private MySQL maintenance user
- `--db-app-password`
  - password for the restricted backend MySQL user
- `--dashboard-secret`
  - JWT/dashboard authentication secret
- `--provision-secret`
  - secret used by the device provisioning flow

### Optional arguments

- `--db-bootstrap-user`
- `--db-bootstrap-password`
- `--use-sudo-mysql`
- `--frontend-repo-url`
- `--backend-dir`
- `--frontend-dir`
- `--cert-dir`
- `--db-name`
- `--db-admin-user`
- `--db-app-user`
- `--db-admin-host`
- `--backend-port`
- `--frontend-dev-port`
- `--system-user`
- `--install-packages`
- `--skip-db-reset`
- `--skip-start`

## 6. Default values used by the installer

Unless changed by arguments, the installer uses:

- frontend repo URL: `https://github.com/Pantelija96/freq_front.git`
- backend dir: current backend repo path
- frontend dir: `/opt/freq/frontend`
- cert dir: `/opt/freq/cert`
- db name: `freq`
- db admin user: `freq_admin`
- db app user: `freq_app`
- db admin host pattern: `127.0.0.1`
- db bootstrap user: `root`
- backend port: `3000`
- frontend dev port: `5173`
- system user: `freq`

## 7. MySQL user model used by the installer

The installer follows a two-user database model.

### Maintenance user

This user is for:

- installation
- maintenance
- controlled direct access
- possible VPN-only administration

Default name:

- `freq_admin`

### Application user

This user is for:

- backend access only
- local host only
- normal application runtime

Default name:

- `freq_app`

Important:

- the backend should use the app user
- the backend should not run as MySQL `root`
- the maintenance user should stay private

## 8. Standard installation flow

### Step 1. Clone the backend repository

```bash
sudo mkdir -p /opt/freq
sudo git clone https://github.com/Pantelija96/freq.git /opt/freq/backend
```

### Step 2. Prepare TLS certificate files

Place certificate files here:

```text
/opt/freq/cert/server.crt
/opt/freq/cert/server.key
```

### Step 3. Run the installer

Example:

```bash
cd /opt/freq/backend
sudo chmod +x deploy/linux-vcenter/install-single-host.sh

sudo deploy/linux-vcenter/install-single-host.sh \
  --install-packages \
  --use-sudo-mysql \
  --public-host freq.com \
  --backend-port 3000 \
  --frontend-dev-port 5173 \
  --db-admin-password 'CHANGE_ME_ADMIN_DB_PASS' \
  --db-app-password 'CHANGE_ME_APP_DB_PASS' \
  --dashboard-secret 'CHANGE_ME_DASHBOARD_SECRET' \
  --provision-secret 'CHANGE_ME_PROVISION_SECRET'
```

If the Linux machine uses MySQL socket authentication for administrative access, use:

```bash
--use-sudo-mysql
```

If the machine instead requires an explicit MySQL admin password, use:

```bash
--db-bootstrap-user root \
--db-bootstrap-password 'YOUR_MYSQL_ROOT_PASSWORD'
```

## 9. What the script writes

### Backend `.env`

The installer writes:

- `/opt/freq/backend/.env`

This includes:

- MySQL app credentials
- MySQL admin credentials
- backend port
- `PUBLIC_URL`
- `WSS_URL`
- certificate paths
- dashboard secret
- provision secret

### Frontend `.env`

The installer writes:

- `/opt/freq/frontend/.env`

This includes:

- `VITE_DEV_PORT`
- `VITE_API_BASE_URL`
- `VITE_WS_BASE_URL`

### systemd service

The installer creates:

- `/etc/systemd/system/freq-backend.service`

### nginx site

The installer creates:

- `/etc/nginx/sites-available/freq`
- `/etc/nginx/sites-enabled/freq`

## 10. Default dashboard users after install

If the database reset runs successfully, the installer creates:

- `admin / admin`
- `user / user`

These should be changed immediately after first login.

## 11. Useful script flags

### `--install-packages`

Installs:

- `nginx`
- `mysql-server`
- `git`
- `curl`
- `ca-certificates`

Use this on a clean Linux machine.

### `--skip-db-reset`

Skips:

- `npm run db:reset`

Use this when:

- the database was already initialized
- you are rerunning the installer after a partial failure
- you want to avoid wiping data

### `--skip-start`

Skips:

- enabling and starting the backend service
- reloading nginx

Use this when you want to inspect generated files first.

## 12. How to rerun after a partial failure

If the installer fails after the database is already created, do **not** always rerun the full reset.

Use:

```bash
sudo deploy/linux-vcenter/install-single-host.sh \
  --public-host freq.com \
  --backend-port 3000 \
  --frontend-dev-port 5173 \
  --db-admin-password 'CHANGE_ME_ADMIN_DB_PASS' \
  --db-app-password 'CHANGE_ME_APP_DB_PASS' \
  --dashboard-secret 'CHANGE_ME_DASHBOARD_SECRET' \
  --provision-secret 'CHANGE_ME_PROVISION_SECRET' \
  --skip-db-reset
```

This is useful if:

- database creation already succeeded
- frontend/backend build or nginx/service setup failed later

## 13. Verification after installation

### Check services

```bash
sudo systemctl status mysql --no-pager
sudo systemctl status nginx --no-pager
sudo systemctl status freq-backend --no-pager
```

### Check listening ports

```bash
sudo ss -tulpn | grep -E ':443|:3000'
```

Expected:

- nginx listening on `443`
- backend listening on `3000`

### Check nginx config

```bash
sudo nginx -t
```

### Check backend health

```bash
curl -k https://freq.com/health
```

Expected:

- JSON health response

### Open the application

Open:

- `https://freq.com`

Then log in with:

- `admin / admin`

## 14. Testing with a direct IP or a domain

The frontend now supports both:

- access by domain
- access by direct IP

If explicit frontend env vars are not set, it can fall back to the current browser host and use that for backend API and WSS traffic.

However, TLS certificates still matter.

The certificate must match whichever host is being used:

- domain
- or IP

For testing:

- if using `freq.com`, make sure it resolves to the server
- if using an IP directly, the certificate should match that IP or the browser will warn

## 15. Troubleshooting

### Problem: `Required command not found: mysql`

Cause:

- MySQL is not installed yet

Fix:

- rerun with `--install-packages`
- or install MySQL manually

### Problem: `ERROR 1045 (28000): Access denied for user 'root'@'localhost'`

Cause:

- MySQL root is not configured for passwordless CLI access
- the machine may be using socket authentication or password-based root auth

Fix:

- rerun the installer with:

```bash
--use-sudo-mysql
```

or, if the machine uses password-based MySQL root access:

```bash
--db-bootstrap-user root \
--db-bootstrap-password 'YOUR_MYSQL_ROOT_PASSWORD'
```

### Problem: `Required command not found: npm`

Cause:

- Node.js or npm is not installed

Fix:

- install Node.js and npm
- rerun the installer

### Problem: `fatal: detected dubious ownership`

Cause:

- repository was cloned with `sudo`
- Git safe directory is not configured for the current user or root

Fix:

```bash
git config --global --add safe.directory /opt/freq/backend
sudo git config --global --add safe.directory /opt/freq/backend
```

### Problem: `/health` is unreachable after install

Cause:

- the installer likely stopped before creating the service or nginx site

Check:

```bash
ls -l /etc/systemd/system/freq-backend.service
ls -l /etc/nginx/sites-enabled/
sudo systemctl status freq-backend --no-pager
sudo ss -tulpn | grep -E ':443|:3000'
```

### Problem: login page loads but login returns `Failed to fetch`

Cause:

- frontend host and backend host do not match
- certificate is not trusted
- DNS or `/etc/hosts` is missing

Fix:

- verify the server host resolves correctly
- open the health endpoint directly in browser and accept the certificate warning
- confirm API/WSS host values

### Problem: installer reached DB reset but later steps did not complete

Cause:

- the script may have failed after database creation

Fix:

- correct the underlying issue
- rerun with `--skip-db-reset`

## 16. Recommended handoff to customer or IT

When handing off the platform, provide:

- backend repository URL
- frontend repository URL
- this guide
- the main deployment guide
- the required input values they must decide
- a note that certificates must be created by their team

## 17. Related files

- [DEPLOYMENT.md](C:/Users/PC/Desktop/freq/deploy/linux-vcenter/DEPLOYMENT.md)
- [install-single-host.sh](C:/Users/PC/Desktop/freq/deploy/linux-vcenter/install-single-host.sh)
- [nginx-freq.conf](C:/Users/PC/Desktop/freq/deploy/linux-vcenter/nginx-freq.conf)
- [freq-backend.service](C:/Users/PC/Desktop/freq/deploy/linux-vcenter/freq-backend.service)
