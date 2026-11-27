import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const catalogSeed = [
  ['classic-matcha','Classic Matcha','01_Classic_Matcha.jpg','The original WHISKO cup: clean, creamy matcha with a fresh finish.',9500],
  ['strawberry-matcha','Strawberry Matcha','02_Strawberry_Matcha.jpg','Sweet strawberry meets earthy matcha in a bright, layered favorite.',11500],
  ['mango-matcha','Mango Matcha','03_Mango_Matcha.jpg','Juicy mango and smooth matcha, made for a little sunshine.',11500],
  ['vanilla-matcha','Vanilla Matcha','04_Vanilla_Matcha.jpg','A soft vanilla note rounds out our freshly whisked matcha.',10500],
  ['caramel-matcha','Caramel Matcha','05_Caramel_Matcha.jpg','Toasty caramel folded into cool, vibrant matcha.',10500],
  ['blueberry-matcha','Blueberry Matcha','06_Blueberry_Matcha.jpg','Juicy blueberry, creamy milk, and bright green matcha.',11500],
  ['coconut-matcha','Coconut Matcha','07_Coconut_Matcha.jpg','A mellow coconut finish with the lift of real matcha.',10500],
  ['pistachio-matcha','Pistachio Matcha','08_Pistachio_Matcha.jpg','Nutty pistachio and smooth matcha in one indulgent pour.',11500],
  ['chocolate-matcha','Chocolate Matcha','09_Chocolate_Matcha.jpg','Deep chocolate balances the gentle bitterness of matcha.',11500],
  ['raspberry-matcha','Raspberry Matcha','10_Raspberry_Matcha.jpg','A bright raspberry layer with our signature matcha.',11500],
  ['dirty-matcha','Dirty Matcha','11_Dirty_Matcha.png','A bold espresso shot layered with creamy matcha.',11500],
  ['honey-cinnamon-matcha','Honey Cinnamon Matcha','12_Honey_Cinnamon_Matcha.png','Smooth matcha with honey and warming cinnamon.',10500],
  ['salted-caramel-matcha','Salted Caramel Matcha','13_Salted_Caramel_Matcha.png','A sweet caramel swirl with a delicate touch of salt.',10500],
  ['sea-salted-vanilla-matcha','Sea Salted Vanilla Matcha','14_Sea_Salted_Vanilla_Matcha.png','Creamy vanilla matcha finished with a hint of sea salt.',10500],
  ['spanish-matcha','Spanish Matcha','15_Spanish_Matcha.png','A rich, creamy Spanish style matcha layered over ice.',11500],
];

const schema = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS admins (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    description TEXT NOT NULL, image_url TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
    price_piasters INTEGER CHECK (price_piasters IS NULL OR price_piasters >= 0),
    stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
    unlimited_stock INTEGER NOT NULL DEFAULT 0 CHECK (unlimited_stock IN (0,1)),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
    low_stock_threshold INTEGER NOT NULL DEFAULT 5 CHECK (low_stock_threshold >= 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS product_images (
    id TEXT PRIMARY KEY, mime_type TEXT NOT NULL, image_data BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, confirmation_token_hash TEXT NOT NULL,
    customer_name TEXT NOT NULL, customer_phone TEXT NOT NULL, delivery_address TEXT NOT NULL,
    payment_method TEXT NOT NULL CHECK(payment_method = 'cash_on_delivery'),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','preparing','out_for_delivery','completed','cancelled')),
    subtotal_piasters INTEGER NOT NULL CHECK(subtotal_piasters >= 0),
    stock_released INTEGER NOT NULL DEFAULT 0 CHECK(stock_released IN (0,1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS order_items (
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
    product_name TEXT NOT NULL, image_url TEXT NOT NULL,
    unit_price_piasters INTEGER NOT NULL CHECK(unit_price_piasters >= 0),
    quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 20),
    options_json TEXT NOT NULL, line_total_piasters INTEGER NOT NULL CHECK(line_total_piasters >= 0)
  );
  CREATE INDEX IF NOT EXISTS idx_products_active ON products(active, slug);
  CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
`;

export async function createDatabase(input = './data/whisko.sqlite') {
  const options = typeof input === 'string' ? { filename: input } : input;
  if (!options || typeof options !== 'object') throw new TypeError('Database options are required.');

  const isRemote = options.url && !options.url.startsWith('file:');
  const client = isRemote
    ? (await import('@tursodatabase/serverless/compat')).createClient({ url: options.url, authToken: options.authToken })
    : (await import('@libsql/client')).createClient({ url: options.url || pathToFileURL(path.resolve(options.filename || './data/whisko.sqlite')).href });

  try {
    await client.executeMultiple(schema);
    const productColumns = await client.execute('PRAGMA table_info(products)');
    if (!productColumns.rows.some(column => column.name === 'unlimited_stock')) {
      await client.execute('ALTER TABLE products ADD COLUMN unlimited_stock INTEGER NOT NULL DEFAULT 0 CHECK (unlimited_stock IN (0,1))');
    }
  } catch (error) {
    client.close();
    throw error;
  }

  const tx = await client.transaction('write');
  try {
    const result = await tx.execute('SELECT COUNT(*) AS n FROM products');
    if (Number(result.rows[0].n) === 0) {
      for (const [position, [slug, name, image, description, price]] of catalogSeed.entries()) {
        await tx.execute({
          sql: `INSERT INTO products(id,slug,name,description,image_url,position,price_piasters,stock,unlimited_stock,active)
            VALUES(?,?,?,?,?,?,?,0,1,1)`,
          args: [crypto.randomUUID(), slug, name, description, `/products/${image}`, position, price],
        });
      }
    }
    // Bring existing installations up to date without overwriting prices set by the owner.
    for (const [position, [slug, name, image, description, price]] of catalogSeed.entries()) {
      const existing = await tx.execute({ sql: 'SELECT id,price_piasters FROM products WHERE slug=?', args: [slug] });
      if (existing.rows.length) {
        if (existing.rows[0].price_piasters == null) {
          await tx.execute({ sql: 'UPDATE products SET price_piasters=?,updated_at=strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE id=?', args: [price, existing.rows[0].id] });
        }
        await tx.execute({ sql: 'UPDATE products SET stock=0,unlimited_stock=1,updated_at=strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE id=?', args: [existing.rows[0].id] });
      } else {
        await tx.execute({
          sql: `INSERT INTO products(id,slug,name,description,image_url,position,price_piasters,stock,unlimited_stock,active)
            VALUES(?,?,?,?,?,?,?,0,1,1)`,
          args: [crypto.randomUUID(), slug, name, description, `/products/${image}`, position, price],
        });
      }
    }
    await tx.commit();
  } catch (error) {
    if (!tx.closed) await tx.rollback();
    client.close();
    throw error;
  }
  return client;
}
