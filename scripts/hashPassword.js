const { hashPassword } = require('../src/services/userAuthService');

const password = process.argv[2];

if (!password) {
    console.error('Usage: node scripts/hashPassword.js <plain-text-password>');
    process.exit(1);
}

console.log(hashPassword(password));
