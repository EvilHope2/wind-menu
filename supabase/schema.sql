-- Ejecutar en Supabase SQL Editor.
-- Crea el esquema base equivalente al SQLite actual.

create table if not exists public.users (
  id bigserial primary key,
  full_name text not null,
  email text not null unique,
  whatsapp text not null,
  role text not null default 'COMMERCE',
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.affiliates (
  id bigserial primary key,
  user_id bigint not null unique references public.users(id) on delete cascade,
  ref_code text not null unique,
  commission_rate numeric(8,4) not null default 0.25,
  points_confirmed integer not null default 0,
  points_debt integer not null default 0,
  total_commission_earned numeric(14,2) not null default 0,
  total_commission_paid numeric(14,2) not null default 0,
  negative_balance numeric(14,2) not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.businesses (
  id bigserial primary key,
  user_id bigint not null unique references public.users(id) on delete cascade,
  business_name text not null,
  slug text not null unique,
  logo_url text,
  cover_url text,
  whatsapp text not null,
  address text,
  hours text,
  instagram text,
  payment_methods text,
  primary_color text,
  shipping_fee numeric(12,2) not null default 0,
  delivery_enabled boolean not null default true,
  pickup_enabled boolean not null default true,
  minimum_order_amount numeric(12,2),
  free_delivery_over_amount numeric(12,2),
  payment_cash_enabled boolean not null default true,
  payment_transfer_enabled boolean not null default true,
  payment_card_enabled boolean not null default true,
  transfer_instructions text,
  transfer_alias text,
  transfer_cvu text,
  transfer_account_holder text,
  cash_allow_change boolean not null default true,
  is_temporarily_closed boolean not null default false,
  temporary_closed_message text,
  timezone text not null default 'America/Argentina/Ushuaia',
  affiliate_id bigint references public.affiliates(id) on delete set null,
  referred_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.categories (
  id bigserial primary key,
  business_id bigint not null references public.businesses(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.products (
  id bigserial primary key,
  business_id bigint not null references public.businesses(id) on delete cascade,
  category_id bigint references public.categories(id) on delete set null,
  name text not null,
  description text,
  price numeric(12,2) not null default 0,
  previous_price numeric(12,2),
  image_url text,
  is_featured boolean not null default false,
  is_sold_out boolean not null default false,
  is_visible boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.delivery_zones (
  id bigserial primary key,
  business_id bigint not null references public.businesses(id) on delete cascade,
  name text not null,
  price numeric(12,2) not null default 0,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  minimum_order_amount numeric(12,2),
  free_delivery_over_amount numeric(12,2),
  estimated_time_min integer,
  estimated_time_max integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.business_hours (
  id bigserial primary key,
  business_id bigint not null references public.businesses(id) on delete cascade,
  day_of_week integer not null,
  is_open boolean not null default false,
  open_time text,
  close_time text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, day_of_week)
);

create table if not exists public.plans (
  id bigserial primary key,
  name text not null,
  price numeric(12,2) not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.subscriptions (
  id bigserial primary key,
  business_id bigint not null references public.businesses(id) on delete cascade,
  plan_id bigint not null references public.plans(id) on delete restrict,
  amount numeric(12,2) not null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.affiliate_payouts (
  id bigserial primary key,
  affiliate_id bigint not null references public.affiliates(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  amount_paid numeric(12,2) not null default 0,
  method text,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.affiliate_sales (
  id bigserial primary key,
  affiliate_id bigint not null references public.affiliates(id) on delete cascade,
  business_id bigint not null references public.businesses(id) on delete cascade,
  subscription_id bigint unique references public.subscriptions(id) on delete set null,
  plan_id bigint references public.plans(id) on delete set null,
  amount numeric(12,2) not null,
  commission_rate numeric(8,4) not null default 0.25,
  commission_amount numeric(12,2) not null default 0,
  points_earned integer not null default 0,
  status text not null default 'PENDING',
  review_note text,
  reviewed_at timestamptz,
  reviewed_by_admin_id bigint references public.users(id) on delete set null,
  reverse_note text,
  reversed_at timestamptz,
  payout_id bigint references public.affiliate_payouts(id) on delete set null,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create index if not exists idx_business_slug on public.businesses(slug);
create index if not exists idx_categories_business_id on public.categories(business_id);
create index if not exists idx_products_business_id on public.products(business_id);
create index if not exists idx_products_category_id on public.products(category_id);
create index if not exists idx_delivery_zones_business_id on public.delivery_zones(business_id);
create index if not exists idx_business_hours_business_id on public.business_hours(business_id);
create index if not exists idx_affiliate_sales_affiliate_id on public.affiliate_sales(affiliate_id);
create index if not exists idx_affiliate_sales_status on public.affiliate_sales(status);

alter table if exists public.subscriptions add column if not exists payment_provider text;
alter table if exists public.subscriptions add column if not exists provider_preference_id text;
alter table if exists public.subscriptions add column if not exists provider_payment_id text;
alter table if exists public.subscriptions add column if not exists external_reference text;
alter table if exists public.subscriptions add column if not exists last_provider_status text;
