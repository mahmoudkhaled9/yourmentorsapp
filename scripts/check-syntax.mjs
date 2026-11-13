// Syntax-checks every backend JavaScript file (there is no build step for the backend).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const roots = ['src', 'scripts', 'test'];
const files = [];
const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.(m?js)$/.test(e.name)) files.push(p); } };
roots.filter((r) => fs.existsSync(r)).forEach(walk);
let failed = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { failed += 1; console.error(`✗ ${f}\n${e.stderr}`); }
}
console.log(`${files.length - failed}/${files.length} files OK`);
process.exit(failed ? 1 : 0);
