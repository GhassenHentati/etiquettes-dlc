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

    CREATE TABLE IF NOT EXISTS restaurants (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS zones (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS employee_restaurants (
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      PRIMARY KEY (employee_id, restaurant_id)
    );

    -- Les frigos sont des objets physiques : un seul restaurant, une seule zone.
    CREATE TABLE IF NOT EXISTS fridges (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE fridges ADD COLUMN IF NOT EXISTS restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE;
    ALTER TABLE fridges ADD COLUMN IF NOT EXISTS zone_id INTEGER REFERENCES zones(id) ON DELETE SET NULL;

    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS category_restaurants (
      category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      PRIMARY KEY (category_id, restaurant_id)
    );

    -- Definition du produit (nom, delai). Partagee entre restaurants ; le
    -- suivi (frigo, derniere impression) vit dans product_restaurants car
    -- une etiquette est toujours imprimee dans un frigo d'un restaurant precis.
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      delay_days INTEGER NOT NULL DEFAULT 3,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS product_restaurants (
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      fridge_id INTEGER REFERENCES fridges(id) ON DELETE SET NULL,
      last_print_date DATE,
      last_dlc_date DATE,
      last_print_employee TEXT,
      PRIMARY KEY (product_id, restaurant_id)
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
      product_name TEXT NOT NULL,
      fridge_name TEXT,
      employee TEXT,
      dlc_date DATE,
      expired_dlc DATE,
      at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE;
  `);

  // Mot de passe administrateur par defaut au tout premier lancement.
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('admin_password', '1234')
     ON CONFLICT (key) DO NOTHING`
  );

  const { rows: restaurantRows } = await pool.query('SELECT COUNT(*)::int AS n FROM restaurants');
  if (restaurantRows[0].n === 0) {
    const { rows: categoryRows } = await pool.query('SELECT COUNT(*)::int AS n FROM categories');
    if (categoryRows[0].n > 0) {
      // Base existante d'avant le multi-restaurants : on regroupe tout dans
      // un premier restaurant par defaut, renommable ensuite depuis Gestion.
      await migrateExistingDataIntoDefaultRestaurant();
    } else {
      await seedInitialData();
    }
  }
}

async function migrateExistingDataIntoDefaultRestaurant() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: restRows } = await client.query(
      `INSERT INTO restaurants (name) VALUES ('Restaurant 1') RETURNING id`
    );
    const restaurantId = restRows[0].id;

    await client.query(
      `INSERT INTO category_restaurants (category_id, restaurant_id)
       SELECT id, $1 FROM categories`,
      [restaurantId]
    );
    await client.query(
      `INSERT INTO employee_restaurants (employee_id, restaurant_id)
       SELECT id, $1 FROM employees`,
      [restaurantId]
    );
    await client.query(
      `UPDATE fridges SET restaurant_id = $1 WHERE restaurant_id IS NULL`,
      [restaurantId]
    );

    // Les anciennes colonnes de suivi vivaient directement sur products ;
    // on les recupere si elles existent encore (base pas encore migree).
    const hasOldTrackingCols = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'products' AND column_name = 'fridge_id'
    `);
    if (hasOldTrackingCols.rows.length > 0) {
      await client.query(
        `INSERT INTO product_restaurants
           (product_id, restaurant_id, fridge_id, last_print_date, last_dlc_date, last_print_employee)
         SELECT id, $1, fridge_id, last_print_date, last_dlc_date, last_print_employee
         FROM products`,
        [restaurantId]
      );
    } else {
      await client.query(
        `INSERT INTO product_restaurants (product_id, restaurant_id)
         SELECT id, $1 FROM products`,
        [restaurantId]
      );
    }

    await client.query(
      `UPDATE activity_log SET restaurant_id = $1 WHERE restaurant_id IS NULL`,
      [restaurantId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function seedInitialData() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: restRows } = await client.query(
      `INSERT INTO restaurants (name) VALUES ('Restaurant 1') RETURNING id`
    );
    const restaurantId = restRows[0].id;

    const zoneIds = {};
    for (const name of ['Cuisine', 'Salle']) {
      const r = await client.query(
        'INSERT INTO zones (restaurant_id, name) VALUES ($1, $2) RETURNING id',
        [restaurantId, name]
      );
      zoneIds[name] = r.rows[0].id;
    }

    const empRow = await client.query(
      `INSERT INTO employees (name, code) VALUES ('Sam', '1111') RETURNING id`
    );
    await client.query(
      `INSERT INTO employee_restaurants (employee_id, restaurant_id) VALUES ($1, $2)`,
      [empRow.rows[0].id, restaurantId]
    );

    const fridgeIds = [];
    for (const name of ['Frigo 1', 'Frigo 2', 'Frigo 3', 'Frigo 4']) {
      const r = await client.query(
        'INSERT INTO fridges (name, restaurant_id, zone_id) VALUES ($1, $2, $3) RETURNING id',
        [name, restaurantId, zoneIds['Cuisine']]
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
      await client.query(
        `INSERT INTO category_restaurants (category_id, restaurant_id) VALUES ($1, $2)`,
        [r.rows[0].id, restaurantId]
      );
    }

    const productDefs = [
      ['Poulet cuit', catIds['Viandes'], fridgeIds[1], 3],
      ['Boeuf hache', catIds['Viandes'], fridgeIds[0], 2],
      ['Jambon blanc', catIds['Viandes'], fridgeIds[1], 5]
    ];
    for (const [name, categoryId, fridgeId, delayDays] of productDefs) {
      const p = await client.query(
        `INSERT INTO products (name, category_id, delay_days) VALUES ($1, $2, $3) RETURNING id`,
        [name, categoryId, delayDays]
      );
      await client.query(
        `INSERT INTO product_restaurants (product_id, restaurant_id, fridge_id)
         VALUES ($1, $2, $3)`,
        [p.rows[0].id, restaurantId, fridgeId]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, initDb };
