const path = require("path");
const Database = require("better-sqlite3");

const dbPath = path.join(__dirname, "..", "data", "windi_menu.db");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      whatsapp TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'COMMERCE',
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS businesses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      business_name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      logo_url TEXT,
      cover_url TEXT,
      whatsapp TEXT NOT NULL,
      address TEXT,
      hours TEXT,
      instagram TEXT,
      payment_methods TEXT,
      primary_color TEXT,
      shipping_fee REAL NOT NULL DEFAULT 0,
      delivery_enabled INTEGER NOT NULL DEFAULT 1,
      pickup_enabled INTEGER NOT NULL DEFAULT 1,
      minimum_order_amount REAL,
      free_delivery_over_amount REAL,
      payment_cash_enabled INTEGER NOT NULL DEFAULT 1,
      payment_transfer_enabled INTEGER NOT NULL DEFAULT 1,
      payment_card_enabled INTEGER NOT NULL DEFAULT 1,
      transfer_instructions TEXT,
      transfer_alias TEXT,
      transfer_cvu TEXT,
      transfer_account_holder TEXT,
      cash_allow_change INTEGER NOT NULL DEFAULT 1,
      is_temporarily_closed INTEGER NOT NULL DEFAULT 0,
      temporary_closed_message TEXT,
      timezone TEXT NOT NULL DEFAULT 'America/Argentina/Ushuaia',
      affiliate_id INTEGER,
      referred_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (affiliate_id) REFERENCES affiliates(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS affiliates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      ref_code TEXT NOT NULL UNIQUE,
      commission_rate REAL NOT NULL DEFAULT 0.25,
      points_confirmed INTEGER NOT NULL DEFAULT 0,
      points_debt INTEGER NOT NULL DEFAULT 0,
      total_commission_earned REAL NOT NULL DEFAULT 0,
      total_commission_paid REAL NOT NULL DEFAULT 0,
      negative_balance REAL NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS delivery_zones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      minimum_order_amount REAL,
      free_delivery_over_amount REAL,
      estimated_time_min INTEGER,
      estimated_time_max INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS business_hours (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL,
      day_of_week INTEGER NOT NULL,
      is_open INTEGER NOT NULL DEFAULT 0,
      open_time TEXT,
      close_time TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
      UNIQUE (business_id, day_of_week)
    );

    CREATE TABLE IF NOT EXISTS plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL,
      plan_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      paid_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
      FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS affiliate_payouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      affiliate_id INTEGER NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      amount_paid REAL NOT NULL DEFAULT 0,
      method TEXT,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (affiliate_id) REFERENCES affiliates(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS affiliate_sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      affiliate_id INTEGER NOT NULL,
      business_id INTEGER NOT NULL,
      subscription_id INTEGER,
      plan_id INTEGER,
      amount REAL NOT NULL,
      commission_rate REAL NOT NULL DEFAULT 0.25,
      commission_amount REAL NOT NULL DEFAULT 0,
      points_earned INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'PENDING',
      review_note TEXT,
      reviewed_at TEXT,
      reviewed_by_admin_id INTEGER,
      reverse_note TEXT,
      reversed_at TEXT,
      payout_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      paid_at TEXT,
      FOREIGN KEY (affiliate_id) REFERENCES affiliates(id) ON DELETE CASCADE,
      FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
      FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE SET NULL,
      FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE SET NULL,
      FOREIGN KEY (reviewed_by_admin_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (payout_id) REFERENCES affiliate_payouts(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL,
      category_id INTEGER,
      name TEXT NOT NULL,
      description TEXT,
      price REAL NOT NULL DEFAULT 0,
      previous_price REAL,
      image_url TEXT,
      is_featured INTEGER NOT NULL DEFAULT 0,
      is_sold_out INTEGER NOT NULL DEFAULT 0,
      is_visible INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_business_slug ON businesses(slug);
    CREATE INDEX IF NOT EXISTS idx_categories_business_id ON categories(business_id);
    CREATE INDEX IF NOT EXISTS idx_products_business_id ON products(business_id);
    CREATE INDEX IF NOT EXISTS idx_products_category_id ON products(category_id);
    CREATE INDEX IF NOT EXISTS idx_delivery_zones_business_id ON delivery_zones(business_id);
    CREATE INDEX IF NOT EXISTS idx_business_hours_business_id ON business_hours(business_id);
    CREATE INDEX IF NOT EXISTS idx_affiliate_sales_affiliate_id ON affiliate_sales(affiliate_id);
    CREATE INDEX IF NOT EXISTS idx_affiliate_sales_status ON affiliate_sales(status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_affiliate_sales_subscription_unique ON affiliate_sales(subscription_id);
  `);

  const businessColumns = db.prepare("PRAGMA table_info(businesses)").all();
  const userColumns = db.prepare("PRAGMA table_info(users)").all();
  const hasUserRole = userColumns.some((column) => column.name === "role");
  if (!hasUserRole) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'COMMERCE';");
  }
  db.exec("UPDATE users SET role = 'COMMERCE' WHERE role IS NULL OR TRIM(role) = '';");
  const hasShippingFee = businessColumns.some((column) => column.name === "shipping_fee");
  if (!hasShippingFee) {
    db.exec("ALTER TABLE businesses ADD COLUMN shipping_fee REAL NOT NULL DEFAULT 0;");
  }
  const hasCashEnabled = businessColumns.some((column) => column.name === "payment_cash_enabled");
  if (!hasCashEnabled) {
    db.exec("ALTER TABLE businesses ADD COLUMN payment_cash_enabled INTEGER NOT NULL DEFAULT 1;");
  }
  const hasTransferEnabled = businessColumns.some((column) => column.name === "payment_transfer_enabled");
  if (!hasTransferEnabled) {
    db.exec("ALTER TABLE businesses ADD COLUMN payment_transfer_enabled INTEGER NOT NULL DEFAULT 1;");
  }
  const hasCardEnabled = businessColumns.some((column) => column.name === "payment_card_enabled");
  if (!hasCardEnabled) {
    db.exec("ALTER TABLE businesses ADD COLUMN payment_card_enabled INTEGER NOT NULL DEFAULT 1;");
  }
  const hasTransferInstructions = businessColumns.some((column) => column.name === "transfer_instructions");
  if (!hasTransferInstructions) {
    db.exec("ALTER TABLE businesses ADD COLUMN transfer_instructions TEXT;");
  }
  const businessColumnMigrations = [
    ["delivery_enabled", "ALTER TABLE businesses ADD COLUMN delivery_enabled INTEGER NOT NULL DEFAULT 1;"],
    ["pickup_enabled", "ALTER TABLE businesses ADD COLUMN pickup_enabled INTEGER NOT NULL DEFAULT 1;"],
    ["minimum_order_amount", "ALTER TABLE businesses ADD COLUMN minimum_order_amount REAL;"],
    ["free_delivery_over_amount", "ALTER TABLE businesses ADD COLUMN free_delivery_over_amount REAL;"],
    ["transfer_alias", "ALTER TABLE businesses ADD COLUMN transfer_alias TEXT;"],
    ["transfer_cvu", "ALTER TABLE businesses ADD COLUMN transfer_cvu TEXT;"],
    ["transfer_account_holder", "ALTER TABLE businesses ADD COLUMN transfer_account_holder TEXT;"],
    ["cash_allow_change", "ALTER TABLE businesses ADD COLUMN cash_allow_change INTEGER NOT NULL DEFAULT 1;"],
    ["is_temporarily_closed", "ALTER TABLE businesses ADD COLUMN is_temporarily_closed INTEGER NOT NULL DEFAULT 0;"],
    ["temporary_closed_message", "ALTER TABLE businesses ADD COLUMN temporary_closed_message TEXT;"],
    ["timezone", "ALTER TABLE businesses ADD COLUMN timezone TEXT NOT NULL DEFAULT 'America/Argentina/Ushuaia';"],
    ["affiliate_id", "ALTER TABLE businesses ADD COLUMN affiliate_id INTEGER;"],
    ["referred_at", "ALTER TABLE businesses ADD COLUMN referred_at TEXT;"],
  ];
  for (const [name, sql] of businessColumnMigrations) {
    if (!businessColumns.some((column) => column.name === name)) {
      db.exec(sql);
    }
  }

  const zoneColumns = db.prepare("PRAGMA table_info(delivery_zones)").all();
  const zoneMigrations = [
    ["minimum_order_amount", "ALTER TABLE delivery_zones ADD COLUMN minimum_order_amount REAL;"],
    ["free_delivery_over_amount", "ALTER TABLE delivery_zones ADD COLUMN free_delivery_over_amount REAL;"],
    ["estimated_time_min", "ALTER TABLE delivery_zones ADD COLUMN estimated_time_min INTEGER;"],
    ["estimated_time_max", "ALTER TABLE delivery_zones ADD COLUMN estimated_time_max INTEGER;"],
  ];
  for (const [name, sql] of zoneMigrations) {
    if (!zoneColumns.some((column) => column.name === name)) {
      db.exec(sql);
    }
  }

  const affiliateColumns = db.prepare("PRAGMA table_info(affiliates)").all();
  if (affiliateColumns.length > 0) {
    const affiliateMigrations = [
      ["points_confirmed", "ALTER TABLE affiliates ADD COLUMN points_confirmed INTEGER NOT NULL DEFAULT 0;"],
      ["points_debt", "ALTER TABLE affiliates ADD COLUMN points_debt INTEGER NOT NULL DEFAULT 0;"],
      ["negative_balance", "ALTER TABLE affiliates ADD COLUMN negative_balance REAL NOT NULL DEFAULT 0;"],
    ];
    for (const [name, sql] of affiliateMigrations) {
      if (!affiliateColumns.some((column) => column.name === name)) {
        db.exec(sql);
      }
    }
  }
}

module.exports = {
  db,
  initDb,
};
