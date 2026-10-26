const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const PROJECT_ROOT = path.resolve(__dirname, '..');

const USERS_DDL = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`;

// `orders` as older releases created it. database.js only runs CREATE TABLE IF NOT EXISTS,
// so a database like this one can only be brought up to date by the migrations.
const LEGACY_ORDERS = {
  'a release before shipping fees and ECPay': {
    ddl: `
      CREATE TABLE orders (
        id TEXT PRIMARY KEY,
        order_no TEXT UNIQUE NOT NULL,
        user_id TEXT NOT NULL,
        recipient_name TEXT NOT NULL,
        recipient_email TEXT NOT NULL,
        recipient_address TEXT NOT NULL,
        total_amount INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'paid', 'failed')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`,
    insert: `
      INSERT INTO orders (id, order_no, user_id, recipient_name, recipient_email, recipient_address, total_amount)
      VALUES ('legacy-order', 'ORD-20260101-AAAAA', 'legacy-user', '舊訂單', 'old@example.com', '舊地址', 1280)`,
    expected: { subtotal: 1280, shipping_fee: 0, total_amount: 1280 },
  },
  'the release before coupons': {
    ddl: `
      CREATE TABLE orders (
        id TEXT PRIMARY KEY,
        order_no TEXT UNIQUE NOT NULL,
        user_id TEXT NOT NULL,
        recipient_name TEXT NOT NULL,
        recipient_email TEXT NOT NULL,
        recipient_address TEXT NOT NULL,
        subtotal INTEGER NOT NULL,
        shipping_fee INTEGER NOT NULL DEFAULT 0,
        shipping_method TEXT NOT NULL DEFAULT 'home_delivery',
        is_remote_area INTEGER NOT NULL DEFAULT 0,
        is_express INTEGER NOT NULL DEFAULT 0,
        total_amount INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'paid', 'failed')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        merchant_trade_no TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`,
    insert: `
      INSERT INTO orders (id, order_no, user_id, recipient_name, recipient_email, recipient_address,
                          subtotal, shipping_fee, total_amount, merchant_trade_no)
      VALUES ('legacy-order', 'ORD-20260101-AAAAA', 'legacy-user', '舊訂單', 'old@example.com', '舊地址',
              1000, 120, 1120, 'ORD20260101AAAAA')`,
    expected: { subtotal: 1000, shipping_fee: 120, total_amount: 1120 },
  },
};

// Opens the database the way the server does and reports what the migrations left behind
const CHILD_SCRIPT = `
  const db = require(process.env.PROJECT_ROOT + '/src/database');
  const rows = (sql) => db.prepare(sql).all();
  console.log(JSON.stringify({
    columns: rows('PRAGMA table_info(orders)').map(c => ({ name: c.name, notnull: c.notnull, dflt: c.dflt_value })),
    orders: rows('SELECT id, subtotal, shipping_fee, discount, coupon_code, total_amount FROM orders'),
    indexes: rows('PRAGMA index_list(orders)').map(i => i.name)
  }));
`;

describe.each(Object.entries(LEGACY_ORDERS))('upgrading a database from %s', (_label, legacy) => {
  let tmpDir;
  let dbPath;

  // A separate process, because src/database.js opens its database as soon as it is required
  function openWithCurrentCode() {
    const stdout = execFileSync(process.execPath, ['-e', CHILD_SCRIPT], {
      env: { ...process.env, DATABASE_PATH: dbPath, PROJECT_ROOT, NODE_ENV: 'test' },
      encoding: 'utf8',
    });
    return JSON.parse(stdout.trim().split('\n').pop());
  }

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flower-migration-'));
    dbPath = path.join(tmpDir, 'legacy.sqlite');

    const legacyDb = new Database(dbPath);
    legacyDb.exec(USERS_DDL);
    legacyDb.exec(legacy.ddl);
    legacyDb
      .prepare("INSERT INTO users (id, email, password_hash, name) VALUES ('legacy-user', 'legacy@example.com', 'x', '舊會員')")
      .run();
    legacyDb.exec(legacy.insert);
    legacyDb.close();
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds the discount and coupon_code columns', () => {
    const { columns } = openWithCurrentCode();
    const byName = Object.fromEntries(columns.map(column => [column.name, column]));

    expect(byName.discount).toMatchObject({ notnull: 1, dflt: '0' });
    expect(byName.coupon_code).toMatchObject({ notnull: 0 });
  });

  it('keeps the existing order unchanged, with no discount and no coupon', () => {
    const { orders } = openWithCurrentCode();

    expect(orders).toEqual([
      { id: 'legacy-order', discount: 0, coupon_code: null, ...legacy.expected },
    ]);
  });

  it('creates the lookup indexes', () => {
    const { indexes } = openWithCurrentCode();

    expect(indexes).toEqual(expect.arrayContaining(['idx_orders_user_created', 'idx_orders_status_created']));
  });

  it('can be opened again without errors or changes', () => {
    const first = openWithCurrentCode();
    const second = openWithCurrentCode();

    expect(second).toEqual(first);
  });
});
