import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from '../support/harness.js';
import { fixDeveloperLogos } from '../../src/domain/developerLogos.js';

let app;
before(async () => { app = await startTestApp(); });
after(async () => { await app?.stop(); });

test('developer-logo repair: dry run changes nothing, --apply fixes only rows that still hold the wrong value', async () => {
  const db = app.ctx.db;
  const make = async (name, logo) => (await app.api.post('/api/developers', { name: `${name}`, logo }, app.adminToken)).body.id;
  // names must match exactly; use fresh rows so the test does not depend on (or alter) other data
  const existing = await db.rows("SELECT id FROM developers WHERE name IN ('Ora', 'Tatweer Misr')");
  if (existing.length) {
    // the legacy fixture already has these developers: work on them, then put the values back
    const before = await db.rows("SELECT id, logo FROM developers WHERE name IN ('Ora', 'Tatweer Misr')");
    try {
      await db.exec("UPDATE developers SET logo = '/developers/ahly-sabbour.jpg' WHERE name = 'Ora'");
      await db.exec("UPDATE developers SET logo = '/custom/tatweer.png' WHERE name = 'Tatweer Misr'");
      await check(db);
    } finally {
      for (const r of before) await db.exec('UPDATE developers SET logo = ? WHERE id = ?', [r.logo, r.id]);
    }
  } else {
    const ids = [await make('Ora', '/developers/ahly-sabbour.jpg'), await make('Tatweer Misr', '/custom/tatweer.png')];
    try { await check(db); } finally { for (const id of ids) await app.api.del(`/api/developers/${id}`, app.adminToken); }
  }
});

async function check(db) {
  const logo = async (name) => (await db.one('SELECT logo FROM developers WHERE name = ?', [name])).logo;
  const dry = await fixDeveloperLogos(db);
  assert.equal(dry.changed, 0);
  assert.ok(dry.planned >= 1);
  assert.equal(await logo('Ora'), '/developers/ahly-sabbour.jpg', 'dry run must not write');
  const real = await fixDeveloperLogos(db, { apply: true });
  assert.ok(real.changed >= 1);
  assert.equal(await logo('Ora'), '/developers/ora.jpg');
  assert.equal(await logo('Tatweer Misr'), '/custom/tatweer.png', 'a logo an admin changed is left alone');
  assert.equal((await fixDeveloperLogos(db, { apply: true })).changed, 0, 'running again is a no-op');
}
