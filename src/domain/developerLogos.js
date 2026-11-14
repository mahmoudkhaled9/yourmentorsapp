/**
 * The original data shipped with developer logos swapped between developers. This repairs ONLY rows that still hold the
 * exact wrong value (so a logo an administrator changed is never touched). Used by scripts/fix-developer-logos.mjs.
 */
// [developer name, wrong value shipped, correct value ('' = no logo file exists yet)]
export const LOGO_FIXES = [
  ['Ora', '/developers/ahly-sabbour.jpg', '/developers/ora.jpg'],
  ['Hassan Allam Properties', '/developers/tatweer-misr.jpg', '/developers/hassan-allam.jpg'],
  ['Hyde Park Developments', '/developers/horizon.jpg', '/developers/hyde-park.jpg'],
  ['Tatweer Misr', '/developers/hassan-allam.jpg', '/developers/tatweer-misr.jpg'],
  ['Mountain View', '/developers/ora.jpg', '/developers/mountain-view.jpg'],
  ['Horizon Egypt', '/developers/hyde-park.jpg', '/developers/horizon.jpg'],
  ['AL-Marasem', '/developers/ahly-sabbour.jpg', ''],
  ['Al Ahly Sabbour', '/developers/almarassem.jpg', ''],
];


export async function fixDeveloperLogos(db, { apply = false, log = () => {} } = {}) {
  let planned = 0;
  let changed = 0;
  for (const [name, wrong, right] of LOGO_FIXES) {
    const rows = await db.rows('SELECT id, name, logo FROM developers WHERE name = ? AND logo = ?', [name, wrong]);
    for (const row of rows) {
      planned += 1;
      log(`${apply ? 'UPDATE' : 'would update'} developer #${row.id} "${row.name}": ${wrong} -> ${right || '(no logo)'}`);
      if (apply) {
        const r = await db.exec('UPDATE developers SET logo = ? WHERE id = ? AND logo = ?', [right || null, row.id, wrong]);
        changed += Number(r.affectedRows ?? 0);
      }
    }
  }
  return { planned, changed };
}
