# Device Frequency Management System

## Setup Instructions

### 1. Database Setup
Make sure MySQL is installed and running.

Create the database:
```sql
CREATE DATABASE freq CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
```
Import the tables using the file `frequencies.sql` (in the project root).

To fully rebuild the database from `.env` and recreate the default dashboard users, run:
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


###2. Project Setup

Install dependencies:
```bash
npm install
```

Copy and configure the environment file:
```bash
cp .env.example .env
```

Edit .env with your database details:
```text
DB_HOST=127.0.0.1
DB_USER=root
DB_PASSWORD=your_password_here
DB_NAME=freq
DASHBOARD_SECRET=change-me-dashboard-secret
PROVISION_SECRET=change-me-provision-secret
```

Place your SSL certificates in the cert/ folder:
server.key
server.cert


###3. Run the Server
Development:
```bash
npm run dev
```

Production:
```bash 
npm start
```

The server will run on https://127.0.0.1:3000

All API endpoints start with /api (example: /api/devices/provision)

Protected routes:
- Send `Authorization: Bearer <DASHBOARD_SECRET>` or `x-dashboard-secret: <DASHBOARD_SECRET>` for `/api/dashboard/*` and `/api/command/*`
- Send `x-provision-secret: <PROVISION_SECRET>` for `/api/devices/provision`
- Connect dashboard WebSocket clients to `/dashboard?token=<DASHBOARD_SECRET>`

Dashboard login:
- `POST /api/auth/login` with `{ "username": "admin", "password": "secret" }`
- On success the API returns a JWT signed with `DASHBOARD_SECRET`
- Use that token as `Authorization: Bearer <token>` for protected dashboard routes
- `GET /api/auth/me` returns the current authenticated user info
- `POST /api/auth/logout` confirms logout; since auth is JWT-based, the client should also delete the token locally
- `AUTH_MODE=local` uses the `users` table today; the config already leaves room for a future LDAP/AD provider
- Passwords should be stored as `scrypt$<salt>$<hash>` values for safer local auth
- Generate a local password hash with `node scripts/hashPassword.js your-password`
- Or create/update a dashboard user directly with `node scripts/createDashboardUser.js admin your-password admin System Administrator`
- Plain text passwords are still accepted temporarily for migration, but new users should use hashes

Script to insert new user (testing)
```bash
node scripts/createDashboardUser.js user user user Regular UserB
```

Developer helper endpoints:
- When `DEV_TOOLS_ENABLED=true`, unguarded endpoints are under `/api/dev`
- The companion unguarded dev page is available at `/dev/`
- `GET /api/dev/devices` lists devices plus websocket session status
- `POST /api/dev/devices/:deviceId/commands` sends a command body like `{ "type": "ping", "payload": { "foo": "bar" } }`
- `GET /api/dev/devices/:deviceId/commands?limit=20` shows recent command history
- `GET /api/dev/logs` lists log files
- `GET /api/dev/logs/<filename>?lines=200` tails a readable log file
- Dev page accessible on: https://127.0.0.1:3000/dev/ 
