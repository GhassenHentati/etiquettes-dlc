const { Pool } = require('pg');

// Sur Render, DATABASE_URL est fourni automatiquement par la base PostgreSQL.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

// Cree les tables au premier demarrage si elles n'existent pas encore.
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS fridges (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      fridge_id INTEGER REFERENCES fridges(id) ON DELETE SET NULL,
      delay_days INTEGER NOT NULL DEFAULT 3,
      last_print_date DATE,
      last_dlc_date DATE,
      last_print_employee TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      product_name TEXT NOT NULL,
      fridge_name TEXT,
      employee TEXT,
      dlc_date DATE,
      expired_dlc DATE,
      at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Mot de passe administrateur par defaut au tout premier lancement.
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('admin_password', '1234')
     ON CONFLICT (key) DO NOTHING`
  );

  // Jeu de donnees de depart, uniquement si la base est vide.
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM categories');
  if (rows[0].n === 0) {
    await seedInitialData();
  }
}

async function seedInitialData() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO employees (name, code) VALUES ('Sam', '1111')`
    );

    const fridgeIds = [];
    for (const name of ['Frigo 1', 'Frigo 2', 'Frigo 3', 'Frigo 4']) {
      const r = await client.query(
        'INSERT INTO fridges (name) VALUES ($1) RETURNING id',
        [name]
      );
      fridgeIds.push(r.rows[0].id);
    }

    const catIds = {};
    for (const name of ['Viandes', 'Legumes', 'Fromages']) {
      const r = await client.query(
        'INSERT INTO categories (name) VALUES ($1) RETURNING id',
        [name]
      );
      catIds[name] = r.rows[0].id;
    }

    await client.query(
      `INSERT INTO products (name, category_id, fridge_id, delay_days)
       VALUES ($1, $2, $3, $4), ($5, $6, $7, $8), ($9, $10, $11, $12)`,
      [
        'Poulet cuit', catIds['Viandes'], fridgeIds[1], 3,
        'Boeuf hache', catIds['Viandes'], fridgeIds[0], 2,
        'Jambon blanc', catIds['Viandes'], fridgeIds[1], 5
      ]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, initDb };
