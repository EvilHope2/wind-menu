const bcrypt = require("bcryptjs");
const { db, initDb } = require("./db");
const { slugify, uniqueSlug } = require("./utils/slug");

function findUserByEmail(email) {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email);
}

function ensureUser({ fullName, email, whatsapp, password, role }) {
  const existing = findUserByEmail(email);
  if (existing) {
    if (existing.role !== role) {
      db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, existing.id);
    }
    return db.prepare("SELECT * FROM users WHERE id = ?").get(existing.id);
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const result = db
    .prepare(
      "INSERT INTO users (full_name, email, whatsapp, role, password_hash) VALUES (?, ?, ?, ?, ?)"
    )
    .run(fullName, email, whatsapp, role, passwordHash);

  return db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid);
}

function ensureAffiliate(userId, refCode) {
  const existing = db.prepare("SELECT * FROM affiliates WHERE user_id = ?").get(userId);
  if (existing) return existing;
  const result = db
    .prepare(
      `INSERT INTO affiliates
       (user_id, ref_code, commission_rate, points_confirmed, total_commission_earned, total_commission_paid, is_active)
       VALUES (?, ?, 0.25, 0, 0, 0, 1)`
    )
    .run(userId, refCode);
  return db.prepare("SELECT * FROM affiliates WHERE id = ?").get(result.lastInsertRowid);
}

function ensurePlan({ code, displayName, priceArs, maxProducts }) {
  const existing = db.prepare("SELECT * FROM plans WHERE code = ?").get(code);
  if (existing) {
    db.prepare(
      `UPDATE plans
       SET display_name = ?, name = ?, price = ?, price_ars = ?, currency = 'ARS', max_products = ?, is_active = 1
       WHERE id = ?`
    ).run(displayName, displayName, priceArs, priceArs, maxProducts ?? null, existing.id);
    return db.prepare("SELECT * FROM plans WHERE id = ?").get(existing.id);
  }
  const result = db
    .prepare(
      `INSERT INTO plans
       (code, display_name, name, price, price_ars, currency, max_products, is_active)
       VALUES (?, ?, ?, ?, ?, 'ARS', ?, 1)`
    )
    .run(code, displayName, displayName, priceArs, priceArs, maxProducts ?? null);
  return db.prepare("SELECT * FROM plans WHERE id = ?").get(result.lastInsertRowid);
}

function ensureBusinessForUser(userId, affiliateId) {
  const existing = db.prepare("SELECT * FROM businesses WHERE user_id = ?").get(userId);
  if (existing) return existing;

  const baseSlug = slugify("pizzeria9420");
  const slug = uniqueSlug(baseSlug, (candidate) =>
    Boolean(db.prepare("SELECT 1 FROM businesses WHERE slug = ?").get(candidate))
  );

  const result = db
    .prepare(
      `INSERT INTO businesses
      (user_id, business_name, slug, whatsapp, address, hours, instagram, payment_methods, primary_color,
       shipping_fee, delivery_enabled, pickup_enabled, minimum_order_amount, free_delivery_over_amount,
       payment_cash_enabled, payment_transfer_enabled, payment_card_enabled, transfer_instructions,
       transfer_alias, transfer_cvu, transfer_account_holder, cash_allow_change,
      is_temporarily_closed, temporary_closed_message, timezone, affiliate_id, referred_at, cover_url, logo_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)`
    )
    .run(
      userId,
      "Pizzeria 9420",
      slug,
      "5491122334455",
      "Av. Corrientes 1234, CABA",
      "Lun a Dom 11:00 - 23:30",
      "https://instagram.com/pizzeria9420",
      "Efectivo, Debito, Credito, Transferencia",
      "#e6582d",
      1800,
      1,
      1,
      9000,
      30000,
      1,
      1,
      1,
      "Alias: pizzeria9420.mp",
      "pizzeria9420.mp",
      "0000003100000000000000",
      "Pizzeria 9420 SRL",
      1,
      0,
      null,
      "America/Argentina/Ushuaia",
      affiliateId,
      "https://images.unsplash.com/photo-1513104890138-7c749659a591?auto=format&fit=crop&w=1200&q=80",
      "https://images.unsplash.com/photo-1594007654729-407eedc4be65?auto=format&fit=crop&w=300&q=80"
    );

  return db.prepare("SELECT * FROM businesses WHERE id = ?").get(result.lastInsertRowid);
}

function ensureBusinessHours(businessId) {
  const count = db
    .prepare("SELECT COUNT(*) AS total FROM business_hours WHERE business_id = ?")
    .get(businessId).total;
  if (count > 0) return;

  const insert = db.prepare(
    "INSERT INTO business_hours (business_id, day_of_week, is_open, open_time, close_time, updated_at) VALUES (?, ?, 1, '11:00', '23:30', CURRENT_TIMESTAMP)"
  );
  for (let day = 0; day <= 6; day += 1) {
    insert.run(businessId, day);
  }
}

function ensureMenuData(businessId) {
  const existingCategories = db
    .prepare("SELECT COUNT(*) AS total FROM categories WHERE business_id = ?")
    .get(businessId).total;
  if (existingCategories > 0) return;

  const catStmt = db.prepare("INSERT INTO categories (business_id, name, sort_order) VALUES (?, ?, ?)");
  const pizzas = catStmt.run(businessId, "Pizzas", 1).lastInsertRowid;
  const combos = catStmt.run(businessId, "Combos", 2).lastInsertRowid;
  const bebidas = catStmt.run(businessId, "Bebidas", 3).lastInsertRowid;

  const prodStmt = db.prepare(
    `INSERT INTO products
    (business_id, category_id, name, description, price, previous_price, image_url, is_featured, is_sold_out, is_visible, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  prodStmt.run(
    businessId,
    pizzas,
    "Muzzarella Clasica",
    "Salsa de tomate, mozzarella premium y aceitunas verdes.",
    8900,
    9900,
    "https://images.unsplash.com/photo-1513104890138-7c749659a591?auto=format&fit=crop&w=800&q=80",
    1,
    0,
    1,
    1
  );
  prodStmt.run(
    businessId,
    pizzas,
    "Napolitana",
    "Rodajas de tomate fresco, ajo y oregano.",
    9600,
    null,
    "https://images.unsplash.com/photo-1604382354936-07c5d9983bd3?auto=format&fit=crop&w=800&q=80",
    0,
    0,
    1,
    2
  );
  prodStmt.run(
    businessId,
    combos,
    "Combo Familiar",
    "2 pizzas grandes + 1 gaseosa 1.5L.",
    17900,
    19900,
    "https://images.unsplash.com/photo-1541745537411-b8046dc6d66c?auto=format&fit=crop&w=800&q=80",
    1,
    0,
    1,
    1
  );
  prodStmt.run(
    businessId,
    bebidas,
    "Gaseosa Cola 1.5L",
    "Bien fria.",
    3200,
    null,
    "https://images.unsplash.com/photo-1581636625402-29b2a704ef13?auto=format&fit=crop&w=800&q=80",
    0,
    1,
    1,
    1
  );

  const zoneStmt = db.prepare(
    `INSERT INTO delivery_zones
     (business_id, name, price, is_active, sort_order, minimum_order_amount, free_delivery_over_amount, estimated_time_min, estimated_time_max, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  );
  zoneStmt.run(businessId, "Centro", 2500, 1, 1, 10000, 28000, 30, 45);
  zoneStmt.run(businessId, "Zona Norte", 3200, 1, 2, null, 35000, 40, 60);
}

function ensureDemoPendingSales({ affiliateId, businessId, planId }) {
  const existing = db
    .prepare("SELECT COUNT(*) AS total FROM affiliate_sales WHERE affiliate_id = ?")
    .get(affiliateId).total;
  if (existing >= 2) return;

  const subInsert = db.prepare(
    `INSERT INTO subscriptions
     (business_id, plan_id, amount, status, current_period_start, current_period_end, paid_at, updated_at)
     VALUES (?, ?, ?, 'ACTIVE', CURRENT_TIMESTAMP, datetime('now', '+30 days'), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
  );
  const saleInsert = db.prepare(
    `INSERT INTO affiliate_sales
     (affiliate_id, business_id, subscription_id, plan_id, amount, commission_rate, commission_amount, points_earned, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', CURRENT_TIMESTAMP)`
  );

  const amounts = [12000, 18000];
  for (const amount of amounts) {
    const subId = subInsert.run(businessId, planId, amount).lastInsertRowid;
    saleInsert.run(
      affiliateId,
      businessId,
      subId,
      planId,
      amount,
      0.25,
      Math.round(amount * 0.25),
      Math.round(amount / 100)
    );
  }
}

function createSeedData() {
  initDb();

  const admin = ensureUser({
    fullName: "Admin Windi",
    email: "admin@windi.menu",
    whatsapp: "5491100000000",
    password: "admin1234",
    role: "ADMIN",
  });

  const affiliateUser = ensureUser({
    fullName: "Afiliado Demo",
    email: "affiliate@windi.menu",
    whatsapp: "5491111111111",
    password: "affiliate1234",
    role: "AFFILIATE",
  });

  const commerceUser = ensureUser({
    fullName: "Demo Pizzeria",
    email: "demo@windi.menu",
    whatsapp: "5491122334455",
    password: "demo1234",
    role: "COMMERCE",
  });

  const affiliate = ensureAffiliate(affiliateUser.id, "AFI25DEMO");
  const plan = ensurePlan({
    code: "BASIC",
    displayName: "Basico",
    priceArs: 12999,
    maxProducts: 10,
  });
  ensurePlan({
    code: "PREMIUM",
    displayName: "Premium",
    priceArs: 16999,
    maxProducts: 50,
  });
  ensurePlan({
    code: "ELITE",
    displayName: "Elite",
    priceArs: 21999,
    maxProducts: null,
  });

  const business = ensureBusinessForUser(commerceUser.id, affiliate.id);
  db.prepare(
    "UPDATE businesses SET has_completed_onboarding = 1, onboarding_step = 'done', plan_id = ? WHERE id = ?"
  ).run(plan.id, business.id);
  ensureBusinessHours(business.id);
  ensureMenuData(business.id);
  ensureDemoPendingSales({ affiliateId: affiliate.id, businessId: business.id, planId: plan.id });

  return { admin, affiliateUser, commerceUser, affiliate, business };
}

if (require.main === module) {
  const seed = createSeedData();
  console.log("Seed listo:");
  console.log("- Admin: admin@windi.menu / admin1234");
  console.log("- Afiliado: affiliate@windi.menu / affiliate1234");
  console.log("- Comercio: demo@windi.menu / demo1234");
  console.log(`- Ref code: ${seed.affiliate.ref_code}`);
}

module.exports = {
  createSeedData,
};
