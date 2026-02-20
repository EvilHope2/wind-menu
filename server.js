require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cookieSession = require("cookie-session");
const bcrypt = require("bcryptjs");
const QRCode = require("qrcode");

const { db, initDb } = require("./src/db");
const { createSeedData } = require("./src/seed");
const { requireAuth, requireRole } = require("./src/middleware/auth");
const { upload } = require("./src/middleware/upload");
const { slugify, uniqueSlug } = require("./src/utils/slug");
const { pushSqliteToSupabase, pullSupabaseToSqlite } = require("./src/sync/bridge");
const { applySupabaseSchema } = require("./src/sync/schema");
const { LEGAL_VERSIONS, LEGAL_COMPANY } = require("./src/legal");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const IS_VERCEL = process.env.VERCEL === "1";
const HAS_SUPABASE_DB = Boolean(process.env.SUPABASE_DB_URL);
const RUNTIME_SYNC =
  process.env.SUPABASE_RUNTIME_SYNC === "1" ||
  (process.env.SUPABASE_RUNTIME_SYNC !== "0" && HAS_SUPABASE_DB);
const SUPABASE_PRIMARY = process.env.SUPABASE_PRIMARY === "1";
const MP_ACCESS_TOKEN = String(process.env.MP_ACCESS_TOKEN || "").trim();
const MP_WEBHOOK_URL =
  String(process.env.MP_WEBHOOK_URL || "").trim() || `${BASE_URL}/webhooks/mercadopago`;
const IS_SECURE_ENV = process.env.NODE_ENV === "production" || IS_VERCEL;

let pushInFlight = false;
let pushScheduled = false;
let pullInFlight = false;
const PULL_INTERVAL_MS = Number(process.env.SUPABASE_PULL_INTERVAL_MS || 30000);

async function pushMirrorNow() {
  if (!RUNTIME_SYNC || !HAS_SUPABASE_DB) return;
  if (pushInFlight) {
    pushScheduled = true;
    return;
  }
  pushInFlight = true;
  try {
    await pushSqliteToSupabase();
  } catch (error) {
    console.error("Mirror push fallo:", error.message);
  } finally {
    pushInFlight = false;
    if (pushScheduled) {
      pushScheduled = false;
      setTimeout(() => {
        pushMirrorNow();
      }, 400);
    }
  }
}

function scheduleMirrorPush() {
  if (!RUNTIME_SYNC || !HAS_SUPABASE_DB) return;
  if (pushScheduled || pushInFlight) {
    pushScheduled = true;
    return;
  }
  pushScheduled = true;
  setTimeout(async () => {
    pushScheduled = false;
    await pushMirrorNow();
  }, 700);
}

async function pullMirrorNow() {
  if (!RUNTIME_SYNC || !HAS_SUPABASE_DB) return;
  if (pullInFlight) return;
  pullInFlight = true;
  try {
    await pullSupabaseToSqlite();
  } catch (error) {
    console.error("Mirror pull fallo:", error.message);
  } finally {
    pullInFlight = false;
  }
}

initDb();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.set("trust proxy", 1);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use("/public", express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.use(
  cookieSession({
    name: "windi.sid",
    keys: [process.env.SESSION_SECRET || "windi-menu-local-secret"],
    maxAge: 1000 * 60 * 60 * 8,
    sameSite: "lax",
    secure: IS_SECURE_ENV,
  })
);

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.flash = req.session.flash || null;
  res.locals.legal = LEGAL_VERSIONS;
  res.locals.legalCompany = LEGAL_COMPANY;
  req.session.flash = null;
  next();
});

app.use((req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    res.on("finish", () => {
      if (res.statusCode < 400) scheduleMirrorPush();
    });
  }
  next();
});

if (IS_VERCEL) {
  app.use(async (_req, res, next) => {
    try {
      await bootstrap();
      return next();
    } catch (error) {
      console.error(error.message);
      return res.status(503).send("Servicio iniciando. Reintenta en unos segundos.");
    }
  });
}

app.use((req, res, next) => {
  return next();
});

app.use("/afiliados", (req, res, next) => {
  const openAuthPaths = new Set(["/login", "/registro"]);
  const currentPath = req.path || "/";
  const user = req.session?.user || null;

  if (openAuthPaths.has(currentPath)) {
    if (user?.role === "AFFILIATE" || user?.role === "ADMIN") {
      return res.redirect("/afiliados/panel");
    }
    if (user) {
      return res.status(404).render("404", {
        title: "Pagina no encontrada | Windi Menu",
        description: "No encontramos la pagina que buscas en Windi Menu.",
      });
    }
    return next();
  }

  if (!user) {
    req.session.flash = { type: "error", text: "Inicia sesion para ingresar al area de afiliados." };
    return res.redirect("/afiliados/login");
  }

  if (!["AFFILIATE", "ADMIN"].includes(user.role)) {
    return res.status(404).render("404", {
      title: "Pagina no encontrada | Windi Menu",
      description: "No encontramos la pagina que buscas en Windi Menu.",
    });
  }

  return next();
});

function flashAndRedirect(req, res, type, text, to) {
  req.session.flash = { type, text };
  return res.redirect(to);
}

async function withTimeout(promise, ms) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function renderBusinessProvisioning(res) {
  return res.status(503).send(`
    <!doctype html>
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Estamos preparando tu cuenta</title>
        <style>
          body{font-family:Inter,Arial,sans-serif;background:#f8fafc;padding:24px;color:#0f172a}
          .card{max-width:560px;margin:48px auto;background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:20px}
          a{display:inline-block;margin-right:12px;margin-top:12px}
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Estamos preparando tu comercio</h1>
          <p>Tu cuenta existe, pero todavia se esta sincronizando. Reintenta en unos segundos.</p>
          <a href="/onboarding/plan">Reintentar</a>
          <a href="/logout">Cerrar sesion</a>
        </div>
      </body>
    </html>
  `);
}

function parseCookies(req) {
  const cookieHeader = req.headers.cookie || "";
  const pairs = cookieHeader.split(";").map((part) => part.trim()).filter(Boolean);
  const cookies = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = decodeURIComponent(pair.slice(0, eq));
    const value = decodeURIComponent(pair.slice(eq + 1));
    cookies[key] = value;
  }
  return cookies;
}

function setCookie(res, name, value, maxAgeSeconds) {
  const encoded = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
  const attrs = [
    encoded,
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "SameSite=Lax",
    "HttpOnly",
  ];
  res.append("Set-Cookie", attrs.join("; "));
}

function clearCookie(res, name) {
  res.append("Set-Cookie", `${encodeURIComponent(name)}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`);
}

function currentLegalVersions() {
  return {
    terms: LEGAL_VERSIONS.terms.version,
    privacy: LEGAL_VERSIONS.privacy.version,
  };
}

function ensureLegalConsentsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS legal_consents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      terms_version TEXT NOT NULL,
      privacy_version TEXT NOT NULL,
      accepted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ip_address TEXT,
      user_agent TEXT,
      source TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_legal_consents_user_id ON legal_consents(user_id);
  `);
  const cols = db.prepare("PRAGMA table_info(legal_consents)").all();
  const required = [
    ["role", "ALTER TABLE legal_consents ADD COLUMN role TEXT NOT NULL DEFAULT 'COMMERCE';"],
    ["terms_version", "ALTER TABLE legal_consents ADD COLUMN terms_version TEXT NOT NULL DEFAULT '1.0.0';"],
    ["privacy_version", "ALTER TABLE legal_consents ADD COLUMN privacy_version TEXT NOT NULL DEFAULT '1.0.0';"],
    ["accepted_at", "ALTER TABLE legal_consents ADD COLUMN accepted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP;"],
    ["ip_address", "ALTER TABLE legal_consents ADD COLUMN ip_address TEXT;"],
    ["user_agent", "ALTER TABLE legal_consents ADD COLUMN user_agent TEXT;"],
    ["source", "ALTER TABLE legal_consents ADD COLUMN source TEXT;"],
    ["created_at", "ALTER TABLE legal_consents ADD COLUMN created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP;"],
  ];
  for (const [name, sql] of required) {
    if (!cols.some((c) => c.name === name)) {
      db.exec(sql);
    }
  }
}

function hasLatestLegalConsent(userId, role) {
  ensureLegalConsentsTable();
  const versions = currentLegalVersions();
  try {
    const row = db
      .prepare(
        `SELECT id
         FROM legal_consents
         WHERE user_id = ? AND role = ? AND terms_version = ? AND privacy_version = ?
         ORDER BY accepted_at DESC, id DESC
         LIMIT 1`
      )
      .get(userId, role, versions.terms, versions.privacy);
    return Boolean(row);
  } catch (error) {
    console.error("hasLatestLegalConsent fallo:", error.message);
    try {
      const fallback = db
        .prepare(
          `SELECT id
           FROM legal_consents
           WHERE user_id = ? AND role = ?
           ORDER BY id DESC
           LIMIT 1`
        )
        .get(userId, role);
      return Boolean(fallback);
    } catch (_inner) {
      return false;
    }
  }
}

function latestLegalConsentByUser(userId) {
  ensureLegalConsentsTable();
  try {
    return db
      .prepare(
        `SELECT *
         FROM legal_consents
         WHERE user_id = ?
         ORDER BY accepted_at DESC, id DESC
         LIMIT 1`
      )
      .get(userId);
  } catch (error) {
    console.error("latestLegalConsentByUser fallo:", error.message);
    return null;
  }
}

function recordLegalConsent(req, { userId, role, source }) {
  ensureLegalConsentsTable();
  const versions = currentLegalVersions();
  try {
    db.prepare(
      `INSERT INTO legal_consents
       (user_id, role, terms_version, privacy_version, accepted_at, ip_address, user_agent, source, created_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(
      userId,
      role,
      versions.terms,
      versions.privacy,
      String(req.ip || "").trim() || null,
      String(req.headers["user-agent"] || "").slice(0, 255) || null,
      source || null
    );
    return true;
  } catch (error) {
    console.error("recordLegalConsent fallo:", error.message);
    try {
      db.prepare(
        `INSERT INTO legal_consents
         (user_id, role, terms_version, privacy_version)
         VALUES (?, ?, ?, ?)`
      ).run(userId, role, versions.terms, versions.privacy);
      return true;
    } catch (fallbackError) {
      console.error("recordLegalConsent fallback fallo:", fallbackError.message);
      return false;
    }
  }
}

function getBusinessByUserId(userId) {
  return db.prepare("SELECT * FROM businesses WHERE user_id = ?").get(userId);
}

function ensureAdminAccount({ email, password, fullName }) {
  const cleanEmail = String(email || "").trim().toLowerCase();
  const rawPassword = String(password || "").trim();
  if (!cleanEmail || !rawPassword) return false;

  const existing = db.prepare("SELECT * FROM users WHERE email = ?").get(cleanEmail);
  const passwordHash = bcrypt.hashSync(rawPassword, 10);
  if (existing) {
    db.prepare(
      `UPDATE users
       SET full_name = COALESCE(NULLIF(?, ''), full_name),
           role = 'ADMIN',
           password_hash = ?
       WHERE id = ?`
    ).run(String(fullName || "").trim(), passwordHash, existing.id);
    return true;
  }

  db.prepare(
    `INSERT INTO users (full_name, email, whatsapp, role, password_hash, created_at)
     VALUES (?, ?, ?, 'ADMIN', ?, CURRENT_TIMESTAMP)`
  ).run(String(fullName || "Admin"), cleanEmail, "5491100000000", passwordHash);
  return true;
}

function ensureCommerceAccount({ email, password, fullName, whatsapp }) {
  const cleanEmail = String(email || "").trim().toLowerCase();
  const rawPassword = String(password || "").trim();
  if (!cleanEmail || !rawPassword) return false;

  const existing = db.prepare("SELECT * FROM users WHERE email = ?").get(cleanEmail);
  const passwordHash = bcrypt.hashSync(rawPassword, 10);
  if (existing) {
    db.prepare(
      `UPDATE users
       SET full_name = COALESCE(NULLIF(?, ''), full_name),
           role = 'COMMERCE',
           whatsapp = COALESCE(NULLIF(?, ''), whatsapp),
           password_hash = ?
       WHERE id = ?`
    ).run(String(fullName || "").trim(), String(whatsapp || "").trim(), passwordHash, existing.id);
    const business = ensureBusinessForUser(existing.id);
    const basicPlan = db
      .prepare("SELECT id FROM plans WHERE UPPER(COALESCE(code,'')) = 'BASIC' ORDER BY id ASC LIMIT 1")
      .get();
    if (business) {
      db.prepare(
        `UPDATE businesses
         SET has_completed_onboarding = 1,
             onboarding_step = 'done',
             plan_id = COALESCE(?, plan_id),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      ).run(basicPlan?.id || null, business.id);
    }
    return true;
  }

  const result = db
    .prepare(
      `INSERT INTO users (full_name, email, whatsapp, role, password_hash, created_at)
       VALUES (?, ?, ?, 'COMMERCE', ?, CURRENT_TIMESTAMP)`
    )
    .run(
      String(fullName || "Comercio Demo").trim() || "Comercio Demo",
      cleanEmail,
      String(whatsapp || "5491100000000").trim() || "5491100000000",
      passwordHash
    );
  const business = ensureBusinessForUser(result.lastInsertRowid);
  const basicPlan = db
    .prepare("SELECT id FROM plans WHERE UPPER(COALESCE(code,'')) = 'BASIC' ORDER BY id ASC LIMIT 1")
    .get();
  if (business) {
    db.prepare(
      `UPDATE businesses
       SET has_completed_onboarding = 1,
           onboarding_step = 'done',
           plan_id = COALESCE(?, plan_id),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(basicPlan?.id || null, business.id);
  }
  return true;
}

function ensureRuntimeAdminAccounts() {
  let changed = false;
  changed = ensureAdminAccount({
    email: process.env.ADMIN_EMAIL || "nahuel.wind@admin.com",
    password: process.env.ADMIN_PASSWORD || "13112024",
    fullName: process.env.ADMIN_FULL_NAME || "Nahuel Admin",
  }) || changed;
  changed = ensureAdminAccount({
    email: "admin@windi.menu",
    password: "admin1234",
    fullName: "Admin Windi",
  }) || changed;
  return changed;
}

function ensureRuntimeCommerceAccounts() {
  let changed = false;
  changed = ensureCommerceAccount({
    email: process.env.DEMO_COMMERCE_EMAIL || "p4@gmail.com",
    password: process.env.DEMO_COMMERCE_PASSWORD || "123456",
    fullName: process.env.DEMO_COMMERCE_NAME || "Comercio Prueba",
    whatsapp: process.env.DEMO_COMMERCE_WHATSAPP || "5491100000000",
  }) || changed;
  return changed;
}

function ensureBusinessForUser(userId) {
  let business = getBusinessByUserId(userId);
  if (business) return business;

  const user = db.prepare("SELECT id, full_name, email, whatsapp FROM users WHERE id = ?").get(userId);
  if (!user) return null;

  const rawBase =
    slugify(String(user.email || "").split("@")[0]) ||
    slugify(String(user.full_name || "")) ||
    `comercio-${user.id}`;
  const slug = uniqueSlug(rawBase, (candidate) =>
    Boolean(db.prepare("SELECT 1 FROM businesses WHERE slug = ?").get(candidate))
  );

  const result = db
    .prepare(
      `INSERT INTO businesses
       (user_id, business_name, slug, whatsapp, has_completed_onboarding, onboarding_step, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 'welcome', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run(
      user.id,
      String(user.full_name || "Mi comercio").trim() || "Mi comercio",
      slug,
      String(user.whatsapp || "").trim() || "5491100000000"
    );

  business = db.prepare("SELECT * FROM businesses WHERE id = ?").get(result.lastInsertRowid);
  scheduleMirrorPush();
  return business;
}

async function resolveBusinessForUser(userId, { waitForPull = false } = {}) {
  let business = getBusinessByUserId(userId);
  if (business) return business;
  if (RUNTIME_SYNC && HAS_SUPABASE_DB) {
    if (waitForPull) {
      try {
        await withTimeout(pullMirrorNow(), 2500);
      } catch (_error) {
        // Ignore timeout/network issues and fallback to current local state.
      }
    } else {
      pullMirrorNow();
    }
    business = getBusinessByUserId(userId);
  }
  if (!business) {
    business = ensureBusinessForUser(userId);
  }
  return business || null;
}

function findAffiliateByRefCode(refCode) {
  return db
    .prepare(
      `SELECT a.*, u.email AS user_email, u.full_name AS user_name
       FROM affiliates a
       JOIN users u ON u.id = a.user_id
       WHERE a.ref_code = ? AND a.is_active = 1`
    )
    .get(refCode);
}

function affiliateProfileByUserId(userId) {
  return db
    .prepare(
      `SELECT a.*, u.full_name, u.email, u.whatsapp
       FROM affiliates a
       JOIN users u ON u.id = a.user_id
       WHERE a.user_id = ?`
    )
    .get(userId);
}

function generateAffiliateRefCode(seedText = "") {
  const seed = String(seedText || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
  for (let i = 0; i < 12; i += 1) {
    const random = crypto.randomBytes(3).toString("hex").toUpperCase();
    const candidate = `${seed || "AFI"}${random}`;
    const exists = db.prepare("SELECT 1 FROM affiliates WHERE ref_code = ?").get(candidate);
    if (!exists) return candidate;
  }
  const fallback = `AFI${Date.now().toString(36).toUpperCase()}`;
  const conflict = db.prepare("SELECT 1 FROM affiliates WHERE ref_code = ?").get(fallback);
  return conflict ? `${fallback}${Math.floor(Math.random() * 1000)}` : fallback;
}

function resolveAffiliateUserIdForRequest(req) {
  if (req.session?.user?.role !== "ADMIN") return req.session?.user?.id || null;
  const requested = Number(req.query.user_id || 0);
  if (requested > 0) return requested;
  const first = db.prepare("SELECT user_id FROM affiliates ORDER BY id ASC LIMIT 1").get();
  return first?.user_id || null;
}

function getActiveDeliveryZones(businessId) {
  return db
    .prepare(
      `SELECT id, name, price, sort_order, minimum_order_amount, free_delivery_over_amount,
              estimated_time_min, estimated_time_max
       FROM delivery_zones
       WHERE business_id = ? AND is_active = 1
       ORDER BY sort_order ASC, id ASC`
    )
    .all(businessId);
}

function getBusinessHours(businessId) {
  return db
    .prepare(
      `SELECT day_of_week, is_open, open_time, close_time
       FROM business_hours
       WHERE business_id = ?
       ORDER BY day_of_week ASC`
    )
    .all(businessId);
}

function ensureBusinessHoursRows(businessId) {
  const existing = db
    .prepare("SELECT COUNT(*) AS total FROM business_hours WHERE business_id = ?")
    .get(businessId).total;
  if (existing > 0) return;

  const insert = db.prepare(
    "INSERT INTO business_hours (business_id, day_of_week, is_open, open_time, close_time, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)"
  );
  for (let day = 0; day <= 6; day += 1) {
    insert.run(businessId, day, 1, "11:00", "23:00");
  }
}

function parseMinutes(hhmm) {
  const value = String(hhmm || "");
  const parts = value.split(":");
  if (parts.length !== 2) return null;
  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function businessOpenStatus(business, hoursRows) {
  if (business.is_temporarily_closed) {
    return {
      canOrder: false,
      state: "temporary_closed",
      label: "Cerrado temporalmente",
      message: business.temporary_closed_message || "El local no esta tomando pedidos en este momento.",
    };
  }

  const timezone = business.timezone || "America/Argentina/Ushuaia";
  const now = new Date();
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: timezone,
    }).formatToParts(now);
  } catch (_error) {
    parts = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "America/Argentina/Ushuaia",
    }).formatToParts(now);
  }

  const weekMap = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  const weekday = weekMap[parts.find((x) => x.type === "weekday")?.value] ?? 0;
  const hour = Number(parts.find((x) => x.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((x) => x.type === "minute")?.value ?? "0");
  const currentMinutes = hour * 60 + minute;

  const today = hoursRows.find((row) => Number(row.day_of_week) === weekday);
  if (!today || !today.is_open) {
    return {
      canOrder: false,
      state: "closed",
      label: "Cerrado",
      message: "El local se encuentra cerrado en este momento.",
    };
  }

  const open = parseMinutes(today.open_time);
  const close = parseMinutes(today.close_time);
  if (open === null || close === null) {
    return {
      canOrder: false,
      state: "closed",
      label: "Cerrado",
      message: "El local se encuentra cerrado en este momento.",
    };
  }

  let isOpenNow = false;
  if (close > open) {
    isOpenNow = currentMinutes >= open && currentMinutes < close;
  } else if (close < open) {
    isOpenNow = currentMinutes >= open || currentMinutes < close;
  }

  if (!isOpenNow) {
    return {
      canOrder: false,
      state: "closed",
      label: "Cerrado",
      message: `Horario de atencion: ${today.open_time || "--:--"} a ${today.close_time || "--:--"}`,
    };
  }

  return {
    canOrder: true,
    state: "open",
    label: "Abierto ahora",
    message: "",
  };
}

function businessMenuData(businessId, { includeHidden = false } = {}) {
  const categories = db
    .prepare(
      `SELECT id, business_id, name, sort_order
       FROM categories
       WHERE business_id = ?
       ORDER BY sort_order ASC, id ASC`
    )
    .all(businessId);

  const products = db
    .prepare(
      `SELECT p.*, c.name AS category_name
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.business_id = ?
       ${includeHidden ? "" : "AND p.is_visible = 1"}
       ORDER BY p.sort_order ASC, p.id ASC`
    )
    .all(businessId);

  const byCategory = new Map();
  for (const c of categories) {
    byCategory.set(c.id, { ...c, products: [] });
  }
  const uncategorized = { id: 0, name: "Otros", sort_order: 999, products: [] };

  for (const p of products) {
    const bucket = byCategory.get(p.category_id) || uncategorized;
    bucket.products.push(p);
  }

  const grouped = [...byCategory.values(), uncategorized].filter((c) => c.products.length > 0);
  return grouped;
}

function paymentMethodsForBusiness(business) {
  const transferReady = Boolean(
    String(business.transfer_alias || "").trim() || String(business.transfer_cvu || "").trim()
  );
  return {
    cash: Boolean(business.payment_cash_enabled),
    transfer: Boolean(business.payment_transfer_enabled) && transferReady,
    card: Boolean(business.payment_card_enabled),
  };
}

function normalizeMoneyValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(numeric * 100) / 100;
}

function displayPlanName(plan) {
  return plan.display_name || plan.name || plan.code || "Plan";
}

function ensureDefaultPlans() {
  const defaults = [
    { code: "BASIC", display_name: "Basico", price_ars: 12999, max_products: 10 },
    { code: "PREMIUM", display_name: "Premium", price_ars: 16999, max_products: 50 },
    { code: "ELITE", display_name: "Elite", price_ars: 21999, max_products: null },
  ];

  for (const plan of defaults) {
    const existing = db.prepare("SELECT id FROM plans WHERE code = ?").get(plan.code);
    if (existing) {
      db.prepare(
        `UPDATE plans
         SET display_name = ?, name = ?, price = ?, price_ars = ?, currency = 'ARS',
             max_products = ?, is_active = 1
         WHERE id = ?`
      ).run(
        plan.display_name,
        plan.display_name,
        plan.price_ars,
        plan.price_ars,
        plan.max_products,
        existing.id
      );
    } else {
      db.prepare(
        `INSERT INTO plans
         (code, display_name, name, price, price_ars, currency, max_products, is_active)
         VALUES (?, ?, ?, ?, ?, 'ARS', ?, 1)`
      ).run(plan.code, plan.display_name, plan.display_name, plan.price_ars, plan.price_ars, plan.max_products);
    }
  }
}

function activeSubscriptionForBusiness(businessId) {
  return db
    .prepare(
       `SELECT s.*, p.code AS plan_code, p.display_name AS plan_display_name, p.max_products
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       WHERE s.business_id = ? AND UPPER(COALESCE(s.status, '')) IN ('ACTIVE', 'PAID')
       ORDER BY COALESCE(s.current_period_end, s.updated_at, s.created_at) DESC, s.id DESC
       LIMIT 1`
    )
    .get(businessId);
}

function pendingSubscriptionForBusiness(businessId) {
  return db
    .prepare(
       `SELECT s.*, p.code AS plan_code, p.display_name AS plan_display_name, p.max_products
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       WHERE s.business_id = ? AND UPPER(COALESCE(s.status, '')) IN ('PENDING_PAYMENT', 'PENDING')
       ORDER BY s.updated_at DESC, s.id DESC
       LIMIT 1`
    )
    .get(businessId);
}

function isSubscriptionPaidLike(status) {
  const normalized = String(status || "").trim().toUpperCase();
  return normalized === "PAID" || normalized === "ACTIVE";
}

function resolveCommerceGate(businessId) {
  const business = db
    .prepare("SELECT id, has_completed_onboarding, plan_id FROM businesses WHERE id = ?")
    .get(businessId);
  const active = activeSubscriptionForBusiness(businessId);
  if (active) {
    return { allowed: true, redirectTo: null, active, pending: null };
  }
  // Compatibilidad para cuentas antiguas activadas antes del flujo de suscripciones.
  if (business && (Number(business.has_completed_onboarding) === 1 || business.plan_id)) {
    return { allowed: true, redirectTo: null, active: null, pending: null };
  }
  const pending = pendingSubscriptionForBusiness(businessId);
  if (pending) {
    return { allowed: false, redirectTo: "/onboarding/checkout", active: null, pending };
  }
  return { allowed: false, redirectTo: "/onboarding/plan", active: null, pending: null };
}

function canCreateProductForBusiness(businessId) {
  const active = activeSubscriptionForBusiness(businessId);
  const maxProducts = active?.max_products;
  if (maxProducts === null || maxProducts === undefined) return { allowed: true, maxProducts: null };
  const limit = Number(maxProducts);
  if (!Number.isFinite(limit) || limit <= 0) return { allowed: true, maxProducts: null };
  const total = db.prepare("SELECT COUNT(*) AS total FROM products WHERE business_id = ?").get(businessId).total;
  return { allowed: Number(total) < limit, maxProducts: limit, total: Number(total) };
}

async function ensureActiveSubscriptionAccess(req, res, next) {
  if (!req.session?.user || req.session.user.role !== "COMMERCE") return next();
  const business = await resolveBusinessForUser(req.session.user.id, { waitForPull: true });
  if (!business) {
    req.session.flash = {
      type: "error",
      text: "No encontramos tu comercio todavia. Reintenta en unos segundos.",
    };
    return res.redirect("/onboarding/plan");
  }
  const gate = resolveCommerceGate(business.id);
  if (gate.allowed) return next();
  return res.redirect(gate.redirectTo);
}

async function createMercadoPagoPreference({ subscription, plan, business, user, returnBasePath, planCode }) {
  if (!MP_ACCESS_TOKEN) {
    throw new Error("Mercado Pago no esta configurado.");
  }

  const cleanPlanCode = String(planCode || plan.code || "").trim().toUpperCase() || "PLAN";
  const backBase = returnBasePath || "/app/plans";
  const payload = {
    items: [
      {
        title: `Plan ${displayPlanName(plan)} - ${business.business_name}`,
        quantity: 1,
        currency_id: "ARS",
        unit_price: normalizeMoneyValue(subscription.amount),
      },
    ],
    payer: {
      email: user.email,
      name: user.full_name,
    },
    metadata: {
      subscription_id: subscription.id,
      business_id: business.id,
      plan_id: plan.id,
      plan_code: cleanPlanCode,
    },
    external_reference: subscription.external_reference,
    notification_url: MP_WEBHOOK_URL,
    back_urls: {
      success: `${BASE_URL}${backBase}?status=success&sub=${subscription.id}`,
      pending: `${BASE_URL}${backBase}?status=pending&sub=${subscription.id}`,
      failure: `${BASE_URL}${backBase}?status=failure&sub=${subscription.id}`,
    },
    auto_return: "approved",
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const response = await fetch("https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: controller.signal,
  });
  clearTimeout(timeout);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Error Mercado Pago (${response.status}): ${text.slice(0, 180)}`);
  }

  return response.json();
}

async function getMercadoPagoPayment(paymentId) {
  if (!MP_ACCESS_TOKEN) throw new Error("Mercado Pago no esta configurado.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    signal: controller.signal,
  });
  clearTimeout(timeout);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`No se pudo consultar pago ${paymentId}: ${text.slice(0, 180)}`);
  }
  return response.json();
}

function ensurePendingAffiliateSaleForSubscription(subscriptionId) {
  const subscription = db
    .prepare(
      `SELECT s.*, b.affiliate_id, b.id AS business_id
       FROM subscriptions s
       JOIN businesses b ON b.id = s.business_id
       WHERE s.id = ?`
    )
    .get(subscriptionId);
  if (!subscription) return;
  if (!isSubscriptionPaidLike(subscription.status)) return;
  if (!subscription.affiliate_id) return;

  const existingSale = db
    .prepare("SELECT id FROM affiliate_sales WHERE subscription_id = ?")
    .get(subscriptionId);
  if (existingSale) return;

  const affiliate = db.prepare("SELECT * FROM affiliates WHERE id = ?").get(subscription.affiliate_id);
  if (!affiliate || !affiliate.is_active) return;

  const amount = Number(subscription.amount || 0);
  const commissionRate = Number(affiliate.commission_rate || 0.25);
  const commissionAmount = Math.round(amount * commissionRate);
  const pointsEarned = Math.round(amount / 100);

  db.prepare(
    `INSERT INTO affiliate_sales
     (affiliate_id, business_id, subscription_id, plan_id, amount, commission_rate, commission_amount, points_earned, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', CURRENT_TIMESTAMP)`
  ).run(
    affiliate.id,
    subscription.business_id,
    subscription.id,
    subscription.plan_id,
    amount,
    commissionRate,
    commissionAmount,
    pointsEarned
  );
}

function plusDaysIso(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function createOrUpdatePendingSubscriptionAndPayment({ business, plan, checkoutUrl, preferenceId }) {
  const existingPending = pendingSubscriptionForBusiness(business.id);
  let subscriptionId = existingPending?.id || null;

  if (!subscriptionId) {
    const result = db
      .prepare(
        `INSERT INTO subscriptions
         (business_id, plan_id, amount, status, payment_provider, created_at, updated_at)
         VALUES (?, ?, ?, 'PENDING_PAYMENT', 'mercadopago', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      )
      .run(business.id, plan.id, normalizeMoneyValue(plan.price_ars ?? plan.price));
    subscriptionId = Number(result.lastInsertRowid);
  }

  const externalReference = `sub:${subscriptionId}|biz:${business.id}|plan:${String(plan.code || "").toUpperCase()}`;

  db.prepare(
    `UPDATE subscriptions
     SET plan_id = ?, amount = ?, status = 'PENDING_PAYMENT', payment_provider = 'mercadopago',
         provider_preference_id = ?, external_reference = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(
    plan.id,
    normalizeMoneyValue(plan.price_ars ?? plan.price),
    preferenceId || null,
    externalReference,
    subscriptionId
  );

  const pendingPayment = db
    .prepare(
      `SELECT * FROM payments
       WHERE subscription_id = ? AND status = 'pending'
       ORDER BY id DESC
       LIMIT 1`
    )
    .get(subscriptionId);

  if (pendingPayment) {
    db.prepare(
      `UPDATE payments
       SET provider_preference_id = ?, amount = ?, currency = ?, checkout_url = ?, created_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(
      preferenceId || pendingPayment.provider_preference_id || null,
      normalizeMoneyValue(plan.price_ars ?? plan.price),
      plan.currency || "ARS",
      checkoutUrl || pendingPayment.checkout_url || null,
      pendingPayment.id
    );
  } else {
    db.prepare(
      `INSERT INTO payments
       (subscription_id, provider, provider_preference_id, amount, currency, status, checkout_url, created_at)
       VALUES (?, 'mercadopago', ?, ?, ?, 'pending', ?, CURRENT_TIMESTAMP)`
    ).run(
      subscriptionId,
      preferenceId || null,
      normalizeMoneyValue(plan.price_ars ?? plan.price),
      plan.currency || "ARS",
      checkoutUrl || null
    );
  }

  db.prepare(
    `UPDATE businesses
     SET onboarding_step = 'checkout', has_completed_onboarding = 0, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(business.id);

  return { subscriptionId, externalReference };
}

function activateSubscriptionFromPayment(subscriptionId, paymentInfo) {
  const subscription = db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(subscriptionId);
  if (!subscription) return false;

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE subscriptions
       SET status = 'ACTIVE', provider_payment_id = ?, last_provider_status = ?, amount = ?,
           paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP),
           current_period_start = COALESCE(current_period_start, CURRENT_TIMESTAMP),
           current_period_end = COALESCE(current_period_end, ?),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(
      String(paymentInfo.paymentId || ""),
      String(paymentInfo.providerStatus || "approved"),
      normalizeMoneyValue(paymentInfo.amount || subscription.amount),
      plusDaysIso(30),
      subscriptionId
    );

    db.prepare(
      `UPDATE payments
       SET provider_payment_id = ?, merchant_order_id = ?, status = 'paid',
           paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP)
       WHERE subscription_id = ?`
    ).run(
      String(paymentInfo.paymentId || ""),
      paymentInfo.merchantOrderId ? String(paymentInfo.merchantOrderId) : null,
      subscriptionId
    );

    db.prepare(
      `UPDATE businesses
       SET has_completed_onboarding = 1,
           onboarding_step = 'done',
           plan_id = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(subscription.plan_id, subscription.business_id);
  });
  tx();
  ensurePendingAffiliateSaleForSubscription(subscriptionId);
  return true;
}

function approveAffiliateSale(saleId, adminId, note) {
  const sale = db.prepare("SELECT * FROM affiliate_sales WHERE id = ?").get(saleId);
  if (!sale || sale.status !== "PENDING") return { ok: false, message: "Venta no disponible para aprobar." };

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE affiliate_sales
       SET status = 'APPROVED', reviewed_at = CURRENT_TIMESTAMP, reviewed_by_admin_id = ?, review_note = ?
       WHERE id = ?`
    ).run(adminId, note || null, saleId);

    db.prepare(
      `UPDATE affiliates
       SET points_confirmed = points_confirmed + ?, total_commission_earned = total_commission_earned + ?
       WHERE id = ?`
    ).run(sale.points_earned, sale.commission_amount, sale.affiliate_id);
  });
  tx();
  return { ok: true };
}

function rejectAffiliateSale(saleId, adminId, note) {
  const sale = db.prepare("SELECT * FROM affiliate_sales WHERE id = ?").get(saleId);
  if (!sale || sale.status !== "PENDING") return { ok: false, message: "Venta no disponible para rechazar." };
  db.prepare(
    `UPDATE affiliate_sales
     SET status = 'REJECTED', reviewed_at = CURRENT_TIMESTAMP, reviewed_by_admin_id = ?, review_note = ?
     WHERE id = ?`
  ).run(adminId, note || null, saleId);
  return { ok: true };
}

function reverseAffiliateSale(saleId, adminId, note) {
  const sale = db.prepare("SELECT * FROM affiliate_sales WHERE id = ?").get(saleId);
  if (!sale || !["APPROVED", "PAID"].includes(sale.status)) {
    return { ok: false, message: "Solo se pueden revertir ventas APPROVED o PAID." };
  }

  const affiliate = db.prepare("SELECT * FROM affiliates WHERE id = ?").get(sale.affiliate_id);
  if (!affiliate) return { ok: false, message: "Afiliado no encontrado." };

  const tx = db.transaction(() => {
    const currentPoints = Number(affiliate.points_confirmed || 0);
    const pointsToDiscount = Number(sale.points_earned || 0);
    const newPoints = currentPoints - pointsToDiscount;
    const pointsDebtAdd = newPoints < 0 ? Math.abs(newPoints) : 0;

    const currentEarned = Number(affiliate.total_commission_earned || 0);
    const earnedAfter = currentEarned - Number(sale.commission_amount || 0);
    const newEarned = earnedAfter < 0 ? 0 : earnedAfter;
    const extraDebt = earnedAfter < 0 ? Math.abs(earnedAfter) : 0;
    const paidReverseDebt = sale.status === "PAID" ? Number(sale.commission_amount || 0) : 0;

    db.prepare(
      `UPDATE affiliates
       SET points_confirmed = ?, points_debt = points_debt + ?,
           total_commission_earned = ?, negative_balance = negative_balance + ?
       WHERE id = ?`
    ).run(
      Math.max(0, newPoints),
      pointsDebtAdd,
      newEarned,
      extraDebt + paidReverseDebt,
      affiliate.id
    );

    db.prepare(
      `UPDATE affiliate_sales
       SET status = 'REVERSED', reversed_at = CURRENT_TIMESTAMP, reviewed_at = CURRENT_TIMESTAMP,
           reviewed_by_admin_id = ?, reverse_note = ?, review_note = COALESCE(review_note, ?)
       WHERE id = ?`
    ).run(adminId, note || null, note || null, saleId);
  });

  tx();
  return { ok: true };
}

app.get("/", (req, res) => {
  res.render("landing", {
    title: "Windi Menu | Menu digital para tu comercio",
    description: "Crea tu menu digital con carrito, QR y pedidos por WhatsApp en minutos.",
  });
});

app.get("/robots.txt", (_req, res) => {
  res.type("text/plain").send("User-agent: *\nDisallow: /afiliados/\n");
});

app.get("/precios", (_req, res) => {
  res.render("public-precios", {
    title: "Precios | Windi Menu",
    description: "Planes Basico, Premium y Elite para tu menu digital con carrito y WhatsApp.",
  });
});

app.get("/faq", (_req, res) => {
  const faqs = [
    {
      q: "Que es el menu digital?",
      a: "Es una carta online de tu comercio para compartir por link o QR, actualizable en tiempo real.",
    },
    {
      q: "Como funciona el carrito?",
      a: "El cliente agrega productos, completa sus datos y envia el pedido armado por WhatsApp.",
    },
    {
      q: "Como se envia el pedido por WhatsApp?",
      a: "Se abre wa.me con un mensaje prearmado que incluye productos, total y datos de entrega o retiro.",
    },
    {
      q: "Como configuro envio por zonas?",
      a: "Desde el panel puedes crear zonas con costo, minimo y envio gratis por monto.",
    },
    {
      q: "Puedo activar o desactivar metodos de pago?",
      a: "Si. Puedes elegir tarjeta, transferencia y efectivo desde el panel de tu comercio.",
    },
    {
      q: "Como se genera el QR?",
      a: "En el panel tienes una seccion para generar y descargar el QR de tu menu.",
    },
    {
      q: "Puedo cambiar precios cuando quiera?",
      a: "Si. Puedes editar productos y precios en cualquier momento desde tu panel.",
    },
    {
      q: "Puedo pausar pedidos o marcar cerrado?",
      a: "Si. Puedes cerrar temporalmente o por horario, y bloquear pedidos fuera de hora.",
    },
    {
      q: "Como cambio de plan?",
      a: "Desde billing puedes seleccionar otro plan y pagar la nueva suscripcion.",
    },
    {
      q: "Que pasa si no pago el plan?",
      a: "La suscripcion queda pendiente o expirada y el acceso al panel se limita hasta regularizar.",
    },
    {
      q: "Que pasa con los datos personales?",
      a: "Tratamos datos para operar el servicio y soporte, segun Terminos y Politica de Privacidad.",
    },
  ];
  res.render("public-faq", {
    title: "FAQ | Windi Menu",
    description: "Respuestas rapidas sobre menu digital, carrito, pagos, envios y configuracion.",
    faqs,
  });
});

app.get(["/soporte", "/contacto", "/support"], (_req, res) => {
  res.render("public-soporte", {
    title: "Soporte | Windi Menu",
    description: "Canales de soporte de Windi Menu: WhatsApp, email y formulario de contacto.",
  });
});

app.get("/demo", (_req, res) => {
  res.render("public-demo", {
    title: "Demo | Windi Menu",
    description: "Prueba una demo real del menu digital con carrito, envio por zonas y pagos.",
  });
});

app.get("/demo/menu", (_req, res) => {
  const business = {
    slug: "demo-menu",
    business_name: "Pizzeria Demo",
    whatsapp: "5491100000000",
    logo_url: "https://images.unsplash.com/photo-1548365328-9f547fb0953f?auto=format&fit=crop&w=120&q=60",
    cover_url: "https://images.unsplash.com/photo-1513104890138-7c749659a591?auto=format&fit=crop&w=1600&q=80",
    hours: "Lun a Dom 19:00 a 00:30",
    address: "Av. Corrientes 1234, CABA",
    instagram: "https://instagram.com/windimenu",
    delivery_enabled: 1,
    pickup_enabled: 1,
    minimum_order_amount: 8000,
    free_delivery_over_amount: 20000,
    cash_allow_change: 1,
    transfer_alias: "PIZZERIA.DEMO.MP",
    transfer_cvu: "0000003100000000000000",
    transfer_account_holder: "Pizzeria Demo SRL",
    transfer_instructions: "Enviar comprobante por WhatsApp al confirmar.",
  };
  const grouped = [
    {
      id: 1,
      name: "Pizzas",
      products: [
        {
          id: 101,
          name: "Pizza Muzza",
          description: "Salsa de tomate, muzzarella y oregano.",
          price: 10500,
          previous_price: 11900,
          image_url:
            "https://images.unsplash.com/photo-1594007654729-407eedc4be65?auto=format&fit=crop&w=900&q=80",
          is_featured: 1,
          is_sold_out: 0,
        },
        {
          id: 102,
          name: "Pizza Napolitana",
          description: "Muzzarella, tomate fresco y ajo.",
          price: 11800,
          previous_price: null,
          image_url:
            "https://images.unsplash.com/photo-1573821663912-6df460f9c684?auto=format&fit=crop&w=900&q=80",
          is_featured: 0,
          is_sold_out: 0,
        },
      ],
    },
    {
      id: 2,
      name: "Bebidas",
      products: [
        {
          id: 201,
          name: "Gaseosa 1.5L",
          description: "Linea cola, limon o naranja.",
          price: 3000,
          previous_price: null,
          image_url:
            "https://images.unsplash.com/photo-1624517452488-04869289c4ca?auto=format&fit=crop&w=900&q=80",
          is_featured: 0,
          is_sold_out: 0,
        },
        {
          id: 202,
          name: "Agua saborizada",
          description: "Botella 500ml.",
          price: 1900,
          previous_price: null,
          image_url: null,
          is_featured: 0,
          is_sold_out: 1,
        },
      ],
    },
  ];
  const deliveryZones = [
    {
      id: 1,
      name: "Centro",
      price: 2500,
      is_active: 1,
      sort_order: 0,
      minimum_order_amount: 10000,
      free_delivery_over_amount: 25000,
      estimated_time_min: 30,
      estimated_time_max: 45,
    },
    {
      id: 2,
      name: "Zona Norte",
      price: 3200,
      is_active: 1,
      sort_order: 1,
      minimum_order_amount: null,
      free_delivery_over_amount: null,
      estimated_time_min: 40,
      estimated_time_max: 60,
    },
  ];
  const paymentMethods = { cash: true, transfer: true, card: true };
  const openStatus = { canOrder: true, state: "open", label: "Abierto ahora", message: "" };

  res.render("public-demo-menu", {
    title: "Demo Menu | Windi Menu",
    description: "Demo funcional del menu publico con carrito y checkout por WhatsApp.",
    business,
    grouped,
    deliveryZones,
    paymentMethods,
    openStatus,
  });
});

app.get("/como-funciona", (_req, res) => {
  res.render("public-como-funciona", {
    title: "Como funciona | Windi Menu",
    description: "Conoce en 5 pasos como lanzar tu menu digital y recibir pedidos por WhatsApp.",
  });
});

app.get("/status", (_req, res) => {
  res.render("public-status", {
    title: "Status | Windi Menu",
    description: "Estado del servicio de Windi Menu.",
    updatedAt: new Date().toLocaleString("es-AR"),
  });
});

app.get("/register", (req, res) => {
  if (req.session.user) return res.redirect("/app");
  const rawRef = String(req.query.ref || "").trim().toUpperCase();
  const cookies = parseCookies(req);
  let referral = null;

  if (rawRef) {
    const affiliate = findAffiliateByRefCode(rawRef);
    if (affiliate) {
      referral = affiliate;
      setCookie(res, "windi_ref_code", rawRef, 60 * 60 * 24 * 30);
    } else {
      clearCookie(res, "windi_ref_code");
    }
  } else if (cookies.windi_ref_code) {
    const affiliate = findAffiliateByRefCode(String(cookies.windi_ref_code).toUpperCase());
    if (affiliate) referral = affiliate;
  }

  res.render("auth-register", {
    title: "Crear cuenta | Windi Menu",
    referral,
    referralCode: referral?.ref_code || rawRef || "",
  });
});

app.get("/registro", (req, res) => {
  const params = new URLSearchParams();
  if (req.query.ref) params.set("ref", String(req.query.ref));
  const qs = params.toString();
  res.redirect(`/register${qs ? `?${qs}` : ""}`);
});

app.get("/r/:refCode", (req, res) => {
  const refCode = String(req.params.refCode || "").trim().toUpperCase();
  res.redirect(`/register?ref=${encodeURIComponent(refCode)}`);
});

app.get("/afiliados/login", (_req, res) => {
  res.render("affiliate/auth-login", {
    title: "Ingreso afiliados | Windi Menu",
    robots: "noindex,nofollow",
  });
});

app.post("/afiliados/login", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  let user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user && RUNTIME_SYNC && HAS_SUPABASE_DB) {
    try {
      await withTimeout(pullMirrorNow(), 2500);
      user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    } catch (_error) {
      // noop
    }
  }

  if (!user || !bcrypt.compareSync(password, user.password_hash) || !["AFFILIATE", "ADMIN"].includes(user.role)) {
    return flashAndRedirect(req, res, "error", "Email o clave invalidos.", "/afiliados/login");
  }

  req.session.user = {
    id: user.id,
    fullName: user.full_name,
    email: user.email,
    role: user.role,
  };

  if (user.role === "ADMIN") return flashAndRedirect(req, res, "success", "Sesion iniciada.", "/admin/affiliate-sales");
  return flashAndRedirect(req, res, "success", "Sesion iniciada.", "/afiliados/panel");
});

app.get("/afiliados/registro", (_req, res) => {
  res.render("affiliate/auth-register", {
    title: "Registro afiliados | Windi Menu",
    robots: "noindex,nofollow",
  });
});

app.post("/afiliados/registro", (req, res) => {
  const fullName = String(req.body.full_name || "").trim();
  const whatsapp = String(req.body.whatsapp || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  if (!fullName || !whatsapp || !email || password.length < 6) {
    return flashAndRedirect(
      req,
      res,
      "error",
      "Completa todos los campos. La clave debe tener al menos 6 caracteres.",
      "/afiliados/registro"
    );
  }
  if (!req.body.accept_legal) {
    return flashAndRedirect(
      req,
      res,
      "error",
      "Debes aceptar Terminos y Privacidad para continuar.",
      "/afiliados/registro"
    );
  }

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) return flashAndRedirect(req, res, "error", "Ese email ya esta registrado.", "/afiliados/registro");

  const passwordHash = bcrypt.hashSync(password, 10);
  const userResult = db
    .prepare("INSERT INTO users (full_name, email, whatsapp, role, password_hash) VALUES (?, ?, ?, 'AFFILIATE', ?)")
    .run(fullName, email, whatsapp, passwordHash);
  const userId = userResult.lastInsertRowid;
  const refCode = generateAffiliateRefCode(fullName || email);

  db.prepare(
    `INSERT INTO affiliates
     (user_id, ref_code, commission_rate, points_confirmed, points_debt, total_commission_earned, total_commission_paid, negative_balance, is_active)
     VALUES (?, ?, 0.25, 0, 0, 0, 0, 0, 1)`
  ).run(userId, refCode);

  recordLegalConsent(req, { userId, role: "AFFILIATE", source: "registration" });

  req.session.user = {
    id: userId,
    fullName,
    email,
    role: "AFFILIATE",
  };

  scheduleMirrorPush();
  return flashAndRedirect(req, res, "success", "Cuenta afiliada creada.", "/afiliados/panel");
});

app.get("/afiliados", (req, res) => {
  if (!req.session?.user) return res.redirect("/afiliados/login");
  if (["AFFILIATE", "ADMIN"].includes(req.session.user.role)) return res.redirect("/afiliados/panel");
  return res.status(404).render("404", {
    title: "Pagina no encontrada | Windi Menu",
    description: "No encontramos la pagina que buscas en Windi Menu.",
  });
});

app.post("/register", async (req, res) => {
  const { full_name, business_name, whatsapp, email, password } = req.body;
  const cleanEmail = String(email || "").trim().toLowerCase();
  const minPassword = String(password || "");

  if (!full_name || !business_name || !whatsapp || !cleanEmail || minPassword.length < 6) {
    return flashAndRedirect(
      req,
      res,
      "error",
      "Completa todos los campos. La clave debe tener al menos 6 caracteres.",
      "/register"
    );
  }
  if (!req.body.accept_legal) {
    return flashAndRedirect(
      req,
      res,
      "error",
      "Debes aceptar los Terminos y la Politica de Privacidad para crear la cuenta.",
      "/register"
    );
  }

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(cleanEmail);
  if (existing) {
    return flashAndRedirect(req, res, "error", "Ese email ya esta registrado.", "/register");
  }

  const passwordHash = bcrypt.hashSync(minPassword, 10);
  const userResult = db
    .prepare("INSERT INTO users (full_name, email, whatsapp, role, password_hash) VALUES (?, ?, ?, 'COMMERCE', ?)")
    .run(full_name.trim(), cleanEmail, whatsapp.trim(), passwordHash);

  const cookies = parseCookies(req);
  const refFromBody = String(req.body.ref || "").trim().toUpperCase();
  const refCode = refFromBody || String(cookies.windi_ref_code || "").trim().toUpperCase();
  let affiliateId = null;
  let referredAt = null;

  if (refCode) {
    const affiliate = findAffiliateByRefCode(refCode);
    if (affiliate) {
      if (String(affiliate.user_email || "").toLowerCase() !== cleanEmail) {
        affiliateId = affiliate.id;
        referredAt = new Date().toISOString();
      }
    }
  }

  const base = slugify(business_name);
  const slug = uniqueSlug(base || "comercio", (candidate) =>
    Boolean(db.prepare("SELECT 1 FROM businesses WHERE slug = ?").get(candidate))
  );

  db.prepare(
    `INSERT INTO businesses
     (user_id, business_name, slug, whatsapp, affiliate_id, referred_at, has_completed_onboarding, onboarding_step)
     VALUES (?, ?, ?, ?, ?, ?, 0, 'welcome')`
  ).run(userResult.lastInsertRowid, business_name.trim(), slug, whatsapp.trim(), affiliateId, referredAt);

  req.session.user = {
    id: userResult.lastInsertRowid,
    fullName: full_name.trim(),
    email: cleanEmail,
    role: "COMMERCE",
  };

  recordLegalConsent(req, {
    userId: userResult.lastInsertRowid,
    role: "COMMERCE",
    source: "registration",
  });

  clearCookie(res, "windi_ref_code");
  if (RUNTIME_SYNC && HAS_SUPABASE_DB) {
    try {
      await withTimeout(pushMirrorNow(), 5000);
    } catch (_error) {
      scheduleMirrorPush();
    }
  } else {
    scheduleMirrorPush();
  }

  return flashAndRedirect(req, res, "success", "Cuenta creada correctamente.", "/onboarding/welcome");
});

app.get("/login", async (req, res) => {
  if (req.session.user) {
    const role = req.session.user.role || "COMMERCE";
    if (role === "ADMIN") return res.redirect("/admin/affiliate-sales");
    if (role === "AFFILIATE") return res.redirect("/afiliados/panel");
    const business = await resolveBusinessForUser(req.session.user.id, { waitForPull: true });
    if (!business) return renderBusinessProvisioning(res);
    const gate = resolveCommerceGate(business.id);
    return res.redirect(gate.allowed ? "/app" : gate.redirectTo);
  }
  res.render("auth-login", { title: "Iniciar sesion | Windi Menu" });
});

app.post("/login", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  let user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user && RUNTIME_SYNC && HAS_SUPABASE_DB) {
    try {
      await withTimeout(pullMirrorNow(), 2000);
      user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    } catch (_error) {
      // Ignore and fall through to invalid credentials.
    }
  }
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return flashAndRedirect(req, res, "error", "Email o clave invalidos.", "/login");
  }

  const role = user.role || "COMMERCE";
  req.session.user = { id: user.id, fullName: user.full_name, email: user.email, role };

  let target = "/app";
  if (role === "AFFILIATE") {
    target = "/afiliados/panel";
  } else if (role === "ADMIN") {
    target = "/admin/affiliate-sales";
  } else {
    const business = await resolveBusinessForUser(user.id, { waitForPull: true });
    if (business) {
      const gate = resolveCommerceGate(business.id);
      target = gate.allowed ? "/app" : gate.redirectTo;
    } else {
      target = "/onboarding/plan";
    }
  }
  return flashAndRedirect(req, res, "success", "Sesion iniciada.", target);
});

app.post("/logout", (req, res) => {
  req.session = null;
  res.redirect("/");
});

app.get("/logout", (req, res) => {
  req.session = null;
  res.redirect("/login");
});

app.get("/forgot-password", (_req, res) => {
  res.render("auth-forgot", { title: "Recuperar clave | Windi Menu" });
});

app.get("/terminos", (_req, res) => {
  res.render("legal/terminos", {
    title: "Terminos y Condiciones | Windi Menu",
    description: "Terminos y condiciones de uso de Windi Menu.",
    legal: LEGAL_VERSIONS,
    company: LEGAL_COMPANY,
  });
});

app.get("/privacidad", (_req, res) => {
  res.render("legal/privacidad", {
    title: "Politica de Privacidad | Windi Menu",
    description: "Politica de privacidad de Windi Menu.",
    legal: LEGAL_VERSIONS,
    company: LEGAL_COMPANY,
  });
});

app.get("/cookies", (_req, res) => {
  res.render("legal/cookies", {
    title: "Politica de Cookies | Windi Menu",
    description: "Politica de cookies de Windi Menu.",
    legal: LEGAL_VERSIONS,
    company: LEGAL_COMPANY,
  });
});

app.get("/reembolsos", (_req, res) => {
  res.render("legal/reembolsos", {
    title: "Reembolsos y Cancelaciones | Windi Menu",
    description: "Condiciones de cancelacion y reembolsos para planes de Windi Menu.",
    legal: LEGAL_VERSIONS,
    company: LEGAL_COMPANY,
  });
});

app.get("/legal/accept", requireAuth, (req, res) => {
  const role = req.session.user.role || "COMMERCE";
  if (role === "AFFILIATE") return res.redirect("/afiliados/panel");
  if (role === "ADMIN") return res.redirect("/admin/affiliate-sales");
  const business = getBusinessByUserId(req.session.user.id);
  if (!business) return renderBusinessProvisioning(res);
  const gate = resolveCommerceGate(business.id);
  return res.redirect(gate.allowed ? "/app" : gate.redirectTo);
});

app.post("/legal/accept", requireAuth, (req, res) => {
  const role = req.session.user.role || "COMMERCE";
  if (role === "AFFILIATE") return res.redirect("/afiliados/panel");
  if (role === "ADMIN") return res.redirect("/admin/affiliate-sales");
  const business = getBusinessByUserId(req.session.user.id);
  if (!business) return res.redirect("/onboarding/plan");
  const gate = resolveCommerceGate(business.id);
  return res.redirect(gate.allowed ? "/app" : gate.redirectTo);
});

app.get("/legal/aceptar", requireAuth, (req, res) => {
  return res.redirect("/legal/accept");
});

app.get("/settings/legal", requireAuth, (req, res) => {
  const role = req.session.user.role || "COMMERCE";
  ensureLegalConsentsTable();
  let consents = [];
  try {
    consents = db
      .prepare(
        `SELECT accepted_at, role, terms_version, privacy_version, source
         FROM legal_consents
         WHERE user_id = ?
         ORDER BY accepted_at DESC, id DESC`
      )
      .all(req.session.user.id);
  } catch (error) {
    console.error("settings/legal fallo:", error.message);
    consents = [];
  }

  res.render("settings/legal", {
    title: "Consentimiento legal | Windi Menu",
    consents,
    legal: LEGAL_VERSIONS,
    activePage: role === "COMMERCE" ? "settings-legal" : "",
  });
});

app.get("/onboarding/welcome", requireRole("COMMERCE"), async (req, res) => {
  const business = await resolveBusinessForUser(req.session.user.id, { waitForPull: true });
  if (!business) return renderBusinessProvisioning(res);
  const gate = resolveCommerceGate(business.id);
  if (gate.allowed) return res.redirect("/app");
  res.render("onboarding/welcome", {
    title: "Bienvenido | Windi Menu",
    business,
  });
});

app.get("/onboarding/plan", requireRole("COMMERCE"), async (req, res) => {
  ensureDefaultPlans();
  const business = await resolveBusinessForUser(req.session.user.id, { waitForPull: true });
  if (!business) return renderBusinessProvisioning(res);
  const gate = resolveCommerceGate(business.id);
  if (gate.allowed) return res.redirect("/app");

  const plans = db
    .prepare("SELECT * FROM plans WHERE is_active = 1 ORDER BY COALESCE(price_ars, price) ASC, id ASC")
    .all();

  res.render("onboarding/plan", {
    title: "Elegi tu plan | Windi Menu",
    business,
    plans,
    mercadopagoReady: Boolean(MP_ACCESS_TOKEN),
  });
});

app.get("/onboarding/checkout", requireRole("COMMERCE"), async (req, res) => {
  const business = await resolveBusinessForUser(req.session.user.id, { waitForPull: true });
  if (!business) return renderBusinessProvisioning(res);
  const gate = resolveCommerceGate(business.id);
  if (gate.allowed) return res.redirect("/app");

  const pending = gate.pending || pendingSubscriptionForBusiness(business.id);
  if (!pending) return res.redirect("/onboarding/plan");

  const payment = db
    .prepare(
      `SELECT *
       FROM payments
       WHERE subscription_id = ?
       ORDER BY id DESC
       LIMIT 1`
    )
    .get(pending.id);
  const plan = db.prepare("SELECT * FROM plans WHERE id = ?").get(pending.plan_id);
  const status = String(req.query.status || payment?.status || "pending").trim().toLowerCase();

  res.render("onboarding/checkout", {
    title: "Checkout | Windi Menu",
    business,
    subscription: pending,
    plan,
    payment,
    paymentStatus: status,
    mercadopagoReady: Boolean(MP_ACCESS_TOKEN),
  });
});

app.post("/api/onboarding/select-plan", requireRole("COMMERCE"), async (req, res) => {
  try {
    ensureDefaultPlans();
    const business = getBusinessByUserId(req.session.user.id);
    if (!business) return res.status(400).json({ ok: false, message: "Comercio no encontrado." });
    const gate = resolveCommerceGate(business.id);
    if (gate.allowed) {
      return res.json({ ok: true, already_active: true, redirect_to: "/app" });
    }
    const user = db.prepare("SELECT id, email, full_name FROM users WHERE id = ?").get(req.session.user.id);
    const planCode = String(req.body.plan_code || "").trim().toUpperCase();
    const planId = Number(req.body.plan_id || 0);
    let plan = null;
    if (planCode) {
      plan = db
        .prepare(
          `SELECT *
           FROM plans
           WHERE (UPPER(COALESCE(code, '')) = ? OR UPPER(COALESCE(display_name, '')) = ? OR UPPER(COALESCE(name, '')) = ?)
             AND COALESCE(is_active, 1) = 1
           ORDER BY id ASC
           LIMIT 1`
        )
        .get(planCode, planCode, planCode);
    }
    if (!plan && planId) {
      plan = db
        .prepare("SELECT * FROM plans WHERE id = ? AND COALESCE(is_active, 1) = 1 LIMIT 1")
        .get(planId);
    }
    if (!plan) return res.status(400).json({ ok: false, message: "Plan invalido." });
    if (!MP_ACCESS_TOKEN) return res.status(503).json({ ok: false, message: "Pasarela no configurada." });
    const expectedAmount = normalizeMoneyValue(plan.price_ars ?? plan.price);

    const currentPending = pendingSubscriptionForBusiness(business.id);
    if (currentPending) {
      const existingPayment = db
        .prepare(
          `SELECT * FROM payments
           WHERE subscription_id = ? AND status = 'pending' AND checkout_url IS NOT NULL
           ORDER BY id DESC
           LIMIT 1`
        )
        .get(currentPending.id);
      const pendingAmount = normalizeMoneyValue(currentPending.amount);
      const paymentAmount = normalizeMoneyValue(existingPayment?.amount);
      if (
        existingPayment &&
        currentPending.plan_id === plan.id &&
        pendingAmount === expectedAmount &&
        paymentAmount === expectedAmount
      ) {
        return res.json({ ok: true, checkout_url: existingPayment.checkout_url, subscription_id: currentPending.id });
      }
    }

    let seedSubscription = currentPending;
    if (!seedSubscription) {
      const created = db
        .prepare(
          `INSERT INTO subscriptions
           (business_id, plan_id, amount, status, payment_provider, created_at, updated_at)
           VALUES (?, ?, ?, 'PENDING_PAYMENT', 'mercadopago', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
        )
        .run(business.id, plan.id, expectedAmount);
      seedSubscription = { id: Number(created.lastInsertRowid), amount: expectedAmount };
    }

    const externalReference = `sub:${seedSubscription.id}|biz:${business.id}|plan:${planCode}`;
    const preference = await withTimeout(
      createMercadoPagoPreference({
        subscription: {
          id: seedSubscription.id,
          amount: expectedAmount,
          external_reference: externalReference,
        },
        plan,
        business,
        user,
        returnBasePath: "/onboarding/checkout",
        planCode,
      }),
      12000
    );

    const checkoutUrl = preference.init_point || preference.sandbox_init_point;
    if (!checkoutUrl) {
      return res.status(502).json({ ok: false, message: "Mercado Pago no devolvio checkout_url." });
    }

    const updated = createOrUpdatePendingSubscriptionAndPayment({
      business,
      plan,
      checkoutUrl,
      preferenceId: String(preference.id || ""),
    });

    return res.json({ ok: true, checkout_url: checkoutUrl, subscription_id: updated.subscriptionId });
  } catch (error) {
    console.error("Select plan/onboarding fallo:", error.message);
    if (String(error.message || "").toLowerCase().includes("timeout")) {
      return res.status(504).json({
        ok: false,
        message: "Mercado Pago tardo demasiado en responder. Reintenta en unos segundos.",
      });
    }
    return res.status(500).json({ ok: false, message: "No se pudo iniciar el checkout." });
  }
});

app.get("/api/subscription/status", requireRole("COMMERCE"), (req, res) => {
  const business = getBusinessByUserId(req.session.user.id);
  if (!business) return res.status(400).json({ ok: false, message: "Comercio no encontrado." });
  const active = activeSubscriptionForBusiness(business.id);
  const pending = pendingSubscriptionForBusiness(business.id);
  const subscriptionId = Number(req.query.sub || pending?.id || active?.id || 0);
  if (!subscriptionId) {
    return res.json({ ok: true, status: "NONE", active: false });
  }
  const subscription = db
    .prepare("SELECT id, status, current_period_start, current_period_end FROM subscriptions WHERE id = ? AND business_id = ?")
    .get(subscriptionId, business.id);
  if (!subscription) return res.status(404).json({ ok: false, message: "Suscripcion no encontrada." });
  return res.json({
    ok: true,
    status: String(subscription.status || "").toUpperCase(),
    active: ["ACTIVE", "PAID"].includes(String(subscription.status || "").toUpperCase()),
    subscription,
  });
});

async function processMercadoPagoWebhook(req, res) {
  try {
    const queryPaymentId = req.query["data.id"] || req.query.id;
    const bodyPaymentId = req.body?.data?.id || req.body?.id;
    const paymentId = String(queryPaymentId || bodyPaymentId || "").trim();
    if (!paymentId) return res.status(200).json({ ok: true, ignored: true });

    const alreadyProcessed = db
      .prepare("SELECT id FROM payments WHERE provider_payment_id = ? AND status = 'paid' LIMIT 1")
      .get(paymentId);
    if (alreadyProcessed) return res.status(200).json({ ok: true, duplicate: true });

    const payment = await getMercadoPagoPayment(paymentId);
    const externalReference = String(payment.external_reference || "").trim();
    const providerStatus = String(payment.status || "").trim().toLowerCase();
    const amount = normalizeMoneyValue(payment.transaction_amount || 0);
    const merchantOrderId = payment.order?.id || null;

    let subscription = null;
    if (payment.metadata?.subscription_id) {
      subscription = db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(Number(payment.metadata.subscription_id));
    }
    if (!subscription && externalReference) {
      subscription = db
        .prepare("SELECT * FROM subscriptions WHERE external_reference = ? ORDER BY id DESC LIMIT 1")
        .get(externalReference);
    }
    if (!subscription) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const normalizedSubStatus =
      providerStatus === "approved"
        ? "ACTIVE"
        : providerStatus === "pending"
          ? "PENDING_PAYMENT"
          : ["rejected", "cancelled"].includes(providerStatus)
            ? "CANCELED"
            : ["refunded", "charged_back"].includes(providerStatus)
              ? "EXPIRED"
              : "PENDING_PAYMENT";
    const normalizedPayStatus =
      providerStatus === "approved"
        ? "paid"
        : providerStatus === "pending"
          ? "pending"
          : ["rejected", "cancelled"].includes(providerStatus)
            ? "failed"
            : ["refunded", "charged_back"].includes(providerStatus)
              ? "refunded"
              : "pending";

    db.prepare(
      `UPDATE subscriptions
       SET status = ?, provider_payment_id = ?, last_provider_status = ?, amount = ?, updated_at = CURRENT_TIMESTAMP,
           paid_at = CASE WHEN ? = 'ACTIVE' THEN COALESCE(paid_at, CURRENT_TIMESTAMP) ELSE paid_at END
       WHERE id = ?`
    ).run(
      normalizedSubStatus,
      paymentId,
      providerStatus || null,
      amount > 0 ? amount : normalizeMoneyValue(subscription.amount),
      normalizedSubStatus,
      subscription.id
    );

    const existingPayment = db
      .prepare("SELECT * FROM payments WHERE subscription_id = ? ORDER BY id DESC LIMIT 1")
      .get(subscription.id);
    if (existingPayment) {
      db.prepare(
        `UPDATE payments
         SET provider_payment_id = ?, merchant_order_id = ?, amount = ?, status = ?, paid_at = ?,
             currency = COALESCE(currency, 'ARS')
         WHERE id = ?`
      ).run(
        paymentId,
        merchantOrderId ? String(merchantOrderId) : null,
        amount > 0 ? amount : normalizeMoneyValue(existingPayment.amount),
        normalizedPayStatus,
        normalizedPayStatus === "paid" ? new Date().toISOString() : existingPayment.paid_at || null,
        existingPayment.id
      );
    } else {
      db.prepare(
        `INSERT INTO payments
         (subscription_id, provider, provider_payment_id, merchant_order_id, amount, currency, status, paid_at, created_at)
         VALUES (?, 'mercadopago', ?, ?, ?, 'ARS', ?, ?, CURRENT_TIMESTAMP)`
      ).run(
        subscription.id,
        paymentId,
        merchantOrderId ? String(merchantOrderId) : null,
        amount > 0 ? amount : normalizeMoneyValue(subscription.amount),
        normalizedPayStatus,
        normalizedPayStatus === "paid" ? new Date().toISOString() : null
      );
    }

    if (normalizedPayStatus === "paid") {
      activateSubscriptionFromPayment(subscription.id, {
        paymentId,
        providerStatus,
        amount,
        merchantOrderId,
      });
    } else if (normalizedPayStatus === "refunded") {
      const sale = db
        .prepare(
          `SELECT id
           FROM affiliate_sales
           WHERE subscription_id = ? AND status IN ('APPROVED', 'PAID')
           ORDER BY id DESC
           LIMIT 1`
        )
        .get(subscription.id);
      if (sale) {
        reverseAffiliateSale(sale.id, null, "Reversa automatica por contracargo/refund de Mercado Pago");
      }
      db.prepare(
        `UPDATE businesses
         SET has_completed_onboarding = 0, onboarding_step = 'plan', updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      ).run(subscription.business_id);
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Webhook Mercado Pago fallo:", error.message);
    return res.status(200).json({ ok: true });
  }
}

app.post("/api/webhooks/mercadopago", processMercadoPagoWebhook);
app.post("/webhooks/mercadopago", processMercadoPagoWebhook);

app.use("/app", requireRole("COMMERCE"), ensureActiveSubscriptionAccess);
app.use("/panel", requireRole("COMMERCE"), ensureActiveSubscriptionAccess);

app.get("/panel", (_req, res) => res.redirect("/app"));
app.get("/panel/dashboard", (_req, res) => res.redirect("/app"));
app.get("/panel/:section", (req, res) => res.redirect(`/app/${req.params.section}`));

app.get("/app", requireAuth, (req, res) => {
  const business = getBusinessByUserId(req.session.user.id);
  ensureBusinessHoursRows(business.id);
  const totals = {
    categories: db
      .prepare("SELECT COUNT(*) AS total FROM categories WHERE business_id = ?")
      .get(business.id).total,
    products: db
      .prepare("SELECT COUNT(*) AS total FROM products WHERE business_id = ?")
      .get(business.id).total,
    featured: db
      .prepare("SELECT COUNT(*) AS total FROM products WHERE business_id = ? AND is_featured = 1")
      .get(business.id).total,
    soldOut: db
      .prepare("SELECT COUNT(*) AS total FROM products WHERE business_id = ? AND is_sold_out = 1")
      .get(business.id).total,
  };

  res.render("app/dashboard", {
    title: "Dashboard | Windi Menu",
    business,
    totals,
    activePage: "dashboard",
  });
});

app.get(["/app/plans", "/billing"], requireAuth, (req, res) => {
  ensureDefaultPlans();
  const business = getBusinessByUserId(req.session.user.id);
  if (!business) return flashAndRedirect(req, res, "error", "Comercio no encontrado.", "/register");
  const plans = db
    .prepare("SELECT * FROM plans WHERE is_active = 1 ORDER BY COALESCE(price_ars, price) ASC, id ASC")
    .all();

  const subscriptions = db
    .prepare(
      `SELECT s.*, p.display_name AS plan_name, p.code AS plan_code
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       WHERE s.business_id = ?
       ORDER BY s.created_at DESC
       LIMIT 20`
    )
    .all(business.id);

  const currentPaid = activeSubscriptionForBusiness(business.id);

  res.render("app/plans", {
    title: "Planes y facturacion | Windi Menu",
    business,
    plans,
    subscriptions,
    currentPaid,
    paymentState: String(req.query.status || req.query.payment || "").trim().toLowerCase(),
    activePage: "plans",
    mercadopagoReady: Boolean(MP_ACCESS_TOKEN),
  });
});

app.get("/mi-cuenta", requireRole("COMMERCE"), (req, res) => {
  const user = db
    .prepare("SELECT id, full_name, email, whatsapp, role, created_at FROM users WHERE id = ?")
    .get(req.session.user.id);
  if (!user) return flashAndRedirect(req, res, "error", "Usuario no encontrado.", "/login");
  const latestConsent = latestLegalConsentByUser(user.id);
  const business = user.role === "COMMERCE" ? getBusinessByUserId(user.id) : null;
  if (user.role === "COMMERCE" && !business) return renderBusinessProvisioning(res);

  res.render("app/account", {
    title: "Mi cuenta | Windi Menu",
    activePage: "account",
    user,
    business,
    latestConsent,
  });
});

app.post("/mi-cuenta", requireRole("COMMERCE"), (req, res) => {
  const fullName = String(req.body.full_name || "").trim();
  const whatsapp = String(req.body.whatsapp || "").trim();
  if (!fullName || !whatsapp) {
    return flashAndRedirect(req, res, "error", "Nombre y WhatsApp son obligatorios.", "/mi-cuenta");
  }
  db.prepare("UPDATE users SET full_name = ?, whatsapp = ? WHERE id = ?").run(fullName, whatsapp, req.session.user.id);
  if (req.session.user) {
    req.session.user.fullName = fullName;
    req.session.user.whatsapp = whatsapp;
  }
  return flashAndRedirect(req, res, "success", "Datos actualizados.", "/mi-cuenta");
});

app.post("/app/plans/:id/checkout", requireAuth, async (req, res) => {
  const business = getBusinessByUserId(req.session.user.id);
  const user = db.prepare("SELECT id, email, full_name FROM users WHERE id = ?").get(req.session.user.id);
  const planId = Number(req.params.id);
  const plan = db.prepare("SELECT * FROM plans WHERE id = ? AND is_active = 1").get(planId);

  if (!plan) {
    return flashAndRedirect(req, res, "error", "Plan no disponible.", "/app/plans");
  }

  if (!MP_ACCESS_TOKEN) {
    return flashAndRedirect(
      req,
      res,
      "error",
      "Pasarela no configurada. Configura MP_ACCESS_TOKEN en el servidor.",
      "/app/plans"
    );
  }

  try {
    const draft = createOrUpdatePendingSubscriptionAndPayment({
      business,
      plan,
      checkoutUrl: null,
      preferenceId: null,
    });
    const preference = await withTimeout(
      createMercadoPagoPreference({
        subscription: {
          id: draft.subscriptionId,
          amount: normalizeMoneyValue(plan.price_ars ?? plan.price),
          external_reference: draft.externalReference,
        },
        plan,
        business,
        user,
        returnBasePath: "/app/plans",
        planCode: plan.code,
      }),
      12000
    );

    const checkoutUrl = preference.init_point || preference.sandbox_init_point;
    if (!checkoutUrl) {
      throw new Error("Mercado Pago no devolvio URL de checkout.");
    }
    createOrUpdatePendingSubscriptionAndPayment({
      business,
      plan,
      checkoutUrl,
      preferenceId: String(preference.id || ""),
    });

    return res.redirect(checkoutUrl);
  } catch (error) {
    console.error("Error creando checkout Mercado Pago:", error.message);
    if (String(error.message || "").toLowerCase().includes("timeout")) {
      return flashAndRedirect(
        req,
        res,
        "error",
        "Mercado Pago esta demorando. Reintenta en unos segundos.",
        "/app/plans"
      );
    }
    return flashAndRedirect(req, res, "error", "No se pudo iniciar el pago. Intenta nuevamente.", "/app/plans");
  }
});

app.get("/app/business", requireAuth, (req, res) => {
  const business = getBusinessByUserId(req.session.user.id);
  ensureBusinessHoursRows(business.id);
  res.render("app/business", {
    title: "Mi comercio | Windi Menu",
    business,
    activePage: "business",
    menuUrl: `${BASE_URL}/${business.slug}`,
  });
});

app.post(
  "/app/business",
  requireAuth,
  upload.fields([
    { name: "logo_file", maxCount: 1 },
    { name: "cover_file", maxCount: 1 },
  ]),
  (req, res) => {
    const business = getBusinessByUserId(req.session.user.id);
    if (!business) return flashAndRedirect(req, res, "error", "Comercio no encontrado.", "/app");

    const body = req.body;
    const desiredSlug = slugify(body.slug || business.slug);
    if (!desiredSlug) {
      return flashAndRedirect(req, res, "error", "El slug no es valido.", "/app/business");
    }

    const existingSlug = db
      .prepare("SELECT id FROM businesses WHERE slug = ? AND id != ?")
      .get(desiredSlug, business.id);
    if (existingSlug) {
      return flashAndRedirect(req, res, "error", "Ese slug ya esta en uso.", "/app/business");
    }

    const logoPath = req.files?.logo_file?.[0]?.filename
      ? `/uploads/${req.files.logo_file[0].filename}`
      : null;
    const coverPath = req.files?.cover_file?.[0]?.filename
      ? `/uploads/${req.files.cover_file[0].filename}`
      : null;

    db.prepare(
      `UPDATE businesses
       SET business_name = ?, slug = ?, logo_url = ?, cover_url = ?, whatsapp = ?, address = ?,
           hours = ?, instagram = ?, payment_methods = ?, primary_color = ?, shipping_fee = ?, transfer_instructions = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(
      String(body.business_name || "").trim() || business.business_name,
      desiredSlug,
      logoPath || String(body.logo_url || "").trim() || null,
      coverPath || String(body.cover_url || "").trim() || null,
      String(body.whatsapp || "").trim(),
      String(body.address || "").trim() || null,
      String(body.hours || "").trim() || null,
      String(body.instagram || "").trim() || null,
      String(body.payment_methods || "").trim() || null,
      String(body.primary_color || "").trim() || null,
      Math.max(0, Number(body.shipping_fee || 0)),
      String(body.transfer_instructions || "").trim() || null,
      business.id
    );

    return flashAndRedirect(req, res, "success", "Datos del comercio actualizados.", "/app/business");
  }
);

app.get("/app/delivery-settings", requireAuth, (req, res) => {
  const business = getBusinessByUserId(req.session.user.id);
  res.render("app/delivery-settings", {
    title: "Configuracion delivery | Windi Menu",
    business,
    activePage: "delivery-settings",
  });
});

app.post("/app/delivery-settings", requireAuth, (req, res) => {
  const business = getBusinessByUserId(req.session.user.id);
  const deliveryEnabled = req.body.delivery_enabled ? 1 : 0;
  const pickupEnabled = req.body.pickup_enabled ? 1 : 0;

  if (!deliveryEnabled && !pickupEnabled) {
    return flashAndRedirect(
      req,
      res,
      "error",
      "Debes habilitar al menos una opcion: envio o retiro.",
      "/app/delivery-settings"
    );
  }

  db.prepare(
    `UPDATE businesses
     SET delivery_enabled = ?, pickup_enabled = ?, minimum_order_amount = ?,
         free_delivery_over_amount = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(
    deliveryEnabled,
    pickupEnabled,
    req.body.minimum_order_amount ? Math.max(0, Number(req.body.minimum_order_amount)) : null,
    req.body.free_delivery_over_amount ? Math.max(0, Number(req.body.free_delivery_over_amount)) : null,
    business.id
  );

  return flashAndRedirect(req, res, "success", "Configuracion de delivery guardada.", "/app/delivery-settings");
});

app.get("/app/business-hours", requireAuth, (req, res) => {
  const business = getBusinessByUserId(req.session.user.id);
  ensureBusinessHoursRows(business.id);
  const hours = getBusinessHours(business.id);

  res.render("app/business-hours", {
    title: "Horarios y estado | Windi Menu",
    business,
    hours,
    activePage: "business-hours",
  });
});

app.post("/app/business-hours", requireAuth, (req, res) => {
  const business = getBusinessByUserId(req.session.user.id);
  ensureBusinessHoursRows(business.id);
  const body = req.body;

  db.prepare(
    `UPDATE businesses
     SET is_temporarily_closed = ?, temporary_closed_message = ?, timezone = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(
    body.is_temporarily_closed ? 1 : 0,
    String(body.temporary_closed_message || "").trim() || null,
    String(body.timezone || "").trim() || "America/Argentina/Ushuaia",
    business.id
  );

  const updateHour = db.prepare(
    `UPDATE business_hours
     SET is_open = ?, open_time = ?, close_time = ?, updated_at = CURRENT_TIMESTAMP
     WHERE business_id = ? AND day_of_week = ?`
  );

  for (let day = 0; day <= 6; day += 1) {
    const isOpen = body[`is_open_${day}`] ? 1 : 0;
    const openTime = String(body[`open_time_${day}`] || "").trim() || null;
    const closeTime = String(body[`close_time_${day}`] || "").trim() || null;
    updateHour.run(isOpen, openTime, closeTime, business.id, day);
  }

  return flashAndRedirect(req, res, "success", "Horarios actualizados.", "/app/business-hours");
});

app.get("/app/categories", requireAuth, (req, res) => {
  const business = getBusinessByUserId(req.session.user.id);
  const categories = db
    .prepare("SELECT * FROM categories WHERE business_id = ? ORDER BY sort_order ASC, id ASC")
    .all(business.id);

  res.render("app/categories", {
    title: "Categorias | Windi Menu",
    business,
    categories,
    activePage: "categories",
  });
});

app.post("/app/categories", requireAuth, (req, res) => {
  const business = getBusinessByUserId(req.session.user.id);
  const name = String(req.body.name || "").trim();
  const sortOrder = Number(req.body.sort_order || 0);
  if (!name) {
    return flashAndRedirect(req, res, "error", "El nombre de categoria es obligatorio.", "/app/categories");
  }
  db.prepare("INSERT INTO categories (business_id, name, sort_order) VALUES (?, ?, ?)").run(
    business.id,
    name,
    sortOrder
  );
  return flashAndRedirect(req, res, "success", "Categoria creada.", "/app/categories");
});

app.post("/app/categories/:id/update", requireAuth, (req, res) => {
  const business = getBusinessByUserId(req.session.user.id);
  const categoryId = Number(req.params.id);
  const category = db
    .prepare("SELECT * FROM categories WHERE id = ? AND business_id = ?")
    .get(categoryId, business.id);
  if (!category) return flashAndRedirect(req, res, "error", "Categoria no encontrada.", "/app/categories");

  const name = String(req.body.name || "").trim();
  const sortOrder = Number(req.body.sort_order || 0);
  if (!name) return flashAndRedirect(req, res, "error", "El nombre es obligatorio.", "/app/categories");

  db.prepare("UPDATE categories SET name = ?, sort_order = ? WHERE id = ?").run(name, sortOrder, categoryId);
  return flashAndRedirect(req, res, "success", "Categoria actualizada.", "/app/categories");
});

app.post("/app/categories/:id/delete", requireAuth, (req, res) => {
  const business = getBusinessByUserId(req.session.user.id);
  const categoryId = Number(req.params.id);
  const category = db
    .prepare("SELECT * FROM categories WHERE id = ? AND business_id = ?")
    .get(categoryId, business.id);
  if (!category) return flashAndRedirect(req, res, "error", "Categoria no encontrada.", "/app/categories");

  db.prepare("UPDATE products SET category_id = NULL WHERE category_id = ? AND business_id = ?").run(
    categoryId,
    business.id
  );
  db.prepare("DELETE FROM categories WHERE id = ?").run(categoryId);
  return flashAndRedirect(req, res, "success", "Categoria eliminada.", "/app/categories");
});

app.get("/app/delivery-zones", requireAuth, (req, res) => {
  const business = getBusinessByUserId(req.session.user.id);
  const zones = db
    .prepare(
      "SELECT * FROM delivery_zones WHERE business_id = ? ORDER BY sort_order ASC, id ASC"
    )
    .all(business.id);

  res.render("app/delivery-zones", {
    title: "Zonas de envio | Windi Menu",
    business,
    zones,
    activePage: "delivery-zones",
  });
});

app.post("/app/delivery-zones", requireAuth, (req, res) => {
  const business = getBusinessByUserId(req.session.user.id);
  const name = String(req.body.name || "").trim();
  if (!name) {
    return flashAndRedirect(req, res, "error", "El nombre de zona es obligatorio.", "/app/delivery-zones");
  }
  const duplicated = db
    .prepare("SELECT id FROM delivery_zones WHERE business_id = ? AND LOWER(name) = LOWER(?)")
    .get(business.id, name);
  if (duplicated) {
    return flashAndRedirect(req, res, "error", "Ya existe una zona con ese nombre.", "/app/delivery-zones");
  }

  db.prepare(
    `INSERT INTO delivery_zones
      (business_id, name, price, is_active, sort_order, minimum_order_amount, free_delivery_over_amount, estimated_time_min, estimated_time_max, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  ).run(
    business.id,
    name,
    Math.max(0, Number(req.body.price || 0)),
    req.body.is_active ? 1 : 0,
    Number(req.body.sort_order || 0),
    req.body.minimum_order_amount ? Math.max(0, Number(req.body.minimum_order_amount)) : null,
    req.body.free_delivery_over_amount ? Math.max(0, Number(req.body.free_delivery_over_amount)) : null,
    req.body.estimated_time_min ? Math.max(0, Number(req.body.estimated_time_min)) : null,
    req.body.estimated_time_max ? Math.max(0, Number(req.body.estimated_time_max)) : null
  );

  return flashAndRedirect(req, res, "success", "Zona creada.", "/app/delivery-zones");
});

app.post("/app/delivery-zones/:id/update", requireAuth, (req, res) => {
  const business = getBusinessByUserId(req.session.user.id);
  const zoneId = Number(req.params.id);
  const zone = db
    .prepare("SELECT * FROM delivery_zones WHERE id = ? AND business_id = ?")
    .get(zoneId, business.id);
  if (!zone) return flashAndRedirect(req, res, "error", "Zona no encontrada.", "/app/delivery-zones");

  const name = String(req.body.name || "").trim();
  if (!name) return flashAndRedirect(req, res, "error", "El nombre es obligatorio.", "/app/delivery-zones");
  const duplicated = db
    .prepare("SELECT id FROM delivery_zones WHERE business_id = ? AND LOWER(name) = LOWER(?) AND id <> ?")
    .get(business.id, name, zoneId);
  if (duplicated) {
    return flashAndRedirect(req, res, "error", "Ya existe una zona con ese nombre.", "/app/delivery-zones");
  }

  db.prepare(
    `UPDATE delivery_zones
     SET name = ?, price = ?, is_active = ?, sort_order = ?, minimum_order_amount = ?,
         free_delivery_over_amount = ?, estimated_time_min = ?, estimated_time_max = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(
    name,
    Math.max(0, Number(req.body.price || 0)),
    req.body.is_active ? 1 : 0,
    Number(req.body.sort_order || 0),
    req.body.minimum_order_amount ? Math.max(0, Number(req.body.minimum_order_amount)) : null,
    req.body.free_delivery_over_amount ? Math.max(0, Number(req.body.free_delivery_over_amount)) : null,
    req.body.estimated_time_min ? Math.max(0, Number(req.body.estimated_time_min)) : null,
    req.body.estimated_time_max ? Math.max(0, Number(req.body.estimated_time_max)) : null,
    zoneId
  );

  return flashAndRedirect(req, res, "success", "Zona actualizada.", "/app/delivery-zones");
});

app.post("/app/delivery-zones/:id/delete", requireAuth, (req, res) => {
  const business = getBusinessByUserId(req.session.user.id);
  const zoneId = Number(req.params.id);
  const zone = db
    .prepare("SELECT id FROM delivery_zones WHERE id = ? AND business_id = ?")
    .get(zoneId, business.id);
  if (!zone) return flashAndRedirect(req, res, "error", "Zona no encontrada.", "/app/delivery-zones");

  db.prepare("DELETE FROM delivery_zones WHERE id = ?").run(zoneId);
  return flashAndRedirect(req, res, "success", "Zona eliminada.", "/app/delivery-zones");
});

app.get("/app/payment-methods", requireAuth, (req, res) => {
  const business = getBusinessByUserId(req.session.user.id);
  res.render("app/payment-methods", {
    title: "Metodos de pago | Windi Menu",
    business,
    activePage: "payment-methods",
  });
});

app.post("/app/payment-methods", requireAuth, (req, res) => {
  const business = getBusinessByUserId(req.session.user.id);
  const cash = req.body.payment_cash_enabled ? 1 : 0;
  const transfer = req.body.payment_transfer_enabled ? 1 : 0;
  const card = req.body.payment_card_enabled ? 1 : 0;
  const transferAlias = String(req.body.transfer_alias || "").trim() || null;
  const transferCvu = String(req.body.transfer_cvu || "").trim() || null;
  const transferAccountHolder = String(req.body.transfer_account_holder || "").trim() || null;
  const cashAllowChange = req.body.cash_allow_change ? 1 : 0;

  if (!cash && !transfer && !card) {
    return flashAndRedirect(
      req,
      res,
      "error",
      "Debes mantener al menos un metodo de pago activo.",
      "/app/payment-methods"
    );
  }

  if (transfer && !transferAlias && !transferCvu) {
    return flashAndRedirect(
      req,
      res,
      "error",
      "Si Transferencia esta activa, debes cargar Alias o CVU.",
      "/app/payment-methods"
    );
  }

  db.prepare(
    `UPDATE businesses
     SET payment_cash_enabled = ?, payment_transfer_enabled = ?, payment_card_enabled = ?,
         transfer_alias = ?, transfer_cvu = ?, transfer_account_holder = ?, cash_allow_change = ?,
         transfer_instructions = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(
    cash,
    transfer,
    card,
    transferAlias,
    transferCvu,
    transferAccountHolder,
    cashAllowChange,
    String(req.body.transfer_instructions || "").trim() || null,
    business.id
  );

  return flashAndRedirect(req, res, "success", "Metodos de pago actualizados.", "/app/payment-methods");
});

app.get("/app/products", requireAuth, (req, res) => {
  const business = getBusinessByUserId(req.session.user.id);
  const q = String(req.query.q || "").trim();
  const category = Number(req.query.category || 0);

  const categories = db
    .prepare("SELECT * FROM categories WHERE business_id = ? ORDER BY sort_order ASC, id ASC")
    .all(business.id);

  let sql = `SELECT p.*, c.name AS category_name
             FROM products p
             LEFT JOIN categories c ON c.id = p.category_id
             WHERE p.business_id = ?`;
  const params = [business.id];

  if (q) {
    sql += " AND LOWER(p.name) LIKE ?";
    params.push(`%${q.toLowerCase()}%`);
  }
  if (category) {
    sql += " AND p.category_id = ?";
    params.push(category);
  }
  sql += " ORDER BY p.sort_order ASC, p.id ASC";

  const products = db.prepare(sql).all(...params);
  res.render("app/products", {
    title: "Productos | Windi Menu",
    business,
    categories,
    products,
    activePage: "products",
    filters: { q, category },
  });
});

app.get("/app/products/new", requireAuth, (req, res) => {
  const business = getBusinessByUserId(req.session.user.id);
  const categories = db
    .prepare("SELECT * FROM categories WHERE business_id = ? ORDER BY sort_order ASC, id ASC")
    .all(business.id);
  res.render("app/product-form", {
    title: "Nuevo producto | Windi Menu",
    business,
    categories,
    product: null,
    activePage: "products",
  });
});

app.post("/app/products", requireAuth, upload.single("image_file"), (req, res) => {
  const business = getBusinessByUserId(req.session.user.id);
  const limitCheck = canCreateProductForBusiness(business.id);
  if (!limitCheck.allowed) {
    return flashAndRedirect(
      req,
      res,
      "error",
      `Tu plan permite hasta ${limitCheck.maxProducts} productos. Actualiza tu plan para agregar mas.`,
      "/billing"
    );
  }
  const body = req.body;
  const name = String(body.name || "").trim();
  if (!name) return flashAndRedirect(req, res, "error", "El nombre es obligatorio.", "/app/products/new");

  const imagePath = req.file?.filename ? `/uploads/${req.file.filename}` : null;

  db.prepare(
    `INSERT INTO products
      (business_id, category_id, name, description, price, previous_price, image_url, is_featured, is_sold_out, is_visible, sort_order, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  ).run(
    business.id,
    body.category_id ? Number(body.category_id) : null,
    name,
    String(body.description || "").trim() || null,
    Number(body.price || 0),
    body.previous_price ? Number(body.previous_price) : null,
    imagePath || String(body.image_url || "").trim() || null,
    body.is_featured ? 1 : 0,
    body.is_sold_out ? 1 : 0,
    body.is_visible ? 1 : 0,
    Number(body.sort_order || 0)
  );
  return flashAndRedirect(req, res, "success", "Producto creado.", "/app/products");
});

app.get("/app/products/:id/edit", requireAuth, (req, res) => {
  const business = getBusinessByUserId(req.session.user.id);
  const productId = Number(req.params.id);
  const product = db
    .prepare("SELECT * FROM products WHERE id = ? AND business_id = ?")
    .get(productId, business.id);
  if (!product) return flashAndRedirect(req, res, "error", "Producto no encontrado.", "/app/products");

  const categories = db
    .prepare("SELECT * FROM categories WHERE business_id = ? ORDER BY sort_order ASC, id ASC")
    .all(business.id);

  res.render("app/product-form", {
    title: "Editar producto | Windi Menu",
    business,
    categories,
    product,
    activePage: "products",
  });
});

app.post("/app/products/:id/update", requireAuth, upload.single("image_file"), (req, res) => {
  const business = getBusinessByUserId(req.session.user.id);
  const productId = Number(req.params.id);
  const product = db
    .prepare("SELECT * FROM products WHERE id = ? AND business_id = ?")
    .get(productId, business.id);
  if (!product) return flashAndRedirect(req, res, "error", "Producto no encontrado.", "/app/products");

  const body = req.body;
  const name = String(body.name || "").trim();
  if (!name) return flashAndRedirect(req, res, "error", "El nombre es obligatorio.", `/app/products/${productId}/edit`);

  const imagePath = req.file?.filename ? `/uploads/${req.file.filename}` : null;

  db.prepare(
    `UPDATE products
     SET category_id = ?, name = ?, description = ?, price = ?, previous_price = ?, image_url = ?,
         is_featured = ?, is_sold_out = ?, is_visible = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(
    body.category_id ? Number(body.category_id) : null,
    name,
    String(body.description || "").trim() || null,
    Number(body.price || 0),
    body.previous_price ? Number(body.previous_price) : null,
    imagePath || String(body.image_url || "").trim() || product.image_url,
    body.is_featured ? 1 : 0,
    body.is_sold_out ? 1 : 0,
    body.is_visible ? 1 : 0,
    Number(body.sort_order || 0),
    productId
  );
  return flashAndRedirect(req, res, "success", "Producto actualizado.", "/app/products");
});

app.post("/app/products/:id/delete", requireAuth, (req, res) => {
  const business = getBusinessByUserId(req.session.user.id);
  const productId = Number(req.params.id);
  const product = db
    .prepare("SELECT id FROM products WHERE id = ? AND business_id = ?")
    .get(productId, business.id);
  if (!product) return flashAndRedirect(req, res, "error", "Producto no encontrado.", "/app/products");

  db.prepare("DELETE FROM products WHERE id = ?").run(productId);
  return flashAndRedirect(req, res, "success", "Producto eliminado.", "/app/products");
});

app.post("/app/products/:id/toggle-visible", requireAuth, (req, res) => {
  const business = getBusinessByUserId(req.session.user.id);
  const productId = Number(req.params.id);
  const product = db
    .prepare("SELECT is_visible FROM products WHERE id = ? AND business_id = ?")
    .get(productId, business.id);
  if (!product) return flashAndRedirect(req, res, "error", "Producto no encontrado.", "/app/products");
  db.prepare("UPDATE products SET is_visible = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(
    product.is_visible ? 0 : 1,
    productId
  );
  return res.redirect("/app/products");
});

app.post("/app/products/:id/toggle-soldout", requireAuth, (req, res) => {
  const business = getBusinessByUserId(req.session.user.id);
  const productId = Number(req.params.id);
  const product = db
    .prepare("SELECT is_sold_out FROM products WHERE id = ? AND business_id = ?")
    .get(productId, business.id);
  if (!product) return flashAndRedirect(req, res, "error", "Producto no encontrado.", "/app/products");
  db.prepare("UPDATE products SET is_sold_out = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(
    product.is_sold_out ? 0 : 1,
    productId
  );
  return res.redirect("/app/products");
});

app.post("/app/products/:id/duplicate", requireAuth, (req, res) => {
  const business = getBusinessByUserId(req.session.user.id);
  const limitCheck = canCreateProductForBusiness(business.id);
  if (!limitCheck.allowed) {
    return flashAndRedirect(
      req,
      res,
      "error",
      `Tu plan permite hasta ${limitCheck.maxProducts} productos. Actualiza tu plan para agregar mas.`,
      "/billing"
    );
  }
  const productId = Number(req.params.id);
  const product = db
    .prepare("SELECT * FROM products WHERE id = ? AND business_id = ?")
    .get(productId, business.id);
  if (!product) return flashAndRedirect(req, res, "error", "Producto no encontrado.", "/app/products");

  db.prepare(
    `INSERT INTO products
      (business_id, category_id, name, description, price, previous_price, image_url, is_featured, is_sold_out, is_visible, sort_order, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  ).run(
    product.business_id,
    product.category_id,
    `${product.name} (Copia)`,
    product.description,
    product.price,
    product.previous_price,
    product.image_url,
    product.is_featured,
    product.is_sold_out,
    product.is_visible,
    product.sort_order + 1
  );

  return flashAndRedirect(req, res, "success", "Producto duplicado.", "/app/products");
});

app.get("/app/preview", requireAuth, (req, res) => {
  const business = getBusinessByUserId(req.session.user.id);
  ensureBusinessHoursRows(business.id);
  const hours = getBusinessHours(business.id);
  const openStatus = businessOpenStatus(business, hours);
  const grouped = businessMenuData(business.id, { includeHidden: true });
  res.render("app/preview", {
    title: "Vista previa | Windi Menu",
    business,
    grouped,
    deliveryZones: getActiveDeliveryZones(business.id),
    paymentMethods: paymentMethodsForBusiness(business),
    openStatus,
    activePage: "preview",
    menuUrl: `${BASE_URL}/${business.slug}`,
  });
});

app.get("/app/qr", requireAuth, async (req, res) => {
  const business = getBusinessByUserId(req.session.user.id);
  const menuUrl = `${BASE_URL}/${business.slug}`;
  const qrDataUrl = await QRCode.toDataURL(menuUrl, { width: 380, margin: 1 });

  res.render("app/qr", {
    title: "QR del menu | Windi Menu",
    business,
    activePage: "qr",
    menuUrl,
    qrDataUrl,
  });
});

app.get("/app/qr/download", requireAuth, async (req, res) => {
  const business = getBusinessByUserId(req.session.user.id);
  const menuUrl = `${BASE_URL}/${business.slug}`;
  const pngBuffer = await QRCode.toBuffer(menuUrl, { width: 800, margin: 1 });

  res.setHeader("Content-Type", "image/png");
  res.setHeader("Content-Disposition", `attachment; filename="qr-${business.slug}.png"`);
  res.send(pngBuffer);
});

app.get("/afiliados/panel", (req, res) => {
  const userId = resolveAffiliateUserIdForRequest(req);
  if (!userId) return flashAndRedirect(req, res, "error", "No hay afiliados registrados.", "/admin/affiliates");
  const affiliate = affiliateProfileByUserId(userId);
  if (!affiliate) return flashAndRedirect(req, res, "error", "Perfil de afiliado no encontrado.", "/admin/affiliates");

  const referrals = db
    .prepare("SELECT COUNT(*) AS total FROM businesses WHERE affiliate_id = ?")
    .get(affiliate.id).total;
  const byStatus = db
    .prepare(
      `SELECT status, COUNT(*) AS total, COALESCE(SUM(commission_amount),0) AS amount
       FROM affiliate_sales
       WHERE affiliate_id = ?
       GROUP BY status`
    )
    .all(affiliate.id);
  const statusMap = {};
  for (const row of byStatus) statusMap[row.status] = row;

  const approvedUnpaid = db
    .prepare(
      `SELECT COALESCE(SUM(commission_amount),0) AS total
       FROM affiliate_sales
       WHERE affiliate_id = ? AND status = 'APPROVED' AND payout_id IS NULL`
    )
    .get(affiliate.id).total;
  const pendingApproval = db
    .prepare(
      `SELECT COALESCE(SUM(commission_amount),0) AS total
       FROM affiliate_sales
       WHERE affiliate_id = ? AND status = 'PENDING'`
    )
    .get(affiliate.id).total;
  const lastSales = db
    .prepare(
      `SELECT s.*, b.business_name, p.name AS plan_name
       FROM affiliate_sales s
       LEFT JOIN businesses b ON b.id = s.business_id
       LEFT JOIN plans p ON p.id = s.plan_id
       WHERE s.affiliate_id = ?
       ORDER BY s.created_at DESC
       LIMIT 10`
    )
    .all(affiliate.id);
  const payouts = db
    .prepare(
      `SELECT * FROM affiliate_payouts
       WHERE affiliate_id = ?
       ORDER BY created_at DESC
       LIMIT 10`
    )
    .all(affiliate.id);

  const pendingForPayout = Math.max(0, Number(approvedUnpaid) - Number(affiliate.negative_balance || 0));

  res.render("affiliate/dashboard", {
    title: "Panel Afiliado | Windi Menu",
    robots: "noindex,nofollow",
    affiliate,
    referrals,
    statusMap,
    pendingApproval,
    pendingForPayout,
    payouts,
    lastSales,
    baseUrl: BASE_URL,
  });
});

app.get("/afiliados/ventas", (req, res) => {
  const userId = resolveAffiliateUserIdForRequest(req);
  if (!userId) return flashAndRedirect(req, res, "error", "No hay afiliados registrados.", "/admin/affiliates");
  const affiliate = affiliateProfileByUserId(userId);
  if (!affiliate) return flashAndRedirect(req, res, "error", "Perfil de afiliado no encontrado.", "/admin/affiliates");

  const status = String(req.query.status || "").trim().toUpperCase();
  const dateFrom = String(req.query.date_from || "").trim();
  const dateTo = String(req.query.date_to || "").trim();
  let sql = `
    SELECT s.*, b.business_name, p.name AS plan_name
    FROM affiliate_sales s
    LEFT JOIN businesses b ON b.id = s.business_id
    LEFT JOIN plans p ON p.id = s.plan_id
    WHERE s.affiliate_id = ?`;
  const params = [affiliate.id];
  if (status) {
    sql += " AND s.status = ?";
    params.push(status);
  }
  if (dateFrom) {
    sql += " AND date(s.created_at) >= date(?)";
    params.push(dateFrom);
  }
  if (dateTo) {
    sql += " AND date(s.created_at) <= date(?)";
    params.push(dateTo);
  }
  sql += " ORDER BY s.created_at DESC";

  const sales = db.prepare(sql).all(...params);
  const totalsByStatus = db
    .prepare(
      `SELECT status, COUNT(*) AS total, COALESCE(SUM(commission_amount), 0) AS commission
       FROM affiliate_sales
       WHERE affiliate_id = ?
       GROUP BY status`
    )
    .all(affiliate.id);

  res.render("affiliate/sales", {
    title: "Ventas afiliado | Windi Menu",
    robots: "noindex,nofollow",
    affiliate,
    sales,
    totalsByStatus,
    filters: { status, date_from: dateFrom, date_to: dateTo },
  });
});

app.get("/afiliados/referidos", (req, res) => {
  const userId = resolveAffiliateUserIdForRequest(req);
  if (!userId) return flashAndRedirect(req, res, "error", "No hay afiliados registrados.", "/admin/affiliates");
  const affiliate = affiliateProfileByUserId(userId);
  if (!affiliate) return flashAndRedirect(req, res, "error", "Perfil de afiliado no encontrado.", "/admin/affiliates");

  const q = String(req.query.q || "").trim().toLowerCase();
  let sql = `
      SELECT b.*, u.email AS owner_email, u.full_name AS owner_name,
             p.display_name AS plan_name
      FROM businesses b
      JOIN users u ON u.id = b.user_id
      LEFT JOIN plans p ON p.id = b.plan_id
      WHERE b.affiliate_id = ?`;
  const params = [affiliate.id];
  if (q) {
    sql += " AND (LOWER(b.business_name) LIKE ? OR LOWER(u.full_name) LIKE ? OR LOWER(u.email) LIKE ?)";
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  sql += " ORDER BY b.referred_at DESC, b.created_at DESC";
  const referrals = db.prepare(sql).all(...params);

  res.render("affiliate/referrals", {
    title: "Comercios referidos | Windi Menu",
    robots: "noindex,nofollow",
    affiliate,
    referrals,
    filters: { q },
  });
});

app.get("/afiliados/pagos", (req, res) => {
  const userId = resolveAffiliateUserIdForRequest(req);
  if (!userId) return flashAndRedirect(req, res, "error", "No hay afiliados registrados.", "/admin/affiliates");
  const affiliate = affiliateProfileByUserId(userId);
  if (!affiliate) return flashAndRedirect(req, res, "error", "Perfil de afiliado no encontrado.", "/admin/affiliates");

  const payouts = db
    .prepare(
      `SELECT *
       FROM affiliate_payouts
       WHERE affiliate_id = ?
       ORDER BY created_at DESC`
    )
    .all(affiliate.id);
  const approvedUnpaid = db
    .prepare(
      `SELECT COALESCE(SUM(commission_amount),0) AS total
       FROM affiliate_sales
       WHERE affiliate_id = ? AND status = 'APPROVED' AND payout_id IS NULL`
    )
    .get(affiliate.id).total;
  const pendingForPayout = Math.max(0, Number(approvedUnpaid) - Number(affiliate.negative_balance || 0));

  res.render("affiliate/payouts", {
    title: "Pagos afiliado | Windi Menu",
    robots: "noindex,nofollow",
    affiliate,
    payouts,
    pendingForPayout,
  });
});

app.get("/affiliate/dashboard", (_req, res) => res.redirect("/afiliados/panel"));
app.get("/affiliate/sales", (_req, res) => res.redirect("/afiliados/ventas"));
app.get("/affiliate/referrals", (_req, res) => res.redirect("/afiliados/referidos"));

app.get("/admin", requireRole("ADMIN"), (_req, res) => {
  res.redirect("/admin/affiliate-sales");
});

app.get("/admin/legal-consents", requireRole("ADMIN"), (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.*, u.email, u.full_name
       FROM legal_consents c
       JOIN users u ON u.id = c.user_id
       ORDER BY c.accepted_at DESC, c.id DESC
       LIMIT 500`
    )
    .all();
  res.render("admin/legal-consents", {
    title: "Consentimientos legales | Windi Menu",
    rows,
    legal: LEGAL_VERSIONS,
  });
});

app.get("/admin/legal-consents.csv", requireRole("ADMIN"), (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.*, u.email, u.full_name
       FROM legal_consents c
       JOIN users u ON u.id = c.user_id
       ORDER BY c.accepted_at DESC, c.id DESC
       LIMIT 5000`
    )
    .all();
  const header = [
    "id",
    "user_id",
    "email",
    "full_name",
    "role",
    "terms_version",
    "privacy_version",
    "accepted_at",
    "ip_address",
    "user_agent",
    "source",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    const values = [
      row.id,
      row.user_id,
      row.email,
      row.full_name,
      row.role,
      row.terms_version,
      row.privacy_version,
      row.accepted_at,
      row.ip_address || "",
      row.user_agent || "",
      row.source || "",
    ].map((value) => `"${String(value).replace(/"/g, '""')}"`);
    lines.push(values.join(","));
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=legal-consents.csv");
  return res.send(lines.join("\n"));
});

app.get("/admin/affiliates", requireRole("ADMIN"), (req, res) => {
  const affiliates = db
    .prepare(
      `SELECT a.*, u.full_name, u.email,
              (SELECT COUNT(*) FROM businesses b WHERE b.affiliate_id = a.id) AS referrals_count
       FROM affiliates a
       JOIN users u ON u.id = a.user_id
       ORDER BY a.created_at DESC`
    )
    .all();

  res.render("admin/affiliates", {
    title: "Admin afiliados | Windi Menu",
    affiliates,
  });
});

app.post("/admin/affiliates/:id/toggle-active", requireRole("ADMIN"), (req, res) => {
  const affiliateId = Number(req.params.id);
  const affiliate = db.prepare("SELECT * FROM affiliates WHERE id = ?").get(affiliateId);
  if (!affiliate) return flashAndRedirect(req, res, "error", "Afiliado no encontrado.", "/admin/affiliates");
  db.prepare("UPDATE affiliates SET is_active = ? WHERE id = ?").run(affiliate.is_active ? 0 : 1, affiliateId);
  return flashAndRedirect(req, res, "success", "Estado del afiliado actualizado.", "/admin/affiliates");
});

app.get("/admin/affiliate/:id", requireRole("ADMIN"), (req, res) => {
  const affiliateId = Number(req.params.id);
  const affiliate = db
    .prepare(
      `SELECT a.*, u.full_name, u.email
       FROM affiliates a
       JOIN users u ON u.id = a.user_id
       WHERE a.id = ?`
    )
    .get(affiliateId);
  if (!affiliate) return flashAndRedirect(req, res, "error", "Afiliado no encontrado.", "/admin/affiliates");

  const sales = db
    .prepare(
      `SELECT s.*, b.business_name, p.name AS plan_name
       FROM affiliate_sales s
       LEFT JOIN businesses b ON b.id = s.business_id
       LEFT JOIN plans p ON p.id = s.plan_id
       WHERE s.affiliate_id = ?
       ORDER BY s.created_at DESC`
    )
    .all(affiliate.id);

  const payouts = db
    .prepare("SELECT * FROM affiliate_payouts WHERE affiliate_id = ? ORDER BY created_at DESC")
    .all(affiliate.id);

  res.render("admin/affiliate-detail", {
    title: "Detalle afiliado | Windi Menu",
    affiliate,
    sales,
    payouts,
  });
});

app.get("/admin/affiliate-sales", requireRole("ADMIN"), (req, res) => {
  const status = String(req.query.status || "PENDING").trim().toUpperCase();
  const sales = db
    .prepare(
      `SELECT s.*, a.ref_code, b.business_name, p.name AS plan_name, u.full_name AS affiliate_name
       FROM affiliate_sales s
       JOIN affiliates a ON a.id = s.affiliate_id
       JOIN users u ON u.id = a.user_id
       LEFT JOIN businesses b ON b.id = s.business_id
       LEFT JOIN plans p ON p.id = s.plan_id
       WHERE (? = '' OR s.status = ?)
       ORDER BY s.created_at DESC`
    )
    .all(status === "ALL" ? "" : status, status === "ALL" ? "" : status);

  res.render("admin/affiliate-sales", {
    title: "Revision ventas afiliados | Windi Menu",
    sales,
    filterStatus: status,
  });
});

app.post("/admin/affiliate-sales/:id/approve", requireRole("ADMIN"), (req, res) => {
  const result = approveAffiliateSale(
    Number(req.params.id),
    req.session.user.id,
    String(req.body.review_note || "").trim() || null
  );
  if (!result.ok) return flashAndRedirect(req, res, "error", result.message, "/admin/affiliate-sales");
  return flashAndRedirect(req, res, "success", "Venta aprobada.", "/admin/affiliate-sales");
});

app.post("/admin/affiliate-sales/:id/reject", requireRole("ADMIN"), (req, res) => {
  const result = rejectAffiliateSale(
    Number(req.params.id),
    req.session.user.id,
    String(req.body.review_note || "").trim() || null
  );
  if (!result.ok) return flashAndRedirect(req, res, "error", result.message, "/admin/affiliate-sales");
  return flashAndRedirect(req, res, "success", "Venta rechazada.", "/admin/affiliate-sales");
});

app.post("/admin/affiliate-sales/:id/reverse", requireRole("ADMIN"), (req, res) => {
  const result = reverseAffiliateSale(
    Number(req.params.id),
    req.session.user.id,
    String(req.body.reverse_note || req.body.review_note || "").trim() || null
  );
  if (!result.ok) return flashAndRedirect(req, res, "error", result.message, "/admin/affiliate-sales?status=ALL");
  return flashAndRedirect(req, res, "success", "Venta revertida.", "/admin/affiliate-sales?status=ALL");
});

app.get("/admin/affiliate-payouts", requireRole("ADMIN"), (req, res) => {
  const now = new Date();
  const day = now.getUTCDay();
  const diffToMonday = (day + 6) % 7;
  const thisMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diffToMonday));
  const lastMonday = new Date(thisMonday);
  lastMonday.setUTCDate(thisMonday.getUTCDate() - 7);
  const lastSunday = new Date(thisMonday);
  lastSunday.setUTCDate(thisMonday.getUTCDate() - 1);

  const periodStart = String(req.query.period_start || lastMonday.toISOString().slice(0, 10));
  const periodEnd = String(req.query.period_end || lastSunday.toISOString().slice(0, 10));

  const affiliates = db
    .prepare(
      `SELECT a.*, u.full_name, u.email
       FROM affiliates a
       JOIN users u ON u.id = a.user_id
       WHERE a.is_active = 1
       ORDER BY u.full_name ASC`
    )
    .all();

  const payoutCandidates = affiliates.map((affiliate) => {
    const approved = db
      .prepare(
        `SELECT COALESCE(SUM(commission_amount),0) AS total
         FROM affiliate_sales
         WHERE affiliate_id = ? AND status = 'APPROVED' AND payout_id IS NULL
           AND date(created_at) BETWEEN date(?) AND date(?)`
      )
      .get(affiliate.id, periodStart, periodEnd).total;
    const debt = Number(affiliate.negative_balance || 0);
    const payable = Math.max(0, Number(approved) - debt);
    return { affiliate, approved: Number(approved), debt, payable };
  });

  const payouts = db
    .prepare(
      `SELECT p.*, u.full_name
       FROM affiliate_payouts p
       JOIN affiliates a ON a.id = p.affiliate_id
       JOIN users u ON u.id = a.user_id
       ORDER BY p.created_at DESC
       LIMIT 100`
    )
    .all();

  res.render("admin/affiliate-payouts", {
    title: "Payouts afiliados | Windi Menu",
    payoutCandidates,
    payouts,
    periodStart,
    periodEnd,
  });
});

app.post("/admin/affiliate-payouts/generate", requireRole("ADMIN"), (req, res) => {
  const affiliateId = Number(req.body.affiliate_id);
  const periodStart = String(req.body.period_start || "").trim();
  const periodEnd = String(req.body.period_end || "").trim();
  const method = String(req.body.method || "transfer").trim();
  const note = String(req.body.note || "").trim() || null;

  const affiliate = db.prepare("SELECT * FROM affiliates WHERE id = ?").get(affiliateId);
  if (!affiliate) return flashAndRedirect(req, res, "error", "Afiliado no encontrado.", "/admin/affiliate-payouts");

  const sales = db
    .prepare(
      `SELECT * FROM affiliate_sales
       WHERE affiliate_id = ? AND status = 'APPROVED' AND payout_id IS NULL
         AND date(created_at) BETWEEN date(?) AND date(?)
       ORDER BY created_at ASC`
    )
    .all(affiliateId, periodStart, periodEnd);

  if (!sales.length) {
    return flashAndRedirect(req, res, "error", "No hay ventas aprobadas para ese periodo.", "/admin/affiliate-payouts");
  }

  const approvedAmount = sales.reduce((sum, s) => sum + Number(s.commission_amount || 0), 0);
  const debt = Number(affiliate.negative_balance || 0);
  const amountPaid = Math.max(0, approvedAmount - debt);
  const debtAfter = Math.max(0, debt - approvedAmount);

  const tx = db.transaction(() => {
    const payoutId = db
      .prepare(
        `INSERT INTO affiliate_payouts
         (affiliate_id, period_start, period_end, amount_paid, method, note)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(affiliateId, periodStart, periodEnd, amountPaid, method, note).lastInsertRowid;

    const updateSale = db.prepare(
      `UPDATE affiliate_sales
       SET status = 'PAID', paid_at = CURRENT_TIMESTAMP, payout_id = ?
       WHERE id = ?`
    );
    for (const sale of sales) updateSale.run(payoutId, sale.id);

    db.prepare(
      `UPDATE affiliates
       SET total_commission_paid = total_commission_paid + ?, negative_balance = ?
       WHERE id = ?`
    ).run(amountPaid, debtAfter, affiliateId);
  });

  tx();
  return flashAndRedirect(req, res, "success", "Payout generado correctamente.", "/admin/affiliate-payouts");
});

app.get("/admin/plans", requireRole("ADMIN"), (req, res) => {
  const plans = db.prepare("SELECT * FROM plans ORDER BY price_ars ASC, id ASC").all();
  res.render("admin/plans", {
    title: "Planes | Windi Menu",
    plans,
  });
});

app.post("/admin/plans", requireRole("ADMIN"), (req, res) => {
  const code = String(req.body.code || "").trim().toUpperCase();
  const displayName = String(req.body.display_name || "").trim();
  const priceArs = normalizeMoneyValue(req.body.price_ars || req.body.price || 0);
  const maxProductsRaw = String(req.body.max_products ?? "").trim();
  const maxProducts = maxProductsRaw === "" ? null : Math.max(1, Number(maxProductsRaw));

  if (!code) return flashAndRedirect(req, res, "error", "El codigo del plan es obligatorio.", "/admin/plans");
  if (!displayName) return flashAndRedirect(req, res, "error", "El nombre del plan es obligatorio.", "/admin/plans");
  if (priceArs <= 0) return flashAndRedirect(req, res, "error", "El precio debe ser mayor a 0.", "/admin/plans");

  db.prepare(
    `INSERT INTO plans (code, display_name, name, price, price_ars, currency, max_products, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, 'ARS', ?, 1, CURRENT_TIMESTAMP)`
  ).run(code, displayName, displayName, priceArs, priceArs, Number.isFinite(maxProducts) ? maxProducts : null);
  return flashAndRedirect(req, res, "success", "Plan creado.", "/admin/plans");
});

app.post("/admin/plans/:id/update", requireRole("ADMIN"), (req, res) => {
  const planId = Number(req.params.id);
  const plan = db.prepare("SELECT * FROM plans WHERE id = ?").get(planId);
  if (!plan) return flashAndRedirect(req, res, "error", "Plan no encontrado.", "/admin/plans");

  const code = String(req.body.code || "").trim().toUpperCase();
  const displayName = String(req.body.display_name || "").trim();
  const priceArs = normalizeMoneyValue(req.body.price_ars || req.body.price || 0);
  const maxProductsRaw = String(req.body.max_products ?? "").trim();
  const maxProducts = maxProductsRaw === "" ? null : Math.max(1, Number(maxProductsRaw));

  if (!code) return flashAndRedirect(req, res, "error", "El codigo del plan es obligatorio.", "/admin/plans");
  if (!displayName) return flashAndRedirect(req, res, "error", "El nombre del plan es obligatorio.", "/admin/plans");
  if (priceArs <= 0) return flashAndRedirect(req, res, "error", "El precio debe ser mayor a 0.", "/admin/plans");

  db.prepare(
    `UPDATE plans
     SET code = ?, display_name = ?, name = ?, price = ?, price_ars = ?, currency = 'ARS', max_products = ?
     WHERE id = ?`
  ).run(code, displayName, displayName, priceArs, priceArs, Number.isFinite(maxProducts) ? maxProducts : null, planId);
  return flashAndRedirect(req, res, "success", "Plan actualizado.", "/admin/plans");
});

app.post("/admin/plans/:id/toggle-active", requireRole("ADMIN"), (req, res) => {
  const planId = Number(req.params.id);
  const plan = db.prepare("SELECT * FROM plans WHERE id = ?").get(planId);
  if (!plan) return flashAndRedirect(req, res, "error", "Plan no encontrado.", "/admin/plans");
  db.prepare("UPDATE plans SET is_active = ? WHERE id = ?").run(plan.is_active ? 0 : 1, planId);
  return flashAndRedirect(req, res, "success", "Estado del plan actualizado.", "/admin/plans");
});

app.get("/admin/subscriptions", requireRole("ADMIN"), (req, res) => {
  const businesses = db.prepare("SELECT id, business_name FROM businesses ORDER BY business_name").all();
  const plans = db
    .prepare("SELECT id, display_name AS name, price_ars AS price FROM plans WHERE is_active = 1 ORDER BY price_ars ASC")
    .all();
  const subscriptions = db
    .prepare(
      `SELECT s.*, b.business_name, p.display_name AS plan_name
       FROM subscriptions s
       JOIN businesses b ON b.id = s.business_id
       JOIN plans p ON p.id = s.plan_id
       ORDER BY s.created_at DESC
       LIMIT 100`
    )
    .all();

  res.render("admin/subscriptions", {
    title: "Admin suscripciones | Windi Menu",
    businesses,
    plans,
    subscriptions,
  });
});

app.post("/admin/subscriptions/create-paid", requireRole("ADMIN"), (req, res) => {
  const businessId = Number(req.body.business_id);
  const planId = Number(req.body.plan_id);
  const amount = Math.max(0, Number(req.body.amount || 0));

  const business = db.prepare("SELECT * FROM businesses WHERE id = ?").get(businessId);
  const plan = db.prepare("SELECT * FROM plans WHERE id = ?").get(planId);
  if (!business || !plan) {
    return flashAndRedirect(req, res, "error", "Business o plan invalido.", "/admin/subscriptions");
  }

  const subscriptionId = db
    .prepare(
      `INSERT INTO subscriptions
       (business_id, plan_id, amount, status, current_period_start, current_period_end, paid_at, updated_at)
       VALUES (?, ?, ?, 'ACTIVE', CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run(businessId, planId, amount || normalizeMoneyValue(plan.price_ars ?? plan.price), plusDaysIso(30)).lastInsertRowid;

  db.prepare(
    `UPDATE businesses
     SET plan_id = ?, has_completed_onboarding = 1, onboarding_step = 'done', updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(planId, businessId);

  ensurePendingAffiliateSaleForSubscription(subscriptionId);
  return flashAndRedirect(req, res, "success", "Suscripcion pagada registrada.", "/admin/subscriptions");
});

app.post("/admin/subscriptions/:id/mark-paid", requireRole("ADMIN"), (req, res) => {
  const subscriptionId = Number(req.params.id);
  const subscription = db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(subscriptionId);
  if (!subscription) {
    return flashAndRedirect(req, res, "error", "Suscripcion no encontrada.", "/admin/subscriptions");
  }
  db.prepare(
    "UPDATE subscriptions SET status = 'ACTIVE', paid_at = CURRENT_TIMESTAMP, current_period_start = COALESCE(current_period_start, CURRENT_TIMESTAMP), current_period_end = COALESCE(current_period_end, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(plusDaysIso(30), subscriptionId);
  db.prepare(
    `UPDATE businesses
     SET plan_id = ?, has_completed_onboarding = 1, onboarding_step = 'done', updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(subscription.plan_id, subscription.business_id);
  ensurePendingAffiliateSaleForSubscription(subscriptionId);
  return flashAndRedirect(req, res, "success", "Suscripcion marcada como pagada.", "/admin/subscriptions");
});

app.get("/:slug", async (req, res, next) => {
  const slug = req.params.slug;
  const reserved = new Set([
    "app",
    "admin",
    "affiliate",
    "afiliados",
    "panel",
    "billing",
    "onboarding",
    "api",
    "login",
    "register",
    "registro",
    "forgot-password",
    "precios",
    "faq",
    "soporte",
    "contacto",
    "demo",
    "como-funciona",
    "status",
    "terminos",
    "privacidad",
    "cookies",
    "reembolsos",
    "legal",
    "mi-cuenta",
    "r",
    "public",
    "uploads",
    "favicon.ico",
  ]);
  if (reserved.has(slug)) return next();

  if (RUNTIME_SYNC && HAS_SUPABASE_DB) {
    try {
      await withTimeout(pullMirrorNow(), 1800);
    } catch (_error) {
      // Fallback to local snapshot if mirror pull is delayed.
    }
  }

  const business = db.prepare("SELECT * FROM businesses WHERE slug = ?").get(slug);
  if (!business) return next();

  ensureBusinessHoursRows(business.id);
  const hours = getBusinessHours(business.id);
  const openStatus = businessOpenStatus(business, hours);
  const grouped = businessMenuData(business.id);
  const deliveryZones = getActiveDeliveryZones(business.id);
  const paymentMethods = paymentMethodsForBusiness(business);

  res.render("public-menu", {
    title: `${business.business_name} | Menu digital`,
    business,
    grouped,
    deliveryZones,
    paymentMethods,
    openStatus,
    previewMode: false,
  });
});

app.use((_req, res) => {
  res.status(404).render("404", {
    title: "Pagina no encontrada | Windi Menu",
    description: "No encontramos la pagina que buscas en Windi Menu.",
  });
});

let bootstrapPromise = null;
let pullTimer = null;

async function bootstrap() {
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    let adminChanged = false;
    let commerceChanged = false;
    if (RUNTIME_SYNC && HAS_SUPABASE_DB) {
      try {
        await applySupabaseSchema();
        await pullSupabaseToSqlite();
        console.log("Mirror pull inicial desde Supabase OK");
        const userCount = db.prepare("SELECT COUNT(*) AS total FROM users").get().total;
        if (!userCount) {
          createSeedData();
          await pushMirrorNow();
        }
        adminChanged = ensureRuntimeAdminAccounts();
        commerceChanged = ensureRuntimeCommerceAccounts();
        if (adminChanged || commerceChanged) {
          await pushMirrorNow();
        }
      } catch (error) {
        if (SUPABASE_PRIMARY) {
          throw new Error(`Modo SUPABASE_PRIMARY activo. No se puede iniciar sin Supabase: ${error.message}`);
        }
        console.error("Mirror pull inicial fallo, sigue con SQLite local:", error.message);
        const localUsers = db.prepare("SELECT COUNT(*) AS total FROM users").get().total;
        if (!localUsers) createSeedData();
        adminChanged = ensureRuntimeAdminAccounts();
        commerceChanged = ensureRuntimeCommerceAccounts();
      }
    } else {
      const localUsers = db.prepare("SELECT COUNT(*) AS total FROM users").get().total;
      if (!localUsers) createSeedData();
      adminChanged = ensureRuntimeAdminAccounts();
      commerceChanged = ensureRuntimeCommerceAccounts();
    }
    if (!RUNTIME_SYNC && (adminChanged || commerceChanged)) {
      // nothing else needed for local mode
    }
  })();

  try {
    await bootstrapPromise;
    return bootstrapPromise;
  } catch (error) {
    bootstrapPromise = null;
    throw error;
  }
}

async function bootstrapAndStart() {
  await bootstrap();
  app.listen(PORT, () => {
    console.log(`Windi Menu corriendo en ${BASE_URL}`);
    if (!IS_VERCEL && RUNTIME_SYNC && HAS_SUPABASE_DB && PULL_INTERVAL_MS > 0) {
      pullTimer = setInterval(() => {
        pullMirrorNow();
      }, PULL_INTERVAL_MS);
      console.log(`Mirror pull periodico activo cada ${PULL_INTERVAL_MS}ms`);
    }
  });
}

if (IS_VERCEL) {
  module.exports = app;
} else {
  bootstrapAndStart().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
