require("dotenv").config();

const path = require("path");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const QRCode = require("qrcode");

const { db, initDb } = require("./src/db");
const { createSeedData } = require("./src/seed");
const { requireAuth, requireRole } = require("./src/middleware/auth");
const { upload } = require("./src/middleware/upload");
const { slugify, uniqueSlug } = require("./src/utils/slug");
const { pushSqliteToSupabase, pullSupabaseToSqlite } = require("./src/sync/bridge");
const { applySupabaseSchema } = require("./src/sync/schema");

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

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use("/public", express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "windi-menu-local-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.flash = req.session.flash || null;
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

function flashAndRedirect(req, res, type, text, to) {
  req.session.flash = { type, text };
  return res.redirect(to);
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

function getBusinessByUserId(userId) {
  return db.prepare("SELECT * FROM businesses WHERE user_id = ?").get(userId);
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

async function createMercadoPagoPreference({ subscription, plan, business, user }) {
  if (!MP_ACCESS_TOKEN) {
    throw new Error("Mercado Pago no esta configurado.");
  }

  const payload = {
    items: [
      {
        title: `${plan.name} - ${business.business_name}`,
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
    },
    external_reference: subscription.external_reference,
    notification_url: MP_WEBHOOK_URL,
    back_urls: {
      success: `${BASE_URL}/app/plans?payment=success`,
      pending: `${BASE_URL}/app/plans?payment=pending`,
      failure: `${BASE_URL}/app/plans?payment=failure`,
    },
    auto_return: "approved",
  };

  const response = await fetch("https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Error Mercado Pago (${response.status}): ${text.slice(0, 180)}`);
  }

  return response.json();
}

async function getMercadoPagoPayment(paymentId) {
  if (!MP_ACCESS_TOKEN) throw new Error("Mercado Pago no esta configurado.");
  const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
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
  if (String(subscription.status).toLowerCase() !== "paid") return;
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
  res.render("landing", { title: "Windi Menu | Menu digital para tu comercio" });
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

app.post("/register", (req, res) => {
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
    `INSERT INTO businesses (user_id, business_name, slug, whatsapp, affiliate_id, referred_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userResult.lastInsertRowid, business_name.trim(), slug, whatsapp.trim(), affiliateId, referredAt);

  req.session.user = {
    id: userResult.lastInsertRowid,
    fullName: full_name.trim(),
    email: cleanEmail,
    role: "COMMERCE",
  };

  clearCookie(res, "windi_ref_code");

  return flashAndRedirect(req, res, "success", "Cuenta creada correctamente.", "/app");
});

app.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/app");
  res.render("auth-login", { title: "Iniciar sesion | Windi Menu" });
});

app.post("/login", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return flashAndRedirect(req, res, "error", "Email o clave invalidos.", "/login");
  }

  const role = user.role || "COMMERCE";
  req.session.user = { id: user.id, fullName: user.full_name, email: user.email, role };

  let target = "/app";
  if (role === "AFFILIATE") target = "/affiliate/dashboard";
  if (role === "ADMIN") target = "/admin/affiliate-sales";
  return flashAndRedirect(req, res, "success", "Sesion iniciada.", target);
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

app.get("/forgot-password", (_req, res) => {
  res.render("auth-forgot", { title: "Recuperar clave | Windi Menu" });
});

app.post("/webhooks/mercadopago", async (req, res) => {
  try {
    const queryPaymentId = req.query["data.id"] || req.query.id;
    const bodyPaymentId = req.body?.data?.id || req.body?.id;
    const paymentId = String(queryPaymentId || bodyPaymentId || "").trim();
    if (!paymentId) return res.status(200).json({ ok: true, ignored: true });

    const payment = await getMercadoPagoPayment(paymentId);
    const externalReference = String(payment.external_reference || "").trim();
    const providerStatus = String(payment.status || "").trim().toLowerCase();
    const amount = normalizeMoneyValue(payment.transaction_amount || 0);

    let subscription = null;
    if (externalReference) {
      subscription = db
        .prepare("SELECT * FROM subscriptions WHERE external_reference = ? ORDER BY id DESC LIMIT 1")
        .get(externalReference);
    }
    if (!subscription && payment.metadata?.subscription_id) {
      subscription = db
        .prepare("SELECT * FROM subscriptions WHERE id = ?")
        .get(Number(payment.metadata.subscription_id));
    }
    if (!subscription) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const paidAlready = String(subscription.status || "").toLowerCase() === "paid";
    let nextStatus = "pending";
    if (providerStatus === "approved") nextStatus = "paid";
    else if (["rejected", "cancelled", "refunded", "charged_back"].includes(providerStatus)) nextStatus = providerStatus;
    else if (providerStatus) nextStatus = "pending";

    db.prepare(
      `UPDATE subscriptions
       SET status = ?, provider_payment_id = ?, last_provider_status = ?, amount = ?,
           paid_at = CASE WHEN ? = 'paid' THEN COALESCE(paid_at, CURRENT_TIMESTAMP) ELSE paid_at END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(
      nextStatus,
      String(payment.id || paymentId),
      providerStatus || null,
      amount > 0 ? amount : normalizeMoneyValue(subscription.amount),
      nextStatus,
      subscription.id
    );

    if (!paidAlready && nextStatus === "paid") {
      ensurePendingAffiliateSaleForSubscription(subscription.id);
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Webhook Mercado Pago fallo:", error.message);
    return res.status(200).json({ ok: true });
  }
});

app.use("/app", requireRole("COMMERCE"));

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

app.get("/app/plans", requireAuth, (req, res) => {
  const business = getBusinessByUserId(req.session.user.id);
  const plans = db
    .prepare("SELECT id, name, price, is_active FROM plans WHERE is_active = 1 ORDER BY price ASC, id ASC")
    .all();

  const subscriptions = db
    .prepare(
      `SELECT s.*, p.name AS plan_name
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       WHERE s.business_id = ?
       ORDER BY s.created_at DESC
       LIMIT 20`
    )
    .all(business.id);

  const currentPaid = db
    .prepare(
      `SELECT s.*, p.name AS plan_name
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       WHERE s.business_id = ? AND LOWER(s.status) = 'paid'
       ORDER BY COALESCE(s.paid_at, s.created_at) DESC
       LIMIT 1`
    )
    .get(business.id);

  res.render("app/plans", {
    title: "Planes y facturacion | Windi Menu",
    business,
    plans,
    subscriptions,
    currentPaid,
    paymentState: String(req.query.payment || "").trim().toLowerCase(),
    activePage: "plans",
    mercadopagoReady: Boolean(MP_ACCESS_TOKEN),
  });
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

  const amount = normalizeMoneyValue(plan.price);
  const result = db
    .prepare(
      `INSERT INTO subscriptions
       (business_id, plan_id, amount, status, payment_provider, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 'mercadopago', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run(business.id, plan.id, amount);

  const subscriptionId = Number(result.lastInsertRowid);
  const externalReference = `SUB-${subscriptionId}-BIZ-${business.id}`;
  db.prepare("UPDATE subscriptions SET external_reference = ? WHERE id = ?").run(externalReference, subscriptionId);

  try {
    const preference = await createMercadoPagoPreference({
      subscription: { id: subscriptionId, amount, external_reference: externalReference },
      plan,
      business,
      user,
    });

    db.prepare(
      `UPDATE subscriptions
       SET provider_preference_id = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(String(preference.id || ""), subscriptionId);

    const checkoutUrl = preference.init_point || preference.sandbox_init_point;
    if (!checkoutUrl) {
      throw new Error("Mercado Pago no devolvio URL de checkout.");
    }

    return res.redirect(checkoutUrl);
  } catch (error) {
    console.error("Error creando checkout Mercado Pago:", error.message);
    db.prepare(
      `UPDATE subscriptions
       SET status = 'failed', last_provider_status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(error.message.slice(0, 255), subscriptionId);
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

app.get("/affiliate/dashboard", requireRole("AFFILIATE"), (req, res) => {
  const affiliate = db
    .prepare(
      `SELECT a.*, u.full_name
       FROM affiliates a
       JOIN users u ON u.id = a.user_id
       WHERE a.user_id = ?`
    )
    .get(req.session.user.id);
  if (!affiliate) return flashAndRedirect(req, res, "error", "Perfil de afiliado no encontrado.", "/");

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
    affiliate,
    referrals,
    statusMap,
    pendingApproval,
    pendingForPayout,
    payouts,
    baseUrl: BASE_URL,
  });
});

app.get("/affiliate/sales", requireRole("AFFILIATE"), (req, res) => {
  const affiliate = db.prepare("SELECT * FROM affiliates WHERE user_id = ?").get(req.session.user.id);
  if (!affiliate) return flashAndRedirect(req, res, "error", "Perfil de afiliado no encontrado.", "/");

  const status = String(req.query.status || "").trim().toUpperCase();
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
  sql += " ORDER BY s.created_at DESC";

  const sales = db.prepare(sql).all(...params);
  res.render("affiliate/sales", {
    title: "Ventas afiliado | Windi Menu",
    affiliate,
    sales,
    filters: { status },
  });
});

app.get("/affiliate/referrals", requireRole("AFFILIATE"), (req, res) => {
  const affiliate = db.prepare("SELECT * FROM affiliates WHERE user_id = ?").get(req.session.user.id);
  if (!affiliate) return flashAndRedirect(req, res, "error", "Perfil de afiliado no encontrado.", "/");

  const referrals = db
    .prepare(
      `SELECT b.*, u.email AS owner_email, u.full_name AS owner_name
       FROM businesses b
       JOIN users u ON u.id = b.user_id
       WHERE b.affiliate_id = ?
       ORDER BY b.referred_at DESC, b.created_at DESC`
    )
    .all(affiliate.id);

  res.render("affiliate/referrals", {
    title: "Comercios referidos | Windi Menu",
    affiliate,
    referrals,
  });
});

app.get("/admin", requireRole("ADMIN"), (_req, res) => {
  res.redirect("/admin/affiliate-sales");
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
  const plans = db.prepare("SELECT * FROM plans ORDER BY price ASC, id ASC").all();
  res.render("admin/plans", {
    title: "Planes | Windi Menu",
    plans,
  });
});

app.post("/admin/plans", requireRole("ADMIN"), (req, res) => {
  const name = String(req.body.name || "").trim();
  const price = normalizeMoneyValue(req.body.price || 0);
  if (!name) return flashAndRedirect(req, res, "error", "El nombre del plan es obligatorio.", "/admin/plans");
  if (price <= 0) return flashAndRedirect(req, res, "error", "El precio debe ser mayor a 0.", "/admin/plans");

  db.prepare("INSERT INTO plans (name, price, is_active, created_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP)").run(
    name,
    price
  );
  return flashAndRedirect(req, res, "success", "Plan creado.", "/admin/plans");
});

app.post("/admin/plans/:id/update", requireRole("ADMIN"), (req, res) => {
  const planId = Number(req.params.id);
  const plan = db.prepare("SELECT * FROM plans WHERE id = ?").get(planId);
  if (!plan) return flashAndRedirect(req, res, "error", "Plan no encontrado.", "/admin/plans");

  const name = String(req.body.name || "").trim();
  const price = normalizeMoneyValue(req.body.price || 0);
  if (!name) return flashAndRedirect(req, res, "error", "El nombre del plan es obligatorio.", "/admin/plans");
  if (price <= 0) return flashAndRedirect(req, res, "error", "El precio debe ser mayor a 0.", "/admin/plans");

  db.prepare("UPDATE plans SET name = ?, price = ? WHERE id = ?").run(name, price, planId);
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
  const plans = db.prepare("SELECT id, name, price FROM plans WHERE is_active = 1 ORDER BY price ASC").all();
  const subscriptions = db
    .prepare(
      `SELECT s.*, b.business_name, p.name AS plan_name
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
       (business_id, plan_id, amount, status, paid_at, updated_at)
       VALUES (?, ?, ?, 'paid', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run(businessId, planId, amount || plan.price).lastInsertRowid;

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
    "UPDATE subscriptions SET status = 'paid', paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(subscriptionId);
  ensurePendingAffiliateSaleForSubscription(subscriptionId);
  return flashAndRedirect(req, res, "success", "Suscripcion marcada como pagada.", "/admin/subscriptions");
});

app.get("/:slug", (req, res, next) => {
  const slug = req.params.slug;
  const reserved = new Set([
    "app",
    "admin",
    "affiliate",
    "login",
    "register",
    "registro",
    "forgot-password",
    "r",
    "public",
    "uploads",
    "favicon.ico",
  ]);
  if (reserved.has(slug)) return next();

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
  res.status(404).render("404", { title: "Pagina no encontrada | Windi Menu" });
});

let bootstrapPromise = null;
let pullTimer = null;

async function bootstrap() {
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
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
    } catch (error) {
      if (SUPABASE_PRIMARY) {
        throw new Error(`Modo SUPABASE_PRIMARY activo. No se puede iniciar sin Supabase: ${error.message}`);
      }
      console.error("Mirror pull inicial fallo, sigue con SQLite local:", error.message);
      const localUsers = db.prepare("SELECT COUNT(*) AS total FROM users").get().total;
      if (!localUsers) createSeedData();
    }
  } else {
    const localUsers = db.prepare("SELECT COUNT(*) AS total FROM users").get().total;
    if (!localUsers) createSeedData();
  }
  })();

  return bootstrapPromise;
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
  bootstrap().catch((error) => {
    console.error(error.message);
  });
  module.exports = app;
} else {
  bootstrapAndStart().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
