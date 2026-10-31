-- =====================================================================
-- SaveBite Retailer System — database migration
-- Run AFTER the customer app's supabase/schema.sql, in the SAME Supabase project.
-- Supabase Dashboard → SQL Editor → New query → paste this file → Run.
-- Safe to run more than once. It only ADDS to the customer schema; nothing is dropped.
--
-- What this adds
--   profiles.phone                    so a cashier can find a customer by phone
--   retailers / retail_stores         who the retailers are
--   retailer_staff                    which login belongs to which store, and their role
--   product_catalog                   barcode -> product name/category, per retailer
--   consent_records                   every yes/no the customer gave, with timestamp
--   customer_verifications            short-lived proof "this cashier identified this customer"
--   customer_lookup_log               failed-lookup throttle (stops phone-number guessing)
--   purchases / purchase_items        EXISTING tables, extended with retailer columns
--   lookup_customer(), submit_bill()  server-only functions called by the Edge Function
--   portal_*()                        read helpers the portal calls (staff only)
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Customer phone number (so retailers can identify customers)
-- ---------------------------------------------------------------------
-- Stored as the last 10 digits only, so "+91 98765-43210" and "9876543210" match.
create or replace function public.normalize_phone(p text)
returns text
language sql
immutable
as $$
  select case when length(d) >= 10 then right(d, 10) else null end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) x
$$;

alter table public.profiles add column if not exists phone text;
create unique index if not exists profiles_phone_uidx on public.profiles (phone) where phone is not null;

-- Signup trigger: now also saves the phone number (from signup metadata), and does NOT
-- create a customer profile for retailer staff accounts (marked in app_metadata, which
-- a customer cannot set themselves).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name  text := coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(new.email, '@', 1));
  v_phone text := public.normalize_phone(new.raw_user_meta_data ->> 'phone');
begin
  if coalesce(new.raw_app_meta_data ->> 'account_type', '') = 'retailer' then
    return new;
  end if;
  begin
    insert into public.profiles (id, full_name, phone) values (new.id, v_name, v_phone)
    on conflict (id) do nothing;
  exception when unique_violation then
    -- phone already belongs to someone else: still create the account, just without the phone
    insert into public.profiles (id, full_name) values (new.id, v_name)
    on conflict (id) do nothing;
  end;
  return new;
end;
$$;


-- ---------------------------------------------------------------------
-- 2. Retailer tables
-- ---------------------------------------------------------------------
create table if not exists public.retailers (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 80),
  created_at timestamptz not null default now()
);

create table if not exists public.retail_stores (
  id          uuid primary key default gen_random_uuid(),
  retailer_id uuid not null references public.retailers (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 80),   -- shown to customers as the store name
  branch      text check (branch is null or char_length(branch) <= 80),
  created_at  timestamptz not null default now()
);

-- One row per retailer login. admin = manages team + catalogue + sees every store.
-- employee = bills customers, sees only their own store's transactions.
create table if not exists public.retailer_staff (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  retailer_id uuid not null references public.retailers (id) on delete cascade,
  store_id    uuid not null references public.retail_stores (id) on delete restrict,
  full_name   text not null check (char_length(full_name) between 1 and 80),
  role        text not null check (role in ('admin', 'employee')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.product_catalog (
  id          uuid primary key default gen_random_uuid(),
  retailer_id uuid not null references public.retailers (id) on delete cascade,
  barcode     text not null check (barcode ~ '^[A-Za-z0-9-]{4,32}$'),
  name        text not null check (char_length(name) between 1 and 120),
  category    text not null default 'Other'
              check (category in ('Dairy','Groceries','Beverages','Snacks','Bakery','Frozen','Personal care','Other')),
  created_at  timestamptz not null default now(),
  unique (retailer_id, barcode)
);

-- Short-lived proof that a cashier identified a real customer. submit_bill() needs one.
create table if not exists public.customer_verifications (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles (id) on delete cascade,
  staff_id    uuid not null references public.retailer_staff (user_id) on delete cascade,
  retailer_id uuid not null references public.retailers (id) on delete cascade,
  method      text not null check (method in ('phone', 'customer_code', 'email')),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '30 minutes',
  used_at     timestamptz
);

create table if not exists public.customer_lookup_log (
  id       bigint generated always as identity primary key,
  staff_id uuid not null references public.retailer_staff (user_id) on delete cascade,
  method   text not null,
  success  boolean not null,
  at       timestamptz not null default now()
);
create index if not exists lookup_log_idx on public.customer_lookup_log (staff_id, at desc);


-- ---------------------------------------------------------------------
-- 3. Extend the EXISTING bill tables (customer app keeps working: it selects named columns)
-- ---------------------------------------------------------------------
alter table public.purchases
  add column if not exists retailer_id      uuid references public.retailers (id),
  add column if not exists store_id         uuid references public.retail_stores (id),
  add column if not exists staff_id         uuid references auth.users (id) on delete set null,
  add column if not exists transaction_ref  text,
  add column if not exists idempotency_key  text,
  add column if not exists consent_id       uuid;

create unique index if not exists purchases_txn_ref_uidx   on public.purchases (transaction_ref) where transaction_ref is not null;
create unique index if not exists purchases_idem_uidx      on public.purchases (retailer_id, idempotency_key) where idempotency_key is not null;
create index        if not exists purchases_retailer_idx   on public.purchases (retailer_id, purchased_at desc);

alter table public.purchase_items
  add column if not exists batch_no   text,
  add column if not exists unit_price numeric(10, 2) check (unit_price is null or unit_price >= 0);

create table if not exists public.consent_records (
  id              uuid primary key default gen_random_uuid(),
  customer_id     uuid not null references public.profiles (id) on delete cascade,
  retailer_id     uuid not null references public.retailers (id) on delete cascade,
  store_id        uuid not null references public.retail_stores (id),
  staff_id        uuid references auth.users (id) on delete set null,
  verification_id uuid references public.customer_verifications (id) on delete set null,
  consent_given   boolean not null,
  consent_text    text not null,
  method          text not null default 'counter_confirmation',
  transaction_ref text,
  purchase_id     uuid references public.purchases (id) on delete set null,
  recorded_at     timestamptz not null default now()
);
create index if not exists consent_retailer_idx on public.consent_records (retailer_id, recorded_at desc);


-- ---------------------------------------------------------------------
-- 4. Who is the logged-in retailer? (used by the security rules below)
-- ---------------------------------------------------------------------
create or replace function public.staff_retailer_id() returns uuid
language sql stable security definer set search_path = public as
$$ select retailer_id from public.retailer_staff where user_id = (select auth.uid()) and active $$;

create or replace function public.staff_store_id() returns uuid
language sql stable security definer set search_path = public as
$$ select store_id from public.retailer_staff where user_id = (select auth.uid()) and active $$;

create or replace function public.staff_role() returns text
language sql stable security definer set search_path = public as
$$ select role from public.retailer_staff where user_id = (select auth.uid()) and active $$;

revoke all on function public.staff_retailer_id(), public.staff_store_id(), public.staff_role() from public, anon;
grant execute on function public.staff_retailer_id(), public.staff_store_id(), public.staff_role() to authenticated;


-- ---------------------------------------------------------------------
-- 5. Row Level Security
--    Retailers can NEVER insert into purchases / purchase_items / consent_records directly.
--    The only way in is submit_bill(), which only the server (service role) can run.
-- ---------------------------------------------------------------------
alter table public.retailers               enable row level security;
alter table public.retail_stores           enable row level security;
alter table public.retailer_staff          enable row level security;
alter table public.product_catalog         enable row level security;
alter table public.consent_records         enable row level security;
alter table public.customer_verifications  enable row level security;   -- no policies = nobody but the server
alter table public.customer_lookup_log     enable row level security;   -- no policies = nobody but the server

revoke all on public.retailers, public.retail_stores, public.retailer_staff, public.product_catalog,
              public.consent_records, public.customer_verifications, public.customer_lookup_log
  from anon, authenticated;
grant select on public.retailers, public.retail_stores, public.retailer_staff, public.consent_records to authenticated;
grant select, insert, update, delete on public.product_catalog to authenticated;

drop policy if exists "staff read own retailer" on public.retailers;
create policy "staff read own retailer" on public.retailers
  for select to authenticated using (id = public.staff_retailer_id());

drop policy if exists "staff read own stores" on public.retail_stores;
create policy "staff read own stores" on public.retail_stores
  for select to authenticated using (retailer_id = public.staff_retailer_id());

drop policy if exists "staff read team" on public.retailer_staff;
create policy "staff read team" on public.retailer_staff
  for select to authenticated using (
    user_id = (select auth.uid())
    or (retailer_id = public.staff_retailer_id() and public.staff_role() = 'admin')
  );

drop policy if exists "catalog read" on public.product_catalog;
create policy "catalog read" on public.product_catalog
  for select to authenticated using (retailer_id = public.staff_retailer_id());
drop policy if exists "catalog insert" on public.product_catalog;
create policy "catalog insert" on public.product_catalog
  for insert to authenticated with check (retailer_id = public.staff_retailer_id());
drop policy if exists "catalog update" on public.product_catalog;
create policy "catalog update" on public.product_catalog
  for update to authenticated using (retailer_id = public.staff_retailer_id()) with check (retailer_id = public.staff_retailer_id());
drop policy if exists "catalog delete (admin)" on public.product_catalog;
create policy "catalog delete (admin)" on public.product_catalog
  for delete to authenticated using (retailer_id = public.staff_retailer_id() and public.staff_role() = 'admin');

-- Retailers may READ the bills their own retailer/store created (admin: whole retailer, employee: own store).
-- Customers keep their existing "read own" policies; policies are OR-ed together.
drop policy if exists "staff read own bills" on public.purchases;
create policy "staff read own bills" on public.purchases
  for select to authenticated using (
    retailer_id = public.staff_retailer_id()
    and (public.staff_role() = 'admin' or store_id = public.staff_store_id())
  );

drop policy if exists "staff read own bill items" on public.purchase_items;
create policy "staff read own bill items" on public.purchase_items
  for select to authenticated using (
    exists (
      select 1 from public.purchases p
      where p.id = purchase_items.purchase_id
        and p.retailer_id = public.staff_retailer_id()
        and (public.staff_role() = 'admin' or p.store_id = public.staff_store_id())
    )
  );

drop policy if exists "staff read own consents" on public.consent_records;
create policy "staff read own consents" on public.consent_records
  for select to authenticated using (
    retailer_id = public.staff_retailer_id()
    and (public.staff_role() = 'admin' or store_id = public.staff_store_id())
  );


-- ---------------------------------------------------------------------
-- 6. SERVER-ONLY: find and verify a customer
--    Called by the Edge Function with the service role. Never returns the customer's
--    inventory, full name, phone or email — only what a cashier needs to confirm identity.
-- ---------------------------------------------------------------------
create or replace function public.lookup_customer(p_staff uuid, p_method text, p_value text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s        public.retailer_staff%rowtype;
  c        public.profiles%rowtype;
  v_clean  text;
  v_fails  int;
  v_ver    public.customer_verifications%rowtype;
  v_first  text;
  v_last   text;
  v_phone  text;
begin
  select * into s from public.retailer_staff where user_id = p_staff and active;
  if not found then
    raise exception 'This account is not an active retailer account.' using errcode = '42501';
  end if;
  if p_method not in ('phone', 'customer_code', 'email') then
    raise exception 'Unsupported lookup method.';
  end if;

  -- throttle guessing: too many misses in 10 minutes -> pause
  select count(*) into v_fails from public.customer_lookup_log
  where staff_id = p_staff and not success and at > now() - interval '10 minutes';
  if v_fails >= 15 then
    raise exception 'Too many unsuccessful lookups. Please wait a few minutes and try again.' using errcode = '54000';
  end if;

  if p_method = 'phone' then
    v_clean := public.normalize_phone(p_value);
    if v_clean is not null then
      select * into c from public.profiles where phone = v_clean;
    end if;
  elsif p_method = 'customer_code' then
    select * into c from public.profiles where customer_code = upper(btrim(coalesce(p_value, '')));
  else
    -- only verified (confirmed) email addresses count
    select p.* into c
    from public.profiles p join auth.users u on u.id = p.id
    where lower(u.email) = lower(btrim(coalesce(p_value, ''))) and u.email_confirmed_at is not null;
  end if;

  if c.id is null then
    insert into public.customer_lookup_log (staff_id, method, success) values (p_staff, p_method, false);
    return jsonb_build_object('found', false);
  end if;

  insert into public.customer_lookup_log (staff_id, method, success) values (p_staff, p_method, true);
  insert into public.customer_verifications (customer_id, staff_id, retailer_id, method)
  values (c.id, p_staff, s.retailer_id, p_method)
  returning * into v_ver;

  -- masked display: "Asha V." and "phone ending 10"
  v_first := split_part(btrim(coalesce(c.full_name, 'Customer')), ' ', 1);
  v_last  := nullif(split_part(btrim(coalesce(c.full_name, '')), ' ', 2), '');
  v_phone := case when c.phone is not null then right(c.phone, 2) end;

  return jsonb_build_object(
    'found', true,
    'verification_id', v_ver.id,
    'expires_at', v_ver.expires_at,
    'customer_code', c.customer_code,
    'display_name', v_first || coalesce(' ' || left(v_last, 1) || '.', ''),
    'phone_hint', v_phone
  );
end;
$$;


-- ---------------------------------------------------------------------
-- 7. SERVER-ONLY: submit a bill (atomic: everything saves, or nothing does)
-- ---------------------------------------------------------------------
create or replace function public.submit_bill(
  p_staff           uuid,
  p_verification    uuid,
  p_idempotency_key text,
  p_items           jsonb,
  p_consent_given   boolean,
  p_consent_method  text default 'counter_confirmation',
  p_bill_no         text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  c_yes constant text := 'Customer agreed to share this purchase with SaveBite and receive expiry reminders.';
  c_no  constant text := 'Customer declined to share this purchase with SaveBite.';
  s        public.retailer_staff%rowtype;
  st       public.retail_stores%rowtype;
  v        public.customer_verifications%rowtype;
  old      public.purchases%rowtype;
  v_consent uuid;
  v_purchase uuid;
  v_ref    text;
  v_total  numeric := 0;
  v_priced boolean := false;
  v_n      int := 0;
  it       jsonb;
  v_name text; v_cat text; v_qty int; v_exp date; v_batch text; v_bar text; v_price numeric;
  v_exp_txt text;
begin
  select * into s from public.retailer_staff where user_id = p_staff and active;
  if not found then
    raise exception 'This account is not an active retailer account.' using errcode = '42501';
  end if;
  if p_idempotency_key is null or char_length(btrim(p_idempotency_key)) not between 8 and 64 then
    raise exception 'Missing or invalid bill reference. Start the bill again.';
  end if;
  if p_consent_given is null then
    raise exception 'The customer consent decision is required.';
  end if;
  if p_consent_method is null or p_consent_method not in ('counter_confirmation') then
    raise exception 'Unsupported consent method.';
  end if;

  -- lock the verification row so two simultaneous submissions line up one after the other
  select * into v from public.customer_verifications
  where id = p_verification and staff_id = p_staff and retailer_id = s.retailer_id
  for update;
  if not found then
    raise exception 'Customer verification not found. Please look up the customer again.';
  end if;

  -- duplicate submission? Return the bill that was already saved.
  select * into old from public.purchases
  where retailer_id = s.retailer_id and idempotency_key = btrim(p_idempotency_key);
  if found then
    if old.customer_id <> v.customer_id then
      raise exception 'This bill reference was already used for a different customer.';
    end if;
    return jsonb_build_object(
      'status', 'submitted', 'duplicate', true,
      'purchase_id', old.id, 'transaction_ref', old.transaction_ref,
      'item_count', (select count(*) from public.purchase_items where purchase_id = old.id)
    );
  end if;

  if v.used_at is not null then
    raise exception 'This customer verification was already used. Look up the customer again.';
  end if;
  if v.expires_at < now() then
    raise exception 'Customer verification expired. Please look up the customer again.';
  end if;

  select * into st from public.retail_stores where id = s.store_id;

  -- customer said NO: record the decision, share nothing
  if not p_consent_given then
    insert into public.consent_records (customer_id, retailer_id, store_id, staff_id, verification_id, consent_given, consent_text, method)
    values (v.customer_id, s.retailer_id, s.store_id, p_staff, v.id, false, c_no, p_consent_method);
    update public.customer_verifications set used_at = now() where id = v.id;
    return jsonb_build_object('status', 'declined');
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 100 then
    raise exception 'A bill needs between 1 and 100 items.';
  end if;

  -- unique transaction ID such as SBT-261031-7K3Q9X
  loop
    v_ref := 'SBT-' || to_char(now(), 'YYMMDD') || '-';
    for i in 1..6 loop
      v_ref := v_ref || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.purchases where transaction_ref = v_ref);
  end loop;

  insert into public.consent_records (customer_id, retailer_id, store_id, staff_id, verification_id, consent_given, consent_text, method, transaction_ref)
  values (v.customer_id, s.retailer_id, s.store_id, p_staff, v.id, true, c_yes, p_consent_method, v_ref)
  returning id into v_consent;

  insert into public.purchases (customer_id, store_name, store_branch, bill_no, purchased_at,
                                retailer_id, store_id, staff_id, transaction_ref, idempotency_key, consent_id)
  values (v.customer_id, st.name, st.branch, coalesce(nullif(btrim(p_bill_no), ''), v_ref), now(),
          s.retailer_id, s.store_id, p_staff, v_ref, btrim(p_idempotency_key), v_consent)
  returning id into v_purchase;

  for it in select value from jsonb_array_elements(p_items) loop
    v_n := v_n + 1;
    if jsonb_typeof(it) <> 'object' then
      raise exception 'Item %: invalid data.', v_n;
    end if;

    v_name := btrim(coalesce(it ->> 'name', ''));
    if v_name = '' or char_length(v_name) > 120 then
      raise exception 'Item %: product name is required (max 120 characters).', v_n;
    end if;

    v_cat := coalesce(nullif(btrim(it ->> 'category'), ''), 'Other');
    if v_cat not in ('Dairy','Groceries','Beverages','Snacks','Bakery','Frozen','Personal care','Other') then
      raise exception 'Item % (%): unknown category "%".', v_n, v_name, v_cat;
    end if;

    begin
      v_qty := (it ->> 'quantity')::int;
    exception when others then
      v_qty := null;
    end;
    if v_qty is null or v_qty < 1 or v_qty > 1000 then
      raise exception 'Item % (%): quantity must be a whole number from 1 to 1000.', v_n, v_name;
    end if;

    v_exp_txt := it ->> 'expiry_date';
    v_exp := null;
    if v_exp_txt ~ '^\d{4}-\d{2}-\d{2}$' then
      begin
        v_exp := v_exp_txt::date;
      exception when others then
        v_exp := null;
      end;
    end if;
    if v_exp is null then
      raise exception 'Item % (%): a valid expiry date (YYYY-MM-DD) is required.', v_n, v_name;
    end if;
    if v_exp < current_date then
      raise exception 'Item % (%): expiry date % is already in the past.', v_n, v_name, v_exp;
    end if;
    if v_exp > current_date + interval '20 years' then
      raise exception 'Item % (%): expiry date looks wrong (more than 20 years away).', v_n, v_name;
    end if;

    v_batch := nullif(btrim(coalesce(it ->> 'batch_no', '')), '');
    if v_batch is not null and char_length(v_batch) > 40 then
      raise exception 'Item % (%): batch number is too long (max 40 characters).', v_n, v_name;
    end if;

    v_bar := nullif(btrim(coalesce(it ->> 'barcode', '')), '');
    if v_bar is not null and v_bar !~ '^[A-Za-z0-9-]{4,32}$' then
      raise exception 'Item % (%): barcode must be 4-32 letters, digits or dashes.', v_n, v_name;
    end if;

    v_price := null;
    if nullif(btrim(coalesce(it ->> 'unit_price', '')), '') is not null then
      begin
        v_price := (it ->> 'unit_price')::numeric;
      exception when others then
        v_price := -1;
      end;
      if v_price < 0 or v_price > 1000000 then
        raise exception 'Item % (%): price must be a number between 0 and 1,000,000.', v_n, v_name;
      end if;
      v_priced := true;
      v_total := v_total + v_price * v_qty;
    end if;

    insert into public.purchase_items (purchase_id, customer_id, name, category, quantity, barcode, expiry_date, batch_no, unit_price)
    values (v_purchase, v.customer_id, v_name, v_cat, v_qty, v_bar, v_exp, v_batch, v_price);

    -- the catalogue learns new barcodes automatically (never overwrites an existing one)
    if v_bar is not null then
      insert into public.product_catalog (retailer_id, barcode, name, category)
      values (s.retailer_id, v_bar, v_name, v_cat)
      on conflict (retailer_id, barcode) do nothing;
    end if;
  end loop;

  update public.purchases set total_amount = case when v_priced then round(v_total, 2) end where id = v_purchase;
  update public.consent_records set purchase_id = v_purchase where id = v_consent;
  update public.customer_verifications set used_at = now() where id = v.id;

  return jsonb_build_object(
    'status', 'submitted', 'duplicate', false,
    'purchase_id', v_purchase, 'transaction_ref', v_ref, 'item_count', v_n,
    'total_amount', case when v_priced then round(v_total, 2) end
  );
end;
$$;

revoke all on function public.lookup_customer(uuid, text, text) from public, anon, authenticated;
revoke all on function public.submit_bill(uuid, uuid, text, jsonb, boolean, text, text) from public, anon, authenticated;
grant execute on function public.lookup_customer(uuid, text, text) to service_role;
grant execute on function public.submit_bill(uuid, uuid, text, jsonb, boolean, text, text) to service_role;


-- ---------------------------------------------------------------------
-- 8. Read helpers for the portal (any ACTIVE retailer login; scoped to its own store/retailer)
-- ---------------------------------------------------------------------
create or replace function public.portal_dashboard_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_ret uuid := public.staff_retailer_id();
  v_role text := public.staff_role();
  v_store uuid := public.staff_store_id();
  r jsonb;
begin
  if v_ret is null then
    raise exception 'This account is not an active retailer account.' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'total_bills',        (select count(*) from public.purchases p
                            where p.retailer_id = v_ret and (v_role = 'admin' or p.store_id = v_store)),
    'bills_24h',          (select count(*) from public.purchases p
                            where p.retailer_id = v_ret and (v_role = 'admin' or p.store_id = v_store)
                              and p.purchased_at > now() - interval '24 hours'),
    'total_products',     (select coalesce(sum(i.quantity), 0) from public.purchase_items i
                            join public.purchases p on p.id = i.purchase_id
                            where p.retailer_id = v_ret and (v_role = 'admin' or p.store_id = v_store)),
    'customers_served',   (select count(distinct p.customer_id) from public.purchases p
                            where p.retailer_id = v_ret and (v_role = 'admin' or p.store_id = v_store)),
    'registered_customers', (select count(*) from public.profiles),
    'consent_granted',    (select count(*) from public.consent_records k
                            where k.retailer_id = v_ret and (v_role = 'admin' or k.store_id = v_store) and k.consent_given),
    'consent_declined',   (select count(*) from public.consent_records k
                            where k.retailer_id = v_ret and (v_role = 'admin' or k.store_id = v_store) and not k.consent_given)
  ) into r;
  return r;
end;
$$;

create or replace function public.portal_transactions(p_limit int default 20, p_offset int default 0, p_search text default null)
returns table (
  purchase_id uuid, transaction_ref text, bill_no text, purchased_at timestamptz,
  store_name text, store_branch text, customer_code text, customer_name text,
  item_count bigint, units bigint, total_amount numeric, staff_name text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_ret uuid := public.staff_retailer_id();
  v_role text := public.staff_role();
  v_store uuid := public.staff_store_id();
  v_q text := nullif(btrim(coalesce(p_search, '')), '');
begin
  if v_ret is null then
    raise exception 'This account is not an active retailer account.' using errcode = '42501';
  end if;
  return query
  select p.id, p.transaction_ref, p.bill_no, p.purchased_at, p.store_name, p.store_branch,
         c.customer_code,
         split_part(btrim(coalesce(c.full_name, 'Customer')), ' ', 1)
           || coalesce(' ' || left(nullif(split_part(btrim(coalesce(c.full_name, '')), ' ', 2), ''), 1) || '.', ''),
         (select count(*) from public.purchase_items i where i.purchase_id = p.id),
         (select coalesce(sum(i.quantity), 0) from public.purchase_items i where i.purchase_id = p.id)::bigint,
         p.total_amount,
         sf.full_name
  from public.purchases p
  join public.profiles c on c.id = p.customer_id
  left join public.retailer_staff sf on sf.user_id = p.staff_id
  where p.retailer_id = v_ret
    and (v_role = 'admin' or p.store_id = v_store)
    and (v_q is null or p.transaction_ref ilike '%' || v_q || '%'
                     or p.bill_no ilike '%' || v_q || '%'
                     or c.customer_code ilike '%' || v_q || '%')
  order by p.purchased_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

revoke all on function public.portal_dashboard_stats() from public, anon;
revoke all on function public.portal_transactions(int, int, text) from public, anon;
grant execute on function public.portal_dashboard_stats() to authenticated;
grant execute on function public.portal_transactions(int, int, text) to authenticated;


-- ---------------------------------------------------------------------
-- 9. Bootstrap helper: turn an existing login into the first retailer admin
--    (run from the SQL Editor only; not callable from the app)
--    select public.bootstrap_staff('admin@freshmart.test', 'admin', 'Ravi Kumar', 'FreshMart', 'FreshMart', 'Indiranagar');
-- ---------------------------------------------------------------------
create or replace function public.bootstrap_staff(
  p_email text, p_role text, p_full_name text,
  p_retailer_name text, p_store_name text, p_store_branch text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  u uuid;
  r uuid;
  st uuid;
begin
  select id into u from auth.users where lower(email) = lower(btrim(p_email));
  if u is null then
    raise exception 'No login with email %. Create it first: Dashboard -> Authentication -> Users -> Add user (tick Auto Confirm).', p_email;
  end if;
  if exists (select 1 from public.purchases where customer_id = u) then
    raise exception '% is a real customer with purchases. Use a different email for the retailer login.', p_email;
  end if;

  -- retailer logins must not also be customers
  update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"account_type":"retailer"}' where id = u;
  delete from public.profiles where id = u;

  select id into r from public.retailers where name = p_retailer_name limit 1;
  if r is null then insert into public.retailers (name) values (p_retailer_name) returning id into r; end if;

  select id into st from public.retail_stores
  where retailer_id = r and name = p_store_name and branch is not distinct from p_store_branch limit 1;
  if st is null then
    insert into public.retail_stores (retailer_id, name, branch) values (r, p_store_name, p_store_branch) returning id into st;
  end if;

  insert into public.retailer_staff (user_id, retailer_id, store_id, full_name, role, active)
  values (u, r, st, p_full_name, p_role, true)
  on conflict (user_id) do update
    set retailer_id = excluded.retailer_id, store_id = excluded.store_id,
        full_name = excluded.full_name, role = excluded.role, active = true;

  return format('%s is now a retailer %s at %s%s', p_email, p_role, p_store_name, coalesce(' · ' || p_store_branch, ''));
end;
$$;
revoke all on function public.bootstrap_staff(text, text, text, text, text, text) from public, anon, authenticated;
