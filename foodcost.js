// Module Food cost : inventaire par etagere/zone, valorise au prix d'achat (CHF).
//
// Calcul du food cost d'une periode (entre deux inventaires) :
//   consommation = stock debut + achats de la periode - stock fin
//   food cost %  = consommation / chiffre d'affaires de la periode
const express = require('express');
const { pool } = require('./db');

const router = express.Router();

function wrap(handler) {
  return (req, res) => {
    handler(req, res).catch(err => {
      console.error(err);
      res.status(500).json({ error: 'Erreur serveur' });
    });
  };
}

function requireRestaurantId(req, res) {
  const restaurantId = req.query.restaurantId || (req.body && req.body.restaurantId);
  if (!restaurantId) {
    res.status(400).json({ error: 'Restaurant requis' });
    return null;
  }
  return restaurantId;
}

// Accepte "2,5" comme "2.5" (saisie a la virgule sur tablette suisse/francaise).
function parseNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(',', '.').trim());
  return Number.isFinite(n) ? n : NaN;
}

const DEFAULT_SHELVES = [
  'Étagère épices',
  'Étagère garage',
  'Boissons',
  'Frigo tacos',
  'Frigo shawarma',
  'Congélateur',
  'Chambre froide'
];

// Cree les zones par defaut une seule fois par restaurant. Le drapeau dans
// settings evite de les recreer si le gerant les supprime volontairement.
async function seedShelvesOnce(restaurantId) {
  const flagKey = `fc_seeded_${restaurantId}`;
  const { rowCount } = await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, '1') ON CONFLICT (key) DO NOTHING`,
    [flagKey]
  );
  if (!rowCount) return;
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM fc_shelves WHERE restaurant_id = $1', [restaurantId]
  );
  if (rows[0].n > 0) return;
  for (let i = 0; i < DEFAULT_SHELVES.length; i++) {
    await pool.query(
      'INSERT INTO fc_shelves (restaurant_id, name, position) VALUES ($1, $2, $3)',
      [restaurantId, DEFAULT_SHELVES[i], i]
    );
  }
}

const DEFAULT_TYPES = [
  'Matières premières',
  'Emballages',
  'Produits nettoyage, vaisselle & autres'
];

// Types par defaut, une seule fois par restaurant. Les articles crees avant
// l'existence des types sont ranges dans le premier (matieres premieres).
async function seedTypesOnce(restaurantId) {
  const { rowCount } = await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, '1') ON CONFLICT (key) DO NOTHING`,
    [`fc_types_seeded_${restaurantId}`]
  );
  if (!rowCount) return;
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM fc_types WHERE restaurant_id = $1', [restaurantId]
  );
  if (rows[0].n > 0) return;
  let firstId = null;
  for (let i = 0; i < DEFAULT_TYPES.length; i++) {
    const r = await pool.query(
      'INSERT INTO fc_types (restaurant_id, name, position) VALUES ($1, $2, $3) RETURNING id',
      [restaurantId, DEFAULT_TYPES[i], i]
    );
    if (i === 0) firstId = r.rows[0].id;
  }
  await pool.query(
    'UPDATE fc_items SET type_id = $1 WHERE restaurant_id = $2 AND type_id IS NULL',
    [firstId, restaurantId]
  );
}

// Valeur d'un inventaire : prix fige si cloture, sinon prix actuel de l'article.
const INVENTORY_TOTALS_SQL = `
  SELECT inv.id, inv.label, inv.inv_date::text AS inv_date, inv.status, inv.purchases, inv.sales, inv.closed_at,
         COALESCE(SUM(c.qty * COALESCE(c.unit_price, i.price)), 0)::float AS total,
         COUNT(c.item_id)::int AS counted
  FROM fc_inventories inv
  LEFT JOIN fc_counts c ON c.inventory_id = inv.id
  LEFT JOIN fc_items i ON i.id = c.item_id
  WHERE inv.restaurant_id = $1
  GROUP BY inv.id
  ORDER BY inv.inv_date DESC, inv.id DESC
`;

// ---------- Etat global ----------

router.get('/state', wrap(async (req, res) => {
  const restaurantId = requireRestaurantId(req, res);
  if (!restaurantId) return;
  await seedShelvesOnce(restaurantId);
  await seedTypesOnce(restaurantId);

  const [shelves, types, items, inventories] = await Promise.all([
    pool.query(
      'SELECT id, name, position FROM fc_shelves WHERE restaurant_id = $1 ORDER BY position, id',
      [restaurantId]
    ),
    pool.query(
      'SELECT id, name, position FROM fc_types WHERE restaurant_id = $1 ORDER BY position, id',
      [restaurantId]
    ),
    pool.query(
      `SELECT id, shelf_id, type_id, name, unit, price::float AS price, archived, position
       FROM fc_items WHERE restaurant_id = $1 ORDER BY position, name, id`,
      [restaurantId]
    ),
    pool.query(INVENTORY_TOTALS_SQL, [restaurantId])
  ]);

  res.json({
    shelves: shelves.rows,
    types: types.rows,
    items: items.rows,
    inventories: inventories.rows.map(r => Object.assign(r, {
      purchases: r.purchases === null ? null : Number(r.purchases),
      sales: r.sales === null ? null : Number(r.sales)
    }))
  });
}));

// ---------- Etageres / zones ----------

router.post('/shelves', wrap(async (req, res) => {
  const { name, restaurantId } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom requis' });
  if (!restaurantId) return res.status(400).json({ error: 'Restaurant requis' });
  const { rows } = await pool.query(
    `INSERT INTO fc_shelves (restaurant_id, name, position)
     VALUES ($1, $2, (SELECT COALESCE(MAX(position), -1) + 1 FROM fc_shelves WHERE restaurant_id = $1))
     RETURNING id, name, position`,
    [restaurantId, name.trim()]
  );
  res.json(rows[0]);
}));

router.put('/shelves/:id', wrap(async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom requis' });
  await pool.query('UPDATE fc_shelves SET name = $1 WHERE id = $2', [name.trim(), req.params.id]);
  res.json({ ok: true });
}));

router.delete('/shelves/:id', wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM fc_items WHERE shelf_id = $1 AND NOT archived',
    [req.params.id]
  );
  if (rows[0].n > 0) {
    return res.status(400).json({ error: `${rows[0].n} article(s) encore rangé(s) ici. Déplacez-les ou supprimez-les d'abord.` });
  }
  await pool.query('DELETE FROM fc_shelves WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- Types de marchandise ----------

router.post('/types', wrap(async (req, res) => {
  const { name, restaurantId } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom requis' });
  if (!restaurantId) return res.status(400).json({ error: 'Restaurant requis' });
  const { rows } = await pool.query(
    `INSERT INTO fc_types (restaurant_id, name, position)
     VALUES ($1, $2, (SELECT COALESCE(MAX(position), -1) + 1 FROM fc_types WHERE restaurant_id = $1))
     RETURNING id, name, position`,
    [restaurantId, name.trim()]
  );
  res.json(rows[0]);
}));

router.put('/types/:id', wrap(async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom requis' });
  await pool.query('UPDATE fc_types SET name = $1 WHERE id = $2', [name.trim(), req.params.id]);
  res.json({ ok: true });
}));

router.delete('/types/:id', wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM fc_items WHERE type_id = $1 AND NOT archived',
    [req.params.id]
  );
  if (rows[0].n > 0) {
    return res.status(400).json({ error: `${rows[0].n} article(s) ont encore ce type. Changez-leur de type d'abord.` });
  }
  await pool.query('DELETE FROM fc_types WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- Articles ----------

function readItemBody(body) {
  const out = {};
  if (body.name !== undefined) {
    if (!body.name || !body.name.trim()) return { error: 'Nom requis' };
    out.name = body.name.trim();
  }
  if (body.unit !== undefined) out.unit = (body.unit || '').trim() || 'pce';
  if (body.price !== undefined) {
    const price = parseNumber(body.price);
    if (price === null || Number.isNaN(price) || price < 0) return { error: "Prix d'achat invalide" };
    out.price = price;
  }
  if (body.shelfId !== undefined) out.shelf_id = body.shelfId || null;
  if (body.typeId !== undefined) out.type_id = body.typeId || null;
  return { fields: out };
}

router.post('/items', wrap(async (req, res) => {
  const body = req.body || {};
  if (!body.restaurantId) return res.status(400).json({ error: 'Restaurant requis' });
  if (!body.shelfId) return res.status(400).json({ error: 'Étagère requise' });
  if (body.name === undefined) return res.status(400).json({ error: 'Nom requis' });
  const { error, fields } = readItemBody(body);
  if (error) return res.status(400).json({ error });
  const { rows } = await pool.query(
    `INSERT INTO fc_items (restaurant_id, shelf_id, type_id, name, unit, price, position)
     VALUES ($1, $2, $3, $4, $5, $6,
       (SELECT COALESCE(MAX(position), -1) + 1 FROM fc_items WHERE shelf_id = $2))
     RETURNING id`,
    [body.restaurantId, fields.shelf_id, fields.type_id || null, fields.name, fields.unit || 'pce', fields.price || 0]
  );
  res.json({ id: rows[0].id });
}));

router.put('/items/:id', wrap(async (req, res) => {
  const { error, fields } = readItemBody(req.body || {});
  if (error) return res.status(400).json({ error });
  const keys = Object.keys(fields);
  if (!keys.length) return res.json({ ok: true });
  const sets = keys.map((k, i) => `${k} = $${i + 1}`);
  await pool.query(
    `UPDATE fc_items SET ${sets.join(', ')} WHERE id = $${keys.length + 1}`,
    [...keys.map(k => fields[k]), req.params.id]
  );
  res.json({ ok: true });
}));

// Un article deja compte reste en base (archive) pour ne pas fausser les
// inventaires passes ; sinon il est supprime pour de bon.
router.delete('/items/:id', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM fc_counts c
     JOIN fc_inventories inv ON inv.id = c.inventory_id
     WHERE c.item_id = $1 AND inv.status = 'closed'`,
    [req.params.id]
  );
  if (rows[0].n > 0) {
    await pool.query('UPDATE fc_items SET archived = true WHERE id = $1', [req.params.id]);
    // Retire l'article des inventaires encore en cours.
    await pool.query(
      `DELETE FROM fc_counts c USING fc_inventories inv
       WHERE c.inventory_id = inv.id AND inv.status = 'open' AND c.item_id = $1`,
      [req.params.id]
    );
  } else {
    await pool.query('DELETE FROM fc_items WHERE id = $1', [req.params.id]);
  }
  res.json({ ok: true });
}));

// ---------- Inventaires ----------

router.post('/inventories', wrap(async (req, res) => {
  const { restaurantId, label, invDate } = req.body || {};
  if (!restaurantId) return res.status(400).json({ error: 'Restaurant requis' });
  if (!label || !label.trim()) return res.status(400).json({ error: 'Nom requis' });
  const { rows } = await pool.query(
    `INSERT INTO fc_inventories (restaurant_id, label, inv_date)
     VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE)) RETURNING id`,
    [restaurantId, label.trim(), invDate || null]
  );
  res.json({ id: rows[0].id });
}));

router.get('/inventories/:id', wrap(async (req, res) => {
  const inv = await pool.query(
    `SELECT id, restaurant_id, label, inv_date::text AS inv_date, status, purchases, sales, closed_at
     FROM fc_inventories WHERE id = $1`,
    [req.params.id]
  );
  if (!inv.rows.length) return res.status(404).json({ error: 'Inventaire introuvable' });
  const counts = await pool.query(
    `SELECT item_id, qty::float AS qty, unit_price::float AS unit_price, counted_by, updated_at
     FROM fc_counts WHERE inventory_id = $1`,
    [req.params.id]
  );
  const row = inv.rows[0];
  row.purchases = row.purchases === null ? null : Number(row.purchases);
  row.sales = row.sales === null ? null : Number(row.sales);
  res.json(Object.assign(row, { counts: counts.rows }));
}));

router.put('/inventories/:id', wrap(async (req, res) => {
  const { label, invDate, purchases, sales } = req.body || {};
  const sets = [];
  const values = [];
  if (label !== undefined) {
    if (!label || !label.trim()) return res.status(400).json({ error: 'Nom requis' });
    values.push(label.trim()); sets.push(`label = $${values.length}`);
  }
  if (invDate !== undefined) {
    values.push(invDate); sets.push(`inv_date = $${values.length}::date`);
  }
  for (const [key, raw] of [['purchases', purchases], ['sales', sales]]) {
    if (raw === undefined) continue;
    const n = parseNumber(raw);
    if (Number.isNaN(n) || (n !== null && n < 0)) return res.status(400).json({ error: 'Montant invalide' });
    values.push(n); sets.push(`${key} = $${values.length}`);
  }
  if (!sets.length) return res.json({ ok: true });
  values.push(req.params.id);
  await pool.query(`UPDATE fc_inventories SET ${sets.join(', ')} WHERE id = $${values.length}`, values);
  res.json({ ok: true });
}));

router.delete('/inventories/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM fc_inventories WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// Saisie d'une quantite par l'employe. qty vide = "pas encore compte".
router.put('/inventories/:id/counts/:itemId', wrap(async (req, res) => {
  const { qty, countedBy } = req.body || {};
  const inv = await pool.query('SELECT status FROM fc_inventories WHERE id = $1', [req.params.id]);
  if (!inv.rows.length) return res.status(404).json({ error: 'Inventaire introuvable' });
  if (inv.rows[0].status !== 'open') return res.status(400).json({ error: 'Inventaire clôturé' });

  const n = parseNumber(qty);
  if (n === null) {
    await pool.query(
      'DELETE FROM fc_counts WHERE inventory_id = $1 AND item_id = $2',
      [req.params.id, req.params.itemId]
    );
    return res.json({ ok: true });
  }
  if (Number.isNaN(n) || n < 0) return res.status(400).json({ error: 'Quantité invalide' });

  await pool.query(
    `INSERT INTO fc_counts (inventory_id, item_id, qty, counted_by, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (inventory_id, item_id)
     DO UPDATE SET qty = EXCLUDED.qty, counted_by = EXCLUDED.counted_by, updated_at = now()`,
    [req.params.id, req.params.itemId, n, countedBy || null]
  );
  res.json({ ok: true });
}));

// Cloture : fige le prix d'achat de chaque ligne. Un changement de prix
// ulterieur ne modifie donc plus la valeur d'un inventaire passe.
router.post('/inventories/:id/close', wrap(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE fc_counts c SET unit_price = i.price
       FROM fc_items i WHERE i.id = c.item_id AND c.inventory_id = $1`,
      [req.params.id]
    );
    await client.query(
      `UPDATE fc_inventories SET status = 'closed', closed_at = now() WHERE id = $1`,
      [req.params.id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.json({ ok: true });
}));

router.post('/inventories/:id/reopen', wrap(async (req, res) => {
  await pool.query('UPDATE fc_counts SET unit_price = NULL WHERE inventory_id = $1', [req.params.id]);
  await pool.query(
    `UPDATE fc_inventories SET status = 'open', closed_at = NULL WHERE id = $1`,
    [req.params.id]
  );
  res.json({ ok: true });
}));

module.exports = router;
