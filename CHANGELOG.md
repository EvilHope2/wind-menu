# CHANGELOG

## 2026-02-20 - Panel Comercio QA/Debug (estabilidad)

### Errores encontrados

1. Riesgo de crash en rutas del panel por `business` nulo.
- Causa: multiples rutas `/app/*` accedian a `business.id` sin validar contexto cargado.
- Impacto: errores 500/pantallas en blanco y redirecciones inconsistentes.

2. Inconsistencias en rutas del panel (`/panel/*`) con aliases en espanol.
- Causa: redireccion generica a `/app/:section` sin mapear rutas equivalentes reales.
- Impacto: posibles 404 o navegacion erratica para enlaces viejos/bookmarks.

3. Billing accesible con `requireAuth` generico.
- Causa: la ruta permitia roles no comercio y podia terminar en estados incoherentes.
- Impacto: errores de contexto y flujo confuso.

### Soluciones aplicadas

1. Middleware de contexto de comercio centralizado.
- Nuevo `ensureCommerceBusinessContext` para resolver y adjuntar `req.business`.
- Se aplica en `/app` y `/panel` junto al guard de suscripcion.
- Resultado: todas las pantallas del panel leen el mismo contexto y evitan null crashes.

2. Refactor de rutas del panel para usar `req.business`.
- Reemplazo de lecturas repetidas de `getBusinessByUserId(...)` en handlers del panel.
- Cobertura: dashboard, mi comercio, delivery settings, horarios, categorias, productos, zonas, metodos de pago, preview, QR.

3. Guard de billing endurecido para COMMERCE.
- `/billing` ahora usa `requireRole("COMMERCE")` + contexto de comercio.
- `/app/plans/:id/checkout` tambien exige rol COMMERCE.

4. Compatibilidad de aliases `/panel/*` y `/app/*`.
- Mapeos agregados:
  - `/panel/mi-comercio` -> `/app/business`
  - `/panel/categorias` -> `/app/categories`
  - `/panel/productos` -> `/app/products`
  - `/panel/zonas-envio` -> `/app/delivery-zones`
  - `/panel/metodos-pago` -> `/app/payment-methods`
  - `/panel/horarios` -> `/app/business-hours`
  - `/panel/vista-previa` -> `/app/preview`
  - `/panel/billing` -> `/billing`
- Alias equivalentes en `/app/*` para compatibilidad (ej. `/app/zonas-envio`).

### Archivos modificados

- `server.js`

### Validaciones ejecutadas

- `npm run build`: OK
- `npm run lint`: OK
- `npm test`: OK (`Smoke test OK`)
- Prueba de navegacion autenticada por HTTP (commerce demo): OK en
  - `/app`
  - `/app/business`
  - `/app/delivery-settings`
  - `/app/categories`
  - `/app/products`
  - `/app/delivery-zones`
  - `/app/payment-methods`
  - `/app/business-hours`
  - `/app/preview`
  - `/app/qr`
  - `/billing`

### Checklist manual solicitado (estado)

- Crear/editar/eliminar categoria: Pendiente validacion visual final en navegador.
- Crear/editar/eliminar producto: Pendiente validacion visual final en navegador.
- Marcar agotado/visible/destacado: Pendiente validacion visual final en navegador.
- Agregar zona + editar precio + desactivar: Pendiente validacion visual final en navegador.
- Configurar metodos de pago + alias/cvu + vuelto: Pendiente validacion visual final en navegador.
- Configurar horarios + cerrado temporal: Pendiente validacion visual final en navegador.
- Generar QR: Validado por endpoint/pagina sin crash.
- Vista previa del menu: Validado por endpoint/pagina sin crash.
- Billing pending/active: Validado render de `/billing` sin crash; estado funcional depende de datos de suscripcion.

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

## 2026-02-20 - Legal Docs + Consent System

### Implementado

1. Paginas legales publicas:
- `/terminos`
- `/privacidad`
- `/cookies`
- `/reembolsos`

2. Versionado central de documentos:
- Archivo `src/legal.js` con versiones, fechas de vigencia y datos editables de empresa.

3. Consentimiento obligatorio:
- Registro comercio: checkbox obligatorio.
- Checkout de planes: confirmacion legal obligatoria.
- Reaceptacion forzada al iniciar sesion si cambia version legal.

4. Registro de consentimiento en DB:
- Tabla `legal_consents` con usuario, rol, versiones, fecha, IP, user-agent y origen.

5. Pantallas y rutas de gestion:
- `/legal/accept` para aceptar versiones vigentes.
- `/settings/legal` para ver historial de consentimientos.
- Admin: `/admin/legal-consents` y export `/admin/legal-consents.csv`.

6. Links legales en UI:
- Landing, onboarding, menu publico, panel comercio, nav admin y nav afiliado.

### Archivos tocados

- `server.js`
- `src/db.js`
- `src/sync/bridge.js`
- `supabase/schema.sql`
- `src/legal.js`
- `views/legal/terminos.ejs`
- `views/legal/privacidad.ejs`
- `views/legal/cookies.ejs`
- `views/legal/reembolsos.ejs`
- `views/legal/accept.ejs`
- `views/settings/legal.ejs`
- `views/auth-register.ejs`
- `views/onboarding/plan.ejs`
- `views/onboarding/welcome.ejs`
- `views/onboarding/checkout.ejs`
- `views/app/plans.ejs`
- `views/landing.ejs`
- `views/partials/public-menu-content.ejs`
- `views/partials/app-sidebar.ejs`
- `views/partials/admin-nav.ejs`
- `views/partials/affiliate-nav.ejs`
- `views/admin/legal-consents.ejs`
- `scripts/smoke-test.js`
