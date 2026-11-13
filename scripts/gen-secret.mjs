// Prints a strong random JWT_SECRET.  With --write it replaces (or adds) the JWT_SECRET line in .env; nothing else in
// the file is touched.  Changing the secret signs everyone out once (their old tokens become invalid).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const secret = crypto.randomBytes(48).toString('hex');
if (!process.argv.includes('--write')) {
  console.log(secret);
  console.log('\nPut it in .env as JWT_SECRET=... or run: npm run gen-secret -- --write');
  process.exit(0);
}
const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
const text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
const next = /^JWT_SECRET=.*$/m.test(text) ? text.replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${secret}`) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}JWT_SECRET=${secret}\n`;
fs.writeFileSync(envPath, next, { mode: 0o600 });
console.log(`JWT_SECRET written to ${envPath} (value not shown). Restart the backend; everybody signs in once more.`);
