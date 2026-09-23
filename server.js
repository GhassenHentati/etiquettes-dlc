const path = require('path');
const express = require('express');
const { pool, initDb } = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Helpers ----------

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

async function getAdminPassword() {
  const { rows } = await pool.query(
    `SELECT value FROM settings WHERE key = 'admin_password'`
  );
  return rows.length ? rows[0].value : '1234';
}

async function logEvent({ type, restaurantId, productName, fridgeName, employee, dlcDate, expiredDlc }) {
  await pool.query(
    `INSERT INTO activity_log (type, restaurant_id, product_name, fridge_name, employee, dlc_date, expired_dlc)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [type, restaurantId, productName, fridgeName || null, employee || null, dlcDate || null, expiredDlc || null]
  );
}

// Aligne l'ensemble des restaurants d'un produit sur (restaurantId, ...otherRestaurantIds).
// Le frigo choisi ne s'applique qu'au restaurant courant ; les autres restaurants
// cochés recoivent une ligne de suivi vide (a completer plus tard depuis leur tablette).
// La categorie du produit est etendue aux memes restaurants : sinon le produit
// deviendrait invisible dans la navigation par categorie de ces restaurants.
async function syncProductRestaurants(productId, categoryId, restaurantId, fridgeId, otherRestaurantIds) {
  const current = Number(restaurantId);
  const targetIds = [current, ...(otherRestaurantIds || []).map(Number).filter(n => n !== current)];

  await pool.query(
    `INSERT INTO product_restaurants (product_id, restaurant_id, fridge_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (product_id, restaurant_id) DO UPDATE SET fridge_id = EXCLUDED.fridge_id`,
    [productId, current, fridgeId || null]
  );

  for (const rid of targetIds) {
    if (rid === current) continue;
    await pool.query(
      `INSERT INTO product_restaurants (product_id, restaurant_id)
       VALUES ($1, $2) ON CONFLICT (product_id, restaurant_id) DO NOTHING`,
      [productId, rid]
    );
  }

  await pool.query(
    `DELETE FROM product_restaurants WHERE product_id = $1 AND restaurant_id != ALL($2::int[])`,
    [productId, targetIds]
  );

  if (categoryId) {
    await pool.query(
      `INSERT INTO category_restaurants (category_id, restaurant_id)
       SELECT $1, unnest($2::int[])
       ON CONFLICT (category_id, restaurant_id) DO NOTHING`,
      [categoryId, targetIds]
    );
  }
}

// ---------- Restaurants ----------

app.get('/api/restaurants', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT id, name FROM restaurants ORDER BY id');
  res.json(rows);
}));

app.post('/api/restaurants', wrap(async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom requis' });
  const { rows } = await pool.query(
    'INSERT INTO restaurants (name) VALUES ($1) RETURNING id, name',
    [name.trim()]
  );
  res.json(rows[0]);
}));

app.put('/api/restaurants/:id', wrap(async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom requis' });
  await pool.query('UPDATE restaurants SET name = $1 WHERE id = $2', [name.trim(), req.params.id]);
  res.json({ ok: true });
}));

app.delete('/api/restaurants/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM restaurants WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- Zones ----------

app.get('/api/zones', wrap(async (req, res) => {
  const restaurantId = requireRestaurantId(req, res);
  if (!restaurantId) return;
  const { rows } = await pool.query(
    'SELECT id, name, restaurant_id FROM zones WHERE restaurant_id = $1 ORDER BY id',
    [restaurantId]
  );
  res.json(rows);
}));

app.post('/api/zones', wrap(async (req, res) => {
  const { name, restaurantId } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom requis' });
  if (!restaurantId) return res.status(400).json({ error: 'Restaurant requis' });
  const { rows } = await pool.query(
    'INSERT INTO zones (restaurant_id, name) VALUES ($1, $2) RETURNING id, name, restaurant_id',
    [restaurantId, name.trim()]
  );
  res.json(rows[0]);
}));

app.put('/api/zones/:id', wrap(async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom requis' });
  await pool.query('UPDATE zones SET name = $1 WHERE id = $2', [name.trim(), req.params.id]);
  res.json({ ok: true });
}));

app.delete('/api/zones/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM zones WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- Etat global d'un restaurant (une seule requete pour toute l'app) ----------

app.get('/api/state', wrap(async (req, res) => {
  const restaurantId = requireRestaurantId(req, res);
  if (!restaurantId) return;

  const [employees, fridges, zones, categories, products] = await Promise.all([
    pool.query(
      `SELECT e.id, e.name, e.code FROM employees e
       JOIN employee_restaurants er ON er.employee_id = e.id
       WHERE er.restaurant_id = $1 ORDER BY e.id`,
      [restaurantId]
    ),
    pool.query(
      'SELECT id, name, zone_id FROM fridges WHERE restaurant_id = $1 ORDER BY id',
      [restaurantId]
    ),
    pool.query(
      'SELECT id, name FROM zones WHERE restaurant_id = $1 ORDER BY id',
      [restaurantId]
    ),
    pool.query(
      `SELECT c.id, c.name FROM categories c
       JOIN category_restaurants cr ON cr.category_id = c.id
       WHERE cr.restaurant_id = $1 ORDER BY c.id`,
      [restaurantId]
    ),
    pool.query(
      `SELECT p.id, p.name, p.category_id, p.delay_days,
              pr.fridge_id, pr.last_print_date, pr.last_dlc_date, pr.last_print_employee
       FROM products p
       JOIN product_restaurants pr ON pr.product_id = p.id
       WHERE pr.restaurant_id = $1 ORDER BY p.id`,
      [restaurantId]
    )
  ]);

  res.json({
    employees: employees.rows,
    fridges: fridges.rows,
    zones: zones.rows,
    categories: categories.rows,
    products: products.rows
  });
}));

// ---------- Connexion ----------

app.post('/api/login', wrap(async (req, res) => {
  const { type, employeeId, code, restaurantId } = req.body || {};

  if (type === 'admin') {
    const adminPassword = await getAdminPassword();
    if (code === adminPassword) return res.json({ ok: true, user: { type: 'admin' } });
    return res.status(401).json({ ok: false });
  }

  if (!restaurantId) return res.status(400).json({ error: 'Restaurant requis' });

  const { rows } = await pool.query(
    `SELECT e.id, e.name FROM employees e
     JOIN employee_restaurants er ON er.employee_id = e.id AND er.restaurant_id = $3
     WHERE e.id = $1 AND e.code = $2`,
    [employeeId, code, restaurantId]
  );
  if (!rows.length) return res.status(401).json({ ok: false });

  res.json({ ok: true, user: { type: 'employee', id: rows[0].id, name: rows[0].name } });
}));

app.post('/api/admin-password', wrap(async (req, res) => {
  const { current, next } = req.body || {};
  const adminPassword = await getAdminPassword();
  if (current !== adminPassword) return res.status(401).json({ error: 'Code actuel incorrect' });
  if (!/^\d{4}$/.test(next || '')) return res.status(400).json({ error: 'Le code doit faire 4 chiffres' });

  await pool.query(`UPDATE settings SET value = $1 WHERE key = 'admin_password'`, [next]);
  res.json({ ok: true });
}));

// ---------- Restaurants associes a une entree (pour pre-cocher a l'edition) ----------

app.get('/api/categories/:id/restaurants', wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT restaurant_id FROM category_restaurants WHERE category_id = $1', [req.params.id]
  );
  res.json(rows.map(r => r.restaurant_id));
}));

app.get('/api/employees/:id/restaurants', wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT restaurant_id FROM employee_restaurants WHERE employee_id = $1', [req.params.id]
  );
  res.json(rows.map(r => r.restaurant_id));
}));

app.get('/api/products/:id/restaurants', wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT restaurant_id FROM product_restaurants WHERE product_id = $1', [req.params.id]
  );
  res.json(rows.map(r => r.restaurant_id));
}));

// ---------- Categories (partagees entre restaurants) ----------

app.post('/api/categories', wrap(async (req, res) => {
  const { name, restaurantIds } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom requis' });
  if (!Array.isArray(restaurantIds) || !restaurantIds.length) {
    return res.status(400).json({ error: 'Au moins un restaurant requis' });
  }
  const { rows } = await pool.query(
    'INSERT INTO categories (name) VALUES ($1) RETURNING id, name',
    [name.trim()]
  );
  await pool.query(
    `INSERT INTO category_restaurants (category_id, restaurant_id)
     SELECT $1, unnest($2::int[])`,
    [rows[0].id, restaurantIds]
  );
  res.json(rows[0]);
}));

app.put('/api/categories/:id', wrap(async (req, res) => {
  const { name, restaurantIds } = req.body || {};
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'Nom requis' });
    await pool.query('UPDATE categories SET name = $1 WHERE id = $2', [name.trim(), req.params.id]);
  }
  if (Array.isArray(restaurantIds)) {
    if (!restaurantIds.length) return res.status(400).json({ error: 'Au moins un restaurant requis' });
    await pool.query('DELETE FROM category_restaurants WHERE category_id = $1', [req.params.id]);
    await pool.query(
      `INSERT INTO category_restaurants (category_id, restaurant_id)
       SELECT $1, unnest($2::int[])`,
      [req.params.id, restaurantIds]
    );
  }
  res.json({ ok: true });
}));

app.delete('/api/categories/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM categories WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- Frigos (objets physiques : un seul restaurant, une seule zone) ----------

app.post('/api/fridges', wrap(async (req, res) => {
  const { name, restaurantId, zoneId } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom requis' });
  if (!restaurantId) return res.status(400).json({ error: 'Restaurant requis' });
  const { rows } = await pool.query(
    'INSERT INTO fridges (name, restaurant_id, zone_id) VALUES ($1, $2, $3) RETURNING id, name, zone_id',
    [name.trim(), restaurantId, zoneId || null]
  );
  res.json(rows[0]);
}));

app.put('/api/fridges/:id', wrap(async (req, res) => {
  const { name, zoneId } = req.body || {};
  const fields = [];
  const values = [];
  let i = 1;
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'Nom requis' });
    fields.push(`name = $${i++}`); values.push(name.trim());
  }
  if (zoneId !== undefined) { fields.push(`zone_id = $${i++}`); values.push(zoneId || null); }
  if (!fields.length) return res.json({ ok: true });
  values.push(req.params.id);
  await pool.query(`UPDATE fridges SET ${fields.join(', ')} WHERE id = $${i}`, values);
  res.json({ ok: true });
}));

app.delete('/api/fridges/:id', wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM product_restaurants WHERE fridge_id = $1',
    [req.params.id]
  );
  if (rows[0].n > 0) {
    return res.status(400).json({ error: `${rows[0].n} produit(s) encore range(s) dans ce frigo` });
  }
  await pool.query('DELETE FROM fridges WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- Produits (definition partagee, suivi par restaurant) ----------

app.post('/api/products', wrap(async (req, res) => {
  const { name, categoryId, fridgeId, delayDays, restaurantId, otherRestaurantIds } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom requis' });
  if (!categoryId) return res.status(400).json({ error: 'Categorie requise' });
  if (!fridgeId) return res.status(400).json({ error: 'Frigo requis' });
  if (!restaurantId) return res.status(400).json({ error: 'Restaurant requis' });

  const { rows } = await pool.query(
    `INSERT INTO products (name, category_id, delay_days)
     VALUES ($1, $2, $3) RETURNING id`,
    [name.trim(), categoryId, Math.max(1, parseInt(delayDays, 10) || 3)]
  );
  await syncProductRestaurants(rows[0].id, categoryId, restaurantId, fridgeId, otherRestaurantIds);
  res.json({ id: rows[0].id });
}));

app.put('/api/products/:id', wrap(async (req, res) => {
  const { name, categoryId, fridgeId, delayDays, restaurantId, otherRestaurantIds } = req.body || {};
  const fields = [];
  const values = [];
  let i = 1;

  if (name !== undefined)      { fields.push(`name = $${i++}`);        values.push(name.trim()); }
  if (categoryId !== undefined){ fields.push(`category_id = $${i++}`); values.push(categoryId); }
  if (delayDays !== undefined) { fields.push(`delay_days = $${i++}`);  values.push(Math.max(1, parseInt(delayDays, 10) || 1)); }

  if (fields.length) {
    values.push(req.params.id);
    await pool.query(`UPDATE products SET ${fields.join(', ')} WHERE id = $${i}`, values);
  }

  if (restaurantId && (fridgeId !== undefined || otherRestaurantIds !== undefined)) {
    let effectiveCategoryId = categoryId;
    if (effectiveCategoryId === undefined) {
      const cur = await pool.query('SELECT category_id FROM products WHERE id = $1', [req.params.id]);
      effectiveCategoryId = cur.rows[0] && cur.rows[0].category_id;
    }
    await syncProductRestaurants(req.params.id, effectiveCategoryId, restaurantId, fridgeId, otherRestaurantIds);
  }

  res.json({ ok: true });
}));

app.delete('/api/products/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- Impression d'une etiquette ----------

app.post('/api/products/:id/print', wrap(async (req, res) => {
  const { employee, restaurantId } = req.body || {};
  if (!restaurantId) return res.status(400).json({ error: 'Restaurant requis' });

  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.delay_days, f.name AS fridge_name
     FROM products p
     JOIN product_restaurants pr ON pr.product_id = p.id AND pr.restaurant_id = $2
     LEFT JOIN fridges f ON f.id = pr.fridge_id
     WHERE p.id = $1`,
    [req.params.id, restaurantId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Produit introuvable' });
  const product = rows[0];

  // La date du jour et la DLC sont calculees par le serveur : toutes les
  // tablettes partagent ainsi exactement la meme reference de date.
  const updated = await pool.query(
    `UPDATE product_restaurants
     SET last_print_date = CURRENT_DATE,
         last_dlc_date = CURRENT_DATE + ($1 || ' days')::interval,
         last_print_employee = $2
     WHERE product_id = $3 AND restaurant_id = $4
     RETURNING last_print_date, last_dlc_date`,
    [product.delay_days, employee || null, product.id, restaurantId]
  );

  await logEvent({
    type: 'print',
    restaurantId,
    productName: product.name,
    fridgeName: product.fridge_name,
    employee,
    dlcDate: updated.rows[0].last_dlc_date
  });

  res.json({
    printDate: updated.rows[0].last_print_date,
    dlcDate: updated.rows[0].last_dlc_date,
    productName: product.name,
    fridgeName: product.fridge_name,
    employee: employee || ''
  });
}));

// ---------- Traitement d'une DLC depassee ----------

app.post('/api/products/:id/treated', wrap(async (req, res) => {
  const { employee, restaurantId } = req.body || {};
  if (!restaurantId) return res.status(400).json({ error: 'Restaurant requis' });

  const { rows } = await pool.query(
    `SELECT p.id, p.name, pr.last_dlc_date, f.name AS fridge_name
     FROM products p
     JOIN product_restaurants pr ON pr.product_id = p.id AND pr.restaurant_id = $2
     LEFT JOIN fridges f ON f.id = pr.fridge_id
     WHERE p.id = $1`,
    [req.params.id, restaurantId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Produit introuvable' });
  const product = rows[0];

  await logEvent({
    type: 'treated',
    restaurantId,
    productName: product.name,
    fridgeName: product.fridge_name,
    employee,
    expiredDlc: product.last_dlc_date
  });

  await pool.query(
    `UPDATE product_restaurants
     SET last_print_date = NULL, last_dlc_date = NULL, last_print_employee = NULL
     WHERE product_id = $1 AND restaurant_id = $2`,
    [product.id, restaurantId]
  );

  res.json({ ok: true });
}));

// ---------- Historique ----------

app.get('/api/log', wrap(async (req, res) => {
  const restaurantId = requireRestaurantId(req, res);
  if (!restaurantId) return;
  const { rows } = await pool.query(
    `SELECT id, type, product_name, fridge_name, employee, dlc_date, expired_dlc, at
     FROM activity_log WHERE restaurant_id = $1 ORDER BY at DESC LIMIT 300`,
    [restaurantId]
  );
  res.json(rows);
}));

app.delete('/api/log', wrap(async (req, res) => {
  const restaurantId = requireRestaurantId(req, res);
  if (!restaurantId) return;
  await pool.query('DELETE FROM activity_log WHERE restaurant_id = $1', [restaurantId]);
  res.json({ ok: true });
}));

// ---------- Utilisateurs (partages entre restaurants) ----------

app.post('/api/employees', wrap(async (req, res) => {
  const { name, code, restaurantIds } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Prenom requis' });
  if (!/^\d{4}$/.test(code || '')) return res.status(400).json({ error: 'Le code doit faire 4 chiffres' });
  if (!Array.isArray(restaurantIds) || !restaurantIds.length) {
    return res.status(400).json({ error: 'Au moins un restaurant requis' });
  }
  const { rows } = await pool.query(
    'INSERT INTO employees (name, code) VALUES ($1, $2) RETURNING id, name, code',
    [name.trim(), code]
  );
  await pool.query(
    `INSERT INTO employee_restaurants (employee_id, restaurant_id)
     SELECT $1, unnest($2::int[])`,
    [rows[0].id, restaurantIds]
  );
  res.json(rows[0]);
}));

app.put('/api/employees/:id', wrap(async (req, res) => {
  const { name, code, restaurantIds } = req.body || {};
  if (name !== undefined || code !== undefined) {
    if (!name || !name.trim()) return res.status(400).json({ error: 'Prenom requis' });
    if (!/^\d{4}$/.test(code || '')) return res.status(400).json({ error: 'Le code doit faire 4 chiffres' });
    await pool.query('UPDATE employees SET name = $1, code = $2 WHERE id = $3',
      [name.trim(), code, req.params.id]);
  }
  if (Array.isArray(restaurantIds)) {
    if (!restaurantIds.length) return res.status(400).json({ error: 'Au moins un restaurant requis' });
    await pool.query('DELETE FROM employee_restaurants WHERE employee_id = $1', [req.params.id]);
    await pool.query(
      `INSERT INTO employee_restaurants (employee_id, restaurant_id)
       SELECT $1, unnest($2::int[])`,
      [req.params.id, restaurantIds]
    );
  }
  res.json({ ok: true });
}));

app.delete('/api/employees/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM employees WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- Demarrage ----------

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Serveur Etiquettes DLC demarre sur le port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Impossible d initialiser la base de donnees :', err);
    process.exit(1);
  });
