# CHANGELOG

## 2026-02-20 - QA + Stabilization Pass

### Bugs encontrados y corregidos

1. Redirect loops en login/onboarding (`ERR_TOO_MANY_REDIRECTS`).
- Causa: rutas `/login` y `/onboarding/*` redirigiendo entre si cuando faltaba `business`.
- Fix: guard robusto + pantalla de provisioning + auto-repair de `business` faltante.
- Archivos: `server.js`.

2. Onboarding intermitente en Vercel para cuentas nuevas (`Estamos preparando tu comercio` infinito).
- Causa: desfasaje entre instancias serverless y sincronizacion SQLite/Supabase.
- Fix: push inmediato post-registro, pull corto bloqueante en lookup critico y autocreacion de `business` si faltaba.
- Archivos: `server.js`.

3. Checkout de planes desde panel con `subscription_id` temporal (riesgo de webhook huerfano).
- Causa: preferencia MP generada antes de tener `subscription_id` real.
- Fix: crear/actualizar suscripcion pendiente primero y usar IDs reales en `external_reference`/metadata.
- Archivos: `server.js`.

4. Layout roto en panel comercio (sidebar ocupando ~90% y contenido ~10%).
- Causa: `.sidebar-overlay` participaba en layout desktop.
- Fix: ocultar overlay por defecto y usarlo solo en mobile con `sidebar-open`.
- Archivos: `public/css/styles.css`.

5. UX congelada en onboarding plan (`Preparando checkout`).
- Causa: botón no recuperaba estado en errores/timeout.
- Fix: timeout fetch + restore botón + error inline + fallback `plan_id`.
- Archivos: `views/onboarding/plan.ejs`, `server.js`.

6. Estados de suscripcion inconsistentes (`paid` vs `ACTIVE`) en distintos flujos.
- Fix: normalizacion de estados en guards/consultas + compatibilidad legacy.
- Archivos: `server.js`.

7. Falta de scripts de control (`build/lint/test`) para verificacion sistematica.
- Fix: scripts agregados + smoke test automatizado.
- Archivos: `package.json`, `scripts/smoke-test.js`.

8. Migraciones incompletas para onboarding/paywall y pagos.
- Fix: schema/migraciones para `payments`, campos onboarding y planes extendidos.
- Archivos: `src/db.js`, `supabase/schema.sql`, `src/sync/bridge.js`, `src/seed.js`.

### Checklist de pantallas probadas (resultado)

- Landing (`/`): OK
- Login (`/login`): OK
- Register (`/register`): OK
- Onboarding welcome (`/onboarding/welcome`): OK
- Onboarding plan (`/onboarding/plan`): OK
- Public menu demo (`/pizzeria9420`): OK
- Admin redirect (`/admin` con admin): OK
- Smoke flow registro nuevo -> onboarding plan: OK

### Validaciones automáticas ejecutadas

- `npm install`: OK
- `npm run build`: OK
- `npm run lint`: OK
- `npm test`: OK (`Smoke test OK`)

### Archivos tocados en esta pasada

- `server.js`
- `src/db.js`
- `src/seed.js`
- `src/sync/bridge.js`
- `supabase/schema.sql`
- `public/css/styles.css`
- `views/onboarding/welcome.ejs`
- `views/onboarding/plan.ejs`
- `views/onboarding/checkout.ejs`
- `views/app/plans.ejs`
- `views/admin/plans.ejs`
- `views/admin/subscriptions.ejs`
- `views/partials/app-sidebar.ejs`
- `package.json`
- `scripts/smoke-test.js`

## 2026-02-20 - QA Pass 2 (UX + Robustness)

### Ajustes aplicados

1. Prevencion de doble submit global en formularios.
- Fix: lock de submit con feedback `Procesando...` para evitar envios duplicados.
- Archivos: `public/js/app.js`, `public/css/styles.css`.

2. Carrito WhatsApp: no vaciar carrito si popup bloqueado.
- Fix: ahora solo limpia carrito cuando WhatsApp abre correctamente.
- Archivos: `public/js/app.js`.

3. Carrito: restaurar boton submit al fallar validaciones.
- Fix: re-enable de submit cuando hay error de formulario en checkout publico.
- Archivos: `public/js/app.js`.

### Revalidacion

- `npm run build`: OK
- `npm run lint`: OK
- `npm test`: OK (`Smoke test OK`)
