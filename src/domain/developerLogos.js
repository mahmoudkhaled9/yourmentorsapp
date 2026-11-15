/**
 * Logos of the built-in developers. Used by scripts/fix-developer-logos.mjs and mirrored in seed/developers.json.
 *
 * Verified by looking at every file in mentorsfront/public/developers (2026-11-15). The files had been saved under the
 * wrong names (ora.jpg showed Mountain View, hassan-allam.jpg showed Tatweer Misr, ...); they were renamed to what they
 * show. Developers without a verified logo file get none (the UI shows its initials) rather than someone else's logo.
 */
export const DEVELOPER_LOGOS = {
  Ora: null,
  'Hassan Allam Properties': '/developers/hassan-allam.jpg',
  'Hyde Park Developments': '/developers/hyde-park.jpg',
  'Tatweer Misr': '/developers/tatweer-misr.jpg',
  'Mountain View': '/developers/mountain-view.jpg',
  'Horizon Egypt': null,
  'AL-Marasem': null,
  'Al Ahly Sabbour': '/developers/al-ahly-sabbour.jpg',
};

/**
 * Every value this project ever shipped for these developers (old seed, old /api/sync, old file names). Only a row
 * that still holds one of these (or no logo) is changed; any other value is an administrator's own choice and is kept.
 */
export const SHIPPED_LOGOS = new Set([
  '/developers/ora.jpg', '/developers/hassan-allam.jpg', '/developers/hyde-park.jpg', '/developers/tatweer-misr.jpg',
  '/developers/mountain-view.jpg', '/developers/horizon.jpg', '/developers/ahly-sabbour.jpg', '/developers/almarassem.jpg',
  '/developers/al-ahly-sabbour.jpg',
]);

const isShipped = (logo) => logo === null || logo === undefined || logo === '' || SHIPPED_LOGOS.has(logo);

/** Dry run by default. Idempotent: a second run plans nothing. Each update re-checks the old value (no lost update). */
export async function fixDeveloperLogos(db, { apply = false, log = () => {} } = {}) {
  let planned = 0;
  let changed = 0;
  for (const [name, right] of Object.entries(DEVELOPER_LOGOS)) {
    const rows = await db.rows('SELECT id, name, logo FROM developers WHERE name = ?', [name]);
    for (const row of rows) {
      const current = row.logo || null;
      if (current === right || !isShipped(row.logo)) continue;
      planned += 1;
      log(`${apply ? 'UPDATE' : 'would update'} developer #${row.id} "${row.name}": ${current ?? '(no logo)'} -> ${right ?? '(no logo)'}`);
      if (apply) {
        const r = row.logo === null || row.logo === undefined
          ? await db.exec('UPDATE developers SET logo = ? WHERE id = ? AND logo IS NULL', [right, row.id])
          : await db.exec('UPDATE developers SET logo = ? WHERE id = ? AND logo = ?', [right, row.id, row.logo]);
        changed += Number(r.affectedRows ?? r.changes ?? 0);
      }
    }
  }
  return { planned, changed };
}
