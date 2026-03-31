const fs = require('fs');
const path = require('path');

const dotenv = require('dotenv');
const mysql = require('mysql2/promise');

const { hashPassword, normalizeUsername } = require('../src/services/userAuthService');

dotenv.config({
    path: path.resolve(__dirname, '../.env')
});

async function main() {
    const config = getDatabaseConfig();
    const schemaPath = path.resolve(__dirname, '../frequencies.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');

    const adminConnection = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        multipleStatements: true
    });

    try {
        console.log(`Dropping database "${config.database}" if it exists...`);
        await adminConnection.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(config.database)}`);

        console.log(`Creating database "${config.database}"...`);
        await adminConnection.query(
            `CREATE DATABASE ${escapeIdentifier(config.database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`
        );
    } finally {
        await adminConnection.end();
    }

    const appConnection = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        multipleStatements: true
    });

    try {
        console.log('Applying schema from frequencies.sql...');
        await appConnection.query(schemaSql);

        console.log('Creating default dashboard users...');
        await insertDefaultUsers(appConnection);

        console.log('Database reset completed successfully.');
        console.log('Created users:');
        console.log('  admin / admin');
        console.log('  user / user');
    } finally {
        await appConnection.end();
    }
}

function getDatabaseConfig() {
    const host = process.env.DB_HOST;
    const user = process.env.DB_USER;
    const database = process.env.DB_NAME;

    if (!host || !user || !database) {
        throw new Error('DB_HOST, DB_USER, and DB_NAME must be configured in the environment.');
    }

    return {
        host,
        port: Number(process.env.DB_PORT || 3306),
        user,
        password: process.env.DB_PASSWORD || '',
        database
    };
}

async function insertDefaultUsers(connection) {
    const users = [
        {
            username: 'admin',
            password: 'admin',
            role: 'admin',
            firstName: 'System',
            lastName: 'Administrator'
        },
        {
            username: 'user',
            password: 'user',
            role: 'user',
            firstName: 'Read',
            lastName: 'Only'
        }
    ];

    for (const user of users) {
        await connection.execute(
            `
                INSERT INTO users (username, password, role, first_name, last_name)
                VALUES (?, ?, ?, ?, ?)
            `,
            [
                normalizeUsername(user.username),
                hashPassword(user.password),
                user.role,
                user.firstName,
                user.lastName
            ]
        );
    }
}

function escapeIdentifier(value) {
    return `\`${String(value).replaceAll('`', '``')}\``;
}

main().catch((error) => {
    console.error('Database reset failed.');
    console.error(error.message);
    process.exit(1);
});
