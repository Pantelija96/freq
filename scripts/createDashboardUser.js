const pool = require('../src/config/db');
const {
    hashPassword,
    normalizeUsername
} = require('../src/services/userAuthService');

async function main() {
    const [, , usernameArg, passwordArg, roleArg = 'user', firstNameArg = '', lastNameArg = ''] = process.argv;

    if (!usernameArg || !passwordArg) {
        console.error(
            'Usage: node scripts/createDashboardUser.js <username> <password> [admin|user] [first_name] [last_name]'
        );
        process.exit(1);
    }

    const username = normalizeUsername(usernameArg);
    const passwordHash = hashPassword(passwordArg);
    const role = ['admin', 'user'].includes(String(roleArg).toLowerCase())
        ? String(roleArg).toLowerCase()
        : 'user';

    try {
        const [existingRows] = await pool.execute(
            `SELECT id FROM users WHERE username = ? LIMIT 1`,
            [username]
        );

        if (existingRows.length) {
            await pool.execute(
                `UPDATE users
                 SET password = ?, role = ?, first_name = ?, last_name = ?
                 WHERE username = ?`,
                [passwordHash, role, firstNameArg || null, lastNameArg || null, username]
            );

            console.log(`Updated dashboard user "${username}" with role "${role}".`);
        } else {
            await pool.execute(
                `INSERT INTO users (username, password, role, first_name, last_name)
                 VALUES (?, ?, ?, ?, ?)`,
                [username, passwordHash, role, firstNameArg || null, lastNameArg || null]
            );

            console.log(`Created dashboard user "${username}" with role "${role}".`);
        }
    } catch (error) {
        console.error(`Failed to create dashboard user: ${error.message}`);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

main();
