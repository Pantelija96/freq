const path = require('path');

const dotenv = require('dotenv');
const mysql = require('mysql2/promise');

dotenv.config({
    path: path.resolve(__dirname, '../.env')
});

async function main() {
    const adminUser = process.env.DB_ADMIN_USER;
    const adminPassword = process.env.DB_ADMIN_PASSWORD;
    const appUser = process.env.DB_USER;
    const appPassword = process.env.DB_PASSWORD || '';
    const host = process.env.DB_HOST || '127.0.0.1';
    const port = Number(process.env.DB_PORT || 3306);
    const database = process.env.DB_NAME || 'freq';
    const bootstrapUser = process.env.DB_BOOTSTRAP_USER || 'root';
    const bootstrapPassword = process.env.DB_BOOTSTRAP_PASSWORD || '';

    if (!adminUser || !adminPassword || !appUser) {
        throw new Error('DB_ADMIN_USER, DB_ADMIN_PASSWORD, DB_USER, and DB_PASSWORD must be set in .env before creating DB users.');
    }

    const connection = await mysql.createConnection({
        host,
        port,
        user: bootstrapUser,
        password: bootstrapPassword,
        multipleStatements: true
    });

    try {
        await connection.query(
            `
                CREATE USER IF NOT EXISTS \`${adminUser}\`@\`127.0.0.1\` IDENTIFIED BY ?;
                GRANT ALL PRIVILEGES ON \`${database}\`.* TO \`${adminUser}\`@\`127.0.0.1\`;
                CREATE USER IF NOT EXISTS \`${appUser}\`@\`127.0.0.1\` IDENTIFIED BY ?;
                GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, INDEX, ALTER
                ON \`${database}\`.* TO \`${appUser}\`@\`127.0.0.1\`;
                FLUSH PRIVILEGES;
            `,
            [adminPassword, appPassword]
        );

        console.log('Database users created or updated successfully.');
        console.log(`  Admin user: ${adminUser}@127.0.0.1`);
        console.log(`  App user:   ${appUser}@127.0.0.1`);
    } finally {
        await connection.end();
    }
}

main().catch((error) => {
    console.error('Failed to create database users.');
    console.error(error.message);
    process.exit(1);
});
