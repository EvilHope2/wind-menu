# Windi Menu (V1)

Plataforma SaaS para que comercios creen y gestionen su menu digital con link publico por slug.

## Stack

- Frontend: EJS + HTML + CSS + JS (responsive mobile-first)
- Backend: Node.js + Express
- DB local: SQLite (`better-sqlite3`)

## Funcionalidades V1

- Landing publica comercial
- Registro, login, logout y placeholder de recuperacion
- Panel privado protegido por sesion
- Seccion "Mi comercio" editable (incluye slug unico)
- CRUD de categorias con orden
- CRUD de productos con:
  - busqueda
  - filtro por categoria
  - destacado
  - agotado
  - visible/no visible
  - duplicar producto
- Vista previa de menu
- Menu publico por slug: `/:slug`
- QR automatico + descarga PNG
- Carrito en menu publico con localStorage, panel lateral y envio de pedido por WhatsApp
- Zonas de envio configurables por comercio (solo zonas activas en menu publico)
- Metodos de pago configurables (Tarjeta, Transferencia, Efectivo)
- Transferencia con texto opcional configurable (alias/CVU) en carrito y mensaje
- Delivery avanzado: minimo y envio gratis (general y por zona)
- Horarios y estado del local (abierto/cerrado/temporal) con bloqueo de pedidos fuera de horario
- Sistema de afiliados anti-estafa:
  - rol AFFILIATE + links de referido (`/registro?ref=...` y `/r/REFCODE`)
  - ventas afiliado en estados `PENDING|APPROVED|REJECTED|PAID|REVERSED`
  - revision manual admin (aprobar/rechazar/revertir)
  - payouts semanales manuales por admin

## Ejecutar en local

```bash
npm install
npm run dev
```

Abrir `http://localhost:3000`.

## Usuarios demo (seed idempotente)

- Admin: `admin@windi.menu` / `admin1234`
- Afiliado: `affiliate@windi.menu` / `affiliate1234`
- Comercio: `demo@windi.menu` / `demo1234`
- Ref code afiliado: `AFI25DEMO`
- Registro referido: `http://localhost:3000/registro?ref=AFI25DEMO`
- Menu publico comercio: `http://localhost:3000/pizzeria9420`

Tambien puedes correr seed manual:

```bash
npm run seed
```

## Flujo afiliados (prueba rapida)

1. Entra como admin en `/login`.
2. Ve a `/admin/subscriptions` y crea una suscripcion paga para un comercio referido.
3. Se genera una venta afiliado en `PENDING`.
4. Revisa en `/admin/affiliate-sales` y aprueba/rechaza/revierte.
5. Genera pago semanal en `/admin/affiliate-payouts`.
6. Entra como afiliado y revisa:
   - `/affiliate/dashboard`
   - `/affiliate/sales`
   - `/affiliate/referrals`

## Conectar GitHub + Vercel + Supabase

Importante: el proyecto actual usa SQLite (`better-sqlite3`). En Vercel necesitas DB externa para persistencia real.
La opcion recomendada es migrar la data a Supabase (PostgreSQL).

### 1) Supabase

1. Crea un proyecto en Supabase.
2. Abre SQL Editor y ejecuta `supabase/schema.sql`.
3. Copia:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SUPABASE_DB_URL` (connection string)

### 2) GitHub

```bash
git init
git add .
git commit -m "setup supabase + vercel config"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/TU_REPO.git
git push -u origin main
```

### 3) Vercel

1. En Vercel: New Project -> Import from GitHub -> selecciona el repo.
2. Framework preset: Other.
3. Build/Output: dejar default (usa `vercel.json`).
4. Variables de entorno en Vercel:
   - `SESSION_SECRET`
   - `BASE_URL` (tu dominio Vercel)
   - `MP_ACCESS_TOKEN` (Mercado Pago backend)
   - `MP_WEBHOOK_URL` (opcional, default `${BASE_URL}/webhooks/mercadopago`)
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SUPABASE_DB_URL`
5. Deploy.

### Nota tecnica

- Ya se agrego `vercel.json` para enrutar todo a `server.js`.
- Ya se agrego `src/supabase.js` para iniciar cliente Supabase.
- Ya se agregaron scripts de soporte:
  - `npm run supabase:check` valida conexion a Supabase.
  - `npm run supabase:sync` sincroniza datos actuales de SQLite hacia Supabase.
- Falta migrar las consultas runtime actuales (hoy en SQLite) para ejecutar directo sobre Supabase/Postgres en produccion.

## Comandos utiles Supabase

```bash
npm run supabase:check
npm run supabase:sync
npm run supabase:pull
```

## Runtime mirror (transicion segura)

Puedes activar espejo SQLite <-> Supabase sin reescribir endpoints:

```env
SUPABASE_RUNTIME_SYNC=1
SUPABASE_PRIMARY=1
SUPABASE_PULL_INTERVAL_MS=30000
```

- Al iniciar: hace pull de Supabase -> SQLite.
- En mutaciones (POST/PUT/PATCH/DELETE): hace push de SQLite -> Supabase.
- Permite mantener la logica actual mientras migras queries nativas a Postgres.
- Con `SUPABASE_PRIMARY=1`, si Supabase no responde la app no inicia (modo produccion estricto).

## Planes y pagos online

- Comercio: `/app/plans` para elegir plan y pagar.
- Admin: `/admin/plans` para crear/editar/activar planes.
- Admin: `/admin/subscriptions` para ver estado de suscripciones y pasarela.
- Webhook: `POST /webhooks/mercadopago`.
- Cuando Mercado Pago confirma `approved`, la suscripcion pasa a `paid` y la venta afiliada se crea en `PENDING`.

## Estructura

```txt
miniweb/
  data/
  public/
    css/
    js/
  src/
    middleware/
    utils/
  uploads/
  views/
    app/
    partials/
  server.js
```

## Escalabilidad futura (base preparada)

- Planes pagos por comercio
- Multiples sucursales
- Pedidos online
- Fidelizacion y CRM
