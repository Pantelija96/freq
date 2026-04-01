# Device Efficiency Backend

Node.js backend for the Device Efficiency platform.

This service provides:

- dashboard authentication and authorization
- HTTPS API endpoints for the frontend
- WSS communication for Android devices and the live dashboard
- command dispatch and command history
- device statistics, crash history, and frequency ingestion
- PDF report generation
- public document and APK downloads

The backend is designed to run locally with the frontend and MySQL on the same machine, which fits the intended offline-first deployment model for shipboard or other isolated environments.

## Stack

- Node.js
- Express
- `ws`
- MySQL
- `mysql2`
- JWT authentication
- PDFKit

## Main Functional Areas

- Device provisioning and device login
- Dashboard login and role-based access
- Live dashboard updates over WSS
- Command queueing and command lifecycle tracking
- Frequency batch ingestion with compressed segment storage
- Device stats and crash history storage
- Licence listing
- PDF reports for one or multiple devices
- Public document and APK download endpoints

## Roles

Dashboard users currently have two roles:

- `admin`
  - can view everything
  - can send commands to devices
- `user`
  - can view everything
  - cannot send commands

## Project Setup

Install dependencies:

```bash
npm install
```

Copy and configure the environment file:

```bash
cp .env.example .env
```

## Environment

Example backend environment:

```env
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=freq_app
DB_PASSWORD=change-me-app-password
DB_NAME=freq

DB_ADMIN_HOST=127.0.0.1
DB_ADMIN_PORT=3306
DB_ADMIN_USER=freq_admin
DB_ADMIN_PASSWORD=change-me-admin-password

PORT=3000
NODE_ENV=development
PUBLIC_URL=https://freq.local

CERT_KEY=./cert/server.key
CERT_CERT=./cert/server.cert

WSS_URL=wss://freq.local/dashboard

DASHBOARD_SECRET=change-me-dashboard-secret
PROVISION_SECRET=change-me-provision-secret

AUTH_MODE=local
AUTH_JWT_EXPIRES_IN=12h

DEV_TOOLS_ENABLED=true
```

Important notes:

- `PORT` is the backend HTTPS/WSS port and defaults to `3000`
- `DB_USER` should be the restricted backend application user
- `DB_ADMIN_USER` is intended for database reset and maintenance tasks
- the backend should not run against MySQL as `root`
- `WSS_URL` must match the hostname or IP that Android devices will actually use
- `CERT_KEY` and `CERT_CERT` must point to valid certificate files created for the target environment

## Certificates

The backend expects TLS certificate files to exist before startup.

Provide:

- `server.key`
- `server.crt` or `server.cert`

and point `CERT_KEY` / `CERT_CERT` to those files in `.env`.

The installation team should create the certificates that match their actual deployment hostname or IP.

## Database Setup

Make sure MySQL is installed and running.

Create the database:

```sql
CREATE DATABASE freq CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
```

The schema is stored in:

- [frequencies.sql](C:/Users/PC/Desktop/freq/frequencies.sql)

### Recommended DB user model

Use two separate MySQL users:

- private maintenance user
  - known only to your team
  - used for installation, maintenance, or controlled VPN-based access
- backend application user
  - used by the backend only
  - restricted to the application database

Example:

```sql
CREATE USER 'freq_admin'@'127.0.0.1' IDENTIFIED BY 'change-me-admin-password';
GRANT ALL PRIVILEGES ON freq.* TO 'freq_admin'@'127.0.0.1';

CREATE USER 'freq_app'@'127.0.0.1' IDENTIFIED BY 'change-me-app-password';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, INDEX, ALTER
ON freq.* TO 'freq_app'@'127.0.0.1';

FLUSH PRIVILEGES;
```

### Reset the database

To fully rebuild the database from `.env` and recreate the default dashboard users:

```bash
npm run db:reset
```

This will:

- drop the database from `DB_NAME` if it exists
- recreate it
- apply `frequencies.sql`
- insert two dashboard users:
  - `admin / admin`
  - `user / user`

### Create or refresh DB users from `.env`

To create the MySQL maintenance user and restricted backend app user from the current `.env` values:

```bash
npm run db:users
```

This command uses:

- `DB_ADMIN_USER`
- `DB_ADMIN_PASSWORD`
- `DB_USER`
- `DB_PASSWORD`

and creates those users for local MySQL access.

## Running the Server

Development:

```bash
npm run dev
```

Production:

```bash
npm start
```

Default local URL:

```text
https://127.0.0.1:3000
```

## Authentication

### Dashboard login

Login endpoint:

```http
POST /api/auth/login
```

Example body:

```json
{
  "username": "admin",
  "password": "admin"
}
```

On success the backend returns a JWT signed with `DASHBOARD_SECRET`.

Related endpoints:

- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/logout`

### Local users

The current auth mode is:

- `AUTH_MODE=local`

The code is structured so LDAP or AD integration can be added later without replacing the current route structure.

Passwords should be stored as:

```text
scrypt$<salt>$<hash>
```

Useful scripts:

```bash
node scripts/hashPassword.js your-password
node scripts/createDashboardUser.js admin your-password admin System Administrator
node scripts/createDashboardUser.js user your-password user Regular User
```

## API Overview

All protected application routes are mounted under:

- `/api`

### Device endpoints

- `POST /api/devices/provision`
- `POST /api/devices/login`

Provisioning is currently open by design for the device registration workflow.

### Auth endpoints

- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/logout`

### Dashboard endpoints

- `GET /api/dashboard/overview`
- `GET /api/dashboard/devices`
- `GET /api/dashboard/device/:id`
- `GET /api/dashboard/device/:id/commands`
- `POST /api/dashboard/command`
- `GET /api/dashboard/device/:deviceId/cpu-frequencies`
- `GET /api/dashboard/device/:deviceId/stats`
- `GET /api/dashboard/licences`
- `GET /api/dashboard/report/devices`
- `POST /api/dashboard/report/devices`

### Public download endpoints

- `GET /downloads/apk/latest`
- `GET /downloads/docs/latest-pdf`

## Authorization Rules

- `/api/dashboard/*` requires dashboard authentication
- `/api/command/*` requires dashboard authentication
- `POST /api/dashboard/command` additionally requires `admin` role
- dashboard frontend access is JWT-based
- dashboard live updates are delivered over WSS

## WebSocket Endpoints

### Device socket

Devices connect to the backend WSS endpoint provided after login.

The backend expects the device to authenticate and then send:

- command acknowledgements and results
- stats payloads
- crash data
- frequency batches

### Dashboard socket

The frontend connects to:

- `/dashboard`

and receives live events such as:

- device online
- device offline
- device logout
- command update
- command result
- stats update
- live frequency updates

## Reports

The backend can generate multi-device or single-device PDF reports.

Reports currently include:

- device summary
- frequency session data
- crash history
- command history
- report creation timestamp
- report creator
- command actor information

If multiple devices are selected, each device gets its own page in the PDF.

## Developer Tools

When:

```env
DEV_TOOLS_ENABLED=true
```

the backend exposes unguarded local helper tools under:

- `/api/dev`
- `/dev/`

Examples:

- `GET /api/dev/devices`
- `GET /api/dev/active-devices`
- `POST /api/dev/devices/:deviceId/commands`
- `GET /api/dev/devices/:deviceId/commands?limit=20`
- `GET /api/dev/logs`
- `GET /api/dev/logs/:filename?lines=200`
- `GET /api/dev/seed/demo`

These are intended for local development and testing only.

## Deployment

For Linux installation on a single machine, use:

- [DEPLOYMENT.md](C:/Users/PC/Desktop/freq/deploy/linux-vcenter/DEPLOYMENT.md)

That guide covers:

- frontend + backend + MySQL on one host
- nginx
- systemd
- local certificates
- restricted DB user model
- offline-first deployment expectations

## Operational Notes

- The frontend and backend can stay in separate git repositories and still be deployed together on one Linux machine
- The production frontend should be built and served by nginx, not by the Vite dev server
- The backend, frontend, and database are intended to work fully inside a local network without public internet access
- Keep document downloads and APK files in the backend `docs` folder structure
