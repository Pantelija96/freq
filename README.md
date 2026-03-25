# Device Frequency Management System

## Setup Instructions

### 1. Database Setup
Make sure MySQL is installed and running.

Create the database:
```sql
CREATE DATABASE freq CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
```
Import the tables using the file db.sql (in the project root).


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