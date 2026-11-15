// Prepares the local QA MySQL accounts WITHOUT needing (or seeing) the MySQL administrator password:
//   node scripts/qa-mysql-prepare.mjs
// 1. generates two strong, different passwords (never printed)
// 2. writes .env.test (QA admin + QA test account) and .qa-mysql-setup.local.sql (scripts/qa-mysql-setup.sql with the
//    passwords filled in); both are git-ignored and readable by you only (mode 600)
// 3. prints the ONE command you run yourself:  mysql -h 127.0.0.1 -P 3306 -u root -p < .qa-mysql-setup.local.sql
// Refuses to overwrite an existing .env.test (delete it first to start over).
import crypto from 'node:crypto';
import fs from 'node:fs';

const ENV_FILE = '.env.test';
const SQL_FILE = '.qa-mysql-setup.local.sql';
if (fs.existsSync(ENV_FILE)) {
  console.error(`${ENV_FILE} already exists: nothing changed. Delete it (and drop the QA users) to generate new passwords.`);
  process.exit(1);
}
const pw = () => crypto.randomBytes(24).toString('base64url'); // 32 chars, no quotes or backslashes
const admin = pw();
const tester = pw();
const template = fs.readFileSync('scripts/qa-mysql-setup.sql', 'utf8');
if (!template.includes('<qa-admin-password>') || !template.includes('<qa-test-password>')) throw new Error('setup template placeholders missing');
const sql = template.replace('<qa-admin-password>', admin).replace('<qa-test-password>', tester);
const env = fs.readFileSync('.env.test.example', 'utf8')
  .replace(/^TEST_DB_ADMIN_PASSWORD=.*$/m, `TEST_DB_ADMIN_PASSWORD=${admin}`)
  .replace(/^TEST_DB_PASSWORD=.*$/m, `TEST_DB_PASSWORD=${tester}`);
fs.writeFileSync(SQL_FILE, sql, { mode: 0o600 });
fs.writeFileSync(ENV_FILE, env, { mode: 0o600, flag: 'wx' });
console.log(`wrote ${ENV_FILE} and ${SQL_FILE} (git-ignored, mode 600; passwords not shown).`);
console.log('Now create the two QA accounts as the MySQL administrator (you will be asked for its password):');
console.log(`  mysql -h 127.0.0.1 -P 3306 -u root -p < ${SQL_FILE}`);
console.log(`then run the tests:  npm run test:mysql      (afterwards you may delete ${SQL_FILE})`);
