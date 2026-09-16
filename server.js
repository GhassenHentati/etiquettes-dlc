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

async function getAdminPassword() {
  const { rows } = await pool.query(
    `SELECT value FROM settings WHERE key = 'admin_password'`
  );
  return rows.length ? rows[0].value : '1234';
}

async function logEvent({ type, productName, fridgeName, employee, dlcDate, expiredDlc }) {
  await pool.query(
    `INSERT INTO activity_log (type, product_name, fridge_name, employee, dlc_date, expired_dlc)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [type, productName, fridgeName || null, employee || null, dlcDate || null, expiredDlc || null]
  );
}

// ---------- Etat global (une seule requete pour toute l'app) ----------

app.get('/api/state', wrap(async (req, res) => {
  const [employees, fridges, categories, products] = await Promise.all([
    pool.query('SELECT id, name, code FROM employees ORDER BY id'),
    pool.query('SELECT id, name FROM fridges ORDER BY id'),
    pool.query('SELECT id, name FROM categories ORDER BY id'),
    pool.query(`
      SELECT p.id, p.name, p.category_id, p.fridge_id, p.delay_days,
             p.last_print_date, p.last_dlc_date, p.last_print_employee
      FROM products p ORDER BY p.id
    `)
  ]);

  res.json({
    employees: employees.rows,
    fridges: fridges.rows,
    categories: categories.rows,
    products: products.rows
  });
}));

// ---------- Connexion ----------

app.post('/api/login', wrap(async (req, res) => {
  const { type, employeeId, code } = req.body || {};

  if (type === 'admin') {
    const adminPassword = await getAdminPassword();
    if (code === adminPassword) return res.json({ ok: true, user: { type: 'admin' } });
    return res.status(401).json({ ok: false });
  }

  const { rows } = await pool.query(
    'SELECT id, name FROM employees WHERE id = $1 AND code = $2',
    [employeeId, code]
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

// ---------- Categories ----------

app.post('/api/categories', wrap(async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom requis' });
  const { rows } = await pool.query(
    'INSERT INTO categories (name) VALUES ($1) RETURNING id, name',
    [name.trim()]
  );
  res.json(rows[0]);
}));

app.put('/api/categories/:id', wrap(async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom requis' });
  await pool.query('UPDATE categories SET name = $1 WHERE id = $2', [name.trim(), req.params.id]);
  res.json({ ok: true });
}));

app.delete('/api/categories/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM categories WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- Frigos ----------

app.post('/api/fridges', wrap(async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom requis' });
  const { rows } = await pool.query(
    'INSERT INTO fridges (name) VALUES ($1) RETURNING id, name',
    [name.trim()]
  );
  res.json(rows[0]);
}));

app.put('/api/fridges/:id', wrap(async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom requis' });
  await pool.query('UPDATE fridges SET name = $1 WHERE id = $2', [name.trim(), req.params.id]);
  res.json({ ok: true });
}));

app.delete('/api/fridges/:id', wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM products WHERE fridge_id = $1',
    [req.params.id]
  );
  if (rows[0].n > 0) {
    return res.status(400).json({ error: `${rows[0].n} produit(s) encore range(s) dans ce frigo` });
  }
  await pool.query('DELETE FROM fridges WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- Produits ----------

app.post('/api/products', wrap(async (req, res) => {
  const { name, categoryId, fridgeId, delayDays } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom requis' });
  if (!categoryId) return res.status(400).json({ error: 'Categorie requise' });
  if (!fridgeId) return res.status(400).json({ error: 'Frigo requis' });

  const { rows } = await pool.query(
    `INSERT INTO products (name, category_id, fridge_id, delay_days)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [name.trim(), categoryId, fridgeId, Math.max(1, parseInt(delayDays, 10) || 3)]
  );
  res.json({ id: rows[0].id });
}));

app.put('/api/products/:id', wrap(async (req, res) => {
  const { name, categoryId, fridgeId, delayDays } = req.body || {};
  const fields = [];
  const values = [];
  let i = 1;

  if (name !== undefined)      { fields.push(`name = $${i++}`);        values.push(name.trim()); }
  if (categoryId !== undefined){ fields.push(`category_id = $${i++}`); values.push(categoryId); }
  if (fridgeId !== undefined)  { fields.push(`fridge_id = $${i++}`);   values.push(fridgeId); }
  if (delayDays !== undefined) { fields.push(`delay_days = $${i++}`);  values.push(Math.max(1, parseInt(delayDays, 10) || 1)); }

  if (!fields.length) return res.json({ ok: true });

  values.push(req.params.id);
  await pool.query(`UPDATE products SET ${fields.join(', ')} WHERE id = $${i}`, values);
  res.json({ ok: true });
}));

app.delete('/api/products/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- Impression d'une etiquette ----------

app.post('/api/products/:id/print', wrap(async (req, res) => {
  const { employee } = req.body || {};

  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.delay_days, f.name AS fridge_name
     FROM products p LEFT JOIN fridges f ON f.id = p.fridge_id
     WHERE p.id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Produit introuvable' });
  const product = rows[0];

  // La date du jour et la DLC sont calculees par le serveur : toutes les
  // tablettes partagent ainsi exactement la meme reference de date.
  const updated = await pool.query(
    `UPDATE products
     SET last_print_date = CURRENT_DATE,
         last_dlc_date = CURRENT_DATE + ($1 || ' days')::interval,
         last_print_employee = $2
     WHERE id = $3
     RETURNING last_print_date, last_dlc_date`,
    [product.delay_days, employee || null, product.id]
  );

  await logEvent({
    type: 'print',
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
  const { employee } = req.body || {};

  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.last_dlc_date, f.name AS fridge_name
     FROM products p LEFT JOIN fridges f ON f.id = p.fridge_id
     WHERE p.id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Produit introuvable' });
  const product = rows[0];

  await logEvent({
    type: 'treated',
    productName: product.name,
    fridgeName: product.fridge_name,
    employee,
    expiredDlc: product.last_dlc_date
  });

  await pool.query(
    `UPDATE products
     SET last_print_date = NULL, last_dlc_date = NULL, last_print_employee = NULL
     WHERE id = $1`,
    [product.id]
  );

  res.json({ ok: true });
}));

// ---------- Historique ----------

app.get('/api/log', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, type, product_name, fridge_name, employee, dlc_date, expired_dlc, at
     FROM activity_log ORDER BY at DESC LIMIT 300`
  );
  res.json(rows);
}));

app.delete('/api/log', wrap(async (req, res) => {
  await pool.query('DELETE FROM activity_log');
  res.json({ ok: true });
}));

// ---------- Utilisateurs ----------

app.post('/api/employees', wrap(async (req, res) => {
  const { name, code } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Prenom requis' });
  if (!/^\d{4}$/.test(code || '')) return res.status(400).json({ error: 'Le code doit faire 4 chiffres' });
  const { rows } = await pool.query(
    'INSERT INTO employees (name, code) VALUES ($1, $2) RETURNING id, name, code',
    [name.trim(), code]
  );
  res.json(rows[0]);
}));

app.put('/api/employees/:id', wrap(async (req, res) => {
  const { name, code } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Prenom requis' });
  if (!/^\d{4}$/.test(code || '')) return res.status(400).json({ error: 'Le code doit faire 4 chiffres' });
  await pool.query('UPDATE employees SET name = $1, code = $2 WHERE id = $3',
    [name.trim(), code, req.params.id]);
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
