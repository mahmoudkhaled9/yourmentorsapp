// READ-ONLY post-deployment check of a live installation (safe against production: it never writes data).
//   node scripts/post-deploy-check.mjs --api https://api.<domain> --app https://crm.<domain>
//   optional: CHECK_EMAIL / CHECK_PASSWORD (environment) of an administrator to also read every main list endpoint.
// Exit 0 = everything answered as expected.
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1]?.replace(/\/+$/, '') : undefined; };
const api = arg('api')?.replace(/\/api$/, '');
const app = arg('app');
if (!api || !app) { console.error('usage: node scripts/post-deploy-check.mjs --api https://api.<domain> --app https://crm.<domain>'); process.exit(2); }
const problems = [];
const ok = (m) => console.log(`  ok      ${m}`);
const bad = (m) => { problems.push(m); console.log(`  PROBLEM ${m}`); };
const get = (url, init = {}) => fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), ...init });

async function step(label, fn) {
  try { await fn(); } catch (err) { bad(`${label}: ${err.cause?.code ?? err.message}`); }
}

console.log(`API ${api}`);
await step('health', async () => {
  if (!api.startsWith('https://')) bad('the API is not served over HTTPS');
  const r = await get(`${api}/api/health`);
  const body = await r.json().catch(() => ({}));
  if (r.status === 200 && body.status === 'healthy') ok('/api/health: healthy (database reachable)'); else bad(`/api/health answered ${r.status}`);
  if (/max-age=\d+/.test(r.headers.get('strict-transport-security') ?? '')) ok('HSTS'); else bad('no Strict-Transport-Security header');
  if (r.headers.get('x-powered-by')) bad('X-Powered-By header reveals the server software'); else ok('no X-Powered-By header');
});
await step('auth', async () => {
  const r = await get(`${api}/api/leads`);
  if (r.status === 401) ok('protected endpoints refuse anonymous requests'); else bad(`GET /api/leads without a token answered ${r.status}`);
  const origin = new URL(app).origin;
  const pre = await get(`${api}/api/leads`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET' } });
  if (pre.headers.get('access-control-allow-origin') === origin) ok(`CORS allows the frontend (${origin})`); else bad(`CORS does not allow ${origin}`);
  const evil = await get(`${api}/api/leads`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
  if (!evil.headers.get('access-control-allow-origin')) ok('CORS refuses other websites'); else bad('CORS allows an unknown website');
});
if (process.env.CHECK_EMAIL && process.env.CHECK_PASSWORD) {
  await step('signed-in reads', async () => {
    const r = await get(`${api}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: process.env.CHECK_EMAIL, password: process.env.CHECK_PASSWORD }) });
    const { token } = await r.json().catch(() => ({}));
    if (!token) { bad(`sign-in failed (${r.status})`); return; }
    ok('administrator sign-in');
    for (const path of ['auth/me', 'users', 'leads', 'cold-calls', 'statuses', 'lead-sources', 'lead-options', 'developers', 'projects', 'deals', 'reports', 'comments', 'call-actions', 'agent-care']) {
      const res = await get(`${api}/api/${path}`, { headers: { authorization: `Bearer ${token}` } });
      if (res.status === 200 && /json/.test(res.headers.get('content-type') ?? '')) ok(`GET /api/${path}`); else bad(`GET /api/${path} answered ${res.status}`);
    }
  });
} else {
  console.log('  note    CHECK_EMAIL / CHECK_PASSWORD not set: signed-in reads skipped');
}

console.log(`\nFrontend ${app}`);
await step('frontend', async () => {
  if (!app.startsWith('https://')) bad('the frontend is not served over HTTPS');
  const index = await get(`${app}/`);
  const html = await index.text();
  if (index.status === 200 && html.includes('<div id="root">')) ok('index.html'); else bad(`/ answered ${index.status}`);
  const csp = (html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) ?? [])[1];
  if (csp && csp.includes(new URL(api).origin)) ok(`Content-Security-Policy allows the API (${new URL(api).origin})`); else bad('Content-Security-Policy missing or does not name the API origin (wrong VITE_API_BASE in the build?)');
  if (/(localhost|127\.0\.0\.1)/.test(html)) bad('index.html mentions a local address');
  const deep = await get(`${app}/leads/1`);
  if (deep.status === 200 && (await deep.text()).includes('<div id="root">')) ok('deep links work (SPA fallback: /leads/1 serves the app)'); else bad(`/leads/1 answered ${deep.status} (SPA fallback missing)`);
  for (const [h, re] of [['x-frame-options', /deny/i], ['x-content-type-options', /nosniff/i]]) {
    if (re.test(index.headers.get(h) ?? '')) ok(`${h}`); else bad(`${h} header missing (is .htaccess / the web server config applied?)`);
  }
  if (/no-cache/.test(index.headers.get('cache-control') ?? '')) ok('index.html is not cached (new releases show immediately)'); else bad('index.html may be cached by browsers');
  const asset = (html.match(/src="(\/assets\/[^"]+\.js)"/) ?? [])[1];
  if (asset) {
    const a = await get(`${app}${asset}`);
    if (a.status === 200 && /javascript/.test(a.headers.get('content-type') ?? '')) ok(`${asset} served as JavaScript`); else bad(`${asset} answered ${a.status} ${a.headers.get('content-type')}`);
    if (/max-age=31536000/.test(a.headers.get('cache-control') ?? '')) ok('assets are cached long-term'); else bad('assets have no long-term cache header');
    const js = await a.text();
    const worker = (js.match(/\/assets\/pdf\.worker[^"'`]+\.mjs/) ?? [])[0];
    if (worker) {
      const w = await get(`${app}${worker}`, { method: 'HEAD' });
      if (/javascript/.test(w.headers.get('content-type') ?? '')) ok('PDF worker (.mjs) served as JavaScript'); else bad(`PDF worker served as "${w.headers.get('content-type')}" (PDF import would fail)`);
    }
  } else bad('no script found in index.html');
});

console.log(problems.length ? `\nPOST-DEPLOY CHECK: ${problems.length} problem(s)` : '\nPOST-DEPLOY CHECK: ok');
process.exit(problems.length ? 1 : 0);
