// Cross-platform "VAR=value command" (Windows shells do not support the inline form).
//   node scripts/run-with-env.mjs A=1 B=2 -- node --test ...
import { spawnSync } from 'node:child_process';
const sep = process.argv.indexOf('--');
const env = { ...process.env };
for (const pair of process.argv.slice(2, sep)) { const i = pair.indexOf('='); env[pair.slice(0, i)] = pair.slice(i + 1); }
const [cmd, ...args] = process.argv.slice(sep + 1);
const r = spawnSync(cmd === 'node' ? process.execPath : cmd, args, { stdio: 'inherit', env, shell: process.platform === 'win32' && cmd !== 'node' });
process.exit(r.status ?? 1);
