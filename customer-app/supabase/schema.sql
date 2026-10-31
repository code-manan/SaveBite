-- =====================================================================
-- SaveBite — database setup
-- Paste this whole file into: Supabase Dashboard → SQL Editor → New query → Run
-- Safe to run more than once.
--
-- The idea:
--   * profiles        one row per customer (holds their SaveBite ID)
--   * purchases       one row per bill a store sent
--   * purchase_items  one row per product on that bill, with its expiry date
--   * customers can only READ their own rows (Row Level Security)
--   * stores WRITE through record_purchase(), which only your server can call
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Short, readable customer ID such as SB-7K3Q9 (no 0/O/1/I to avoid typos at the counter)
-- ---------------------------------------------------------------------
create or replace function public.generate_customer_code()
returns text
language plpgsql
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code text;
  i int;
begin
  loop
    code := 'SB-';
    for i in 1..6 loop
      code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.profiles where customer_code = code);
  end loop;
  return code;
end;
$$;


-- ---------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  full_name     text,
  customer_code text not null unique default public.generate_customer_code(),
  created_at    timestamptz not null default now()
);

create table if not exists public.purchases (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references public.profiles (id) on delete cascade,
  store_name   text not null,
  store_branch text,
  bill_no      text,
  total_amount numeric(10, 2),
  purchased_at timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create table if not exists public.purchase_items (
  id          uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.purchases (id) on delete cascade,
  customer_id uuid not null references public.profiles (id) on delete cascade,   -- copied from the bill: keeps security rules and live updates simple
  name        text not null,
  category    text not null default 'Other',
  quantity    integer not null default 1 check (quantity > 0),
  barcode     text,
  expiry_date date not null,
  created_at  timestamptz not null default now()
);

create index if not exists purchases_customer_idx on public.purchases (customer_id, purchased_at desc);
create index if not exists items_customer_idx     on public.purchase_items (customer_id, expiry_date);
create index if not exists items_purchase_idx     on public.purchase_items (purchase_id);


-- ---------------------------------------------------------------------
-- 3. Create a profile automatically whenever someone signs up
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- People who already signed up while testing (before this trigger existed) get a profile too
insert into public.profiles (id, full_name)
select id, split_part(email, '@', 1) from auth.users
on conflict (id) do nothing;


-- ---------------------------------------------------------------------
-- 4. Row Level Security: a customer can read ONLY their own rows, and cannot change anything
-- ---------------------------------------------------------------------
alter table public.profiles       enable row level security;
alter table public.purchases      enable row level security;
alter table public.purchase_items enable row level security;

revoke all on public.profiles, public.purchases, public.purchase_items from anon, authenticated;
grant  select on public.profiles, public.purchases, public.purchase_items to authenticated;

drop policy if exists "customers read own profile" on public.profiles;
create policy "customers read own profile" on public.profiles
  for select to authenticated using (id = (select auth.uid()));

drop policy if exists "customers read own purchases" on public.purchases;
create policy "customers read own purchases" on public.purchases
  for select to authenticated using (customer_id = (select auth.uid()));

drop policy if exists "customers read own items" on public.purchase_items;
create policy "customers read own items" on public.purchase_items
  for select to authenticated using (customer_id = (select auth.uid()));

-- Note: there is deliberately NO insert / update / delete policy for customers.


-- ---------------------------------------------------------------------
-- 5. What the store calls at billing time
--    record_purchase('SB-7K3Q9', 'FreshMart', '[ {...item...}, ... ]', 'Indiranagar', 'FM-1042', 482.50)
--    Each item: { "name": "...", "category": "...", "quantity": 2, "expiry_date": "2026-11-05", "barcode": "..." }
-- ---------------------------------------------------------------------
create or replace function public.record_purchase(
  p_customer_code text,
  p_store_name    text,
  p_items         jsonb,
  p_store_branch  text    default null,
  p_bill_no       text    default null,
  p_total_amount  numeric default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer uuid;
  v_purchase uuid;
begin
  select id into v_customer
  from public.profiles
  where customer_code = upper(trim(p_customer_code));

  if v_customer is null then
    raise exception 'Unknown SaveBite ID: %', p_customer_code;
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'p_items must be a non-empty JSON array';
  end if;

  insert into public.purchases (customer_id, store_name, store_branch, bill_no, total_amount)
  values (v_customer, p_store_name, p_store_branch, p_bill_no, p_total_amount)
  returning id into v_purchase;

  insert into public.purchase_items (purchase_id, customer_id, name, category, quantity, barcode, expiry_date)
  select
    v_purchase,
    v_customer,
    item ->> 'name',
    coalesce(nullif(item ->> 'category', ''), 'Other'),
    coalesce((item ->> 'quantity')::int, 1),
    item ->> 'barcode',
    (item ->> 'expiry_date')::date
  from jsonb_array_elements(p_items) as item;

  return v_purchase;
end;
$$;

-- Only your trusted server (service role / secret key) may call it. Browsers and customers cannot.
revoke all on function public.record_purchase(text, text, jsonb, text, text, numeric) from public, anon, authenticated;
grant execute on function public.record_purchase(text, text, jsonb, text, text, numeric) to service_role;


-- ---------------------------------------------------------------------
-- 6. Live updates: let the app hear about new items the moment a store adds them
-- ---------------------------------------------------------------------
do $$
begin
  alter publication supabase_realtime add table public.purchase_items;
exception
  when duplicate_object then null;   -- already added
end
$$;
