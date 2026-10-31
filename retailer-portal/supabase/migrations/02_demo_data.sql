-- =====================================================================
-- SaveBite Retailer System — demo data
-- Run AFTER 01_retailer_system.sql and AFTER creating the demo retailer login.
--
-- Step 1  Dashboard → Authentication → Users → Add user → Create new user
--         email: admin@freshmart.test   password: (your choice)   tick "Auto Confirm User"
-- Step 2  Edit the email below if you used a different one, then Run this file.
-- =====================================================================

-- 1) Turn that login into the FreshMart admin (creates the retailer + store too)
select public.bootstrap_staff(
  'admin@freshmart.test',      -- the login you just created
  'admin',                     -- 'admin' or 'employee'
  'Ravi Kumar',                -- name shown in the portal
  'FreshMart',                 -- retailer
  'FreshMart',                 -- store name customers will see on their bills
  'Indiranagar'                -- branch
);

-- 2) Product catalogue (demo barcodes — not real GTINs). Scan or type these at the till.
insert into public.product_catalog (retailer_id, barcode, name, category)
select r.id, v.barcode, v.name, v.category
from public.retailers r
cross join (values
  ('8901000000011', 'Whole milk 1 L carton',      'Dairy'),
  ('8901000000028', 'Greek yogurt 400 g',         'Dairy'),
  ('8901000000035', 'Sliced bread (packed)',      'Bakery'),
  ('8901000000042', 'Orange juice 1 L carton',    'Beverages'),
  ('8901000000059', 'Rolled oats 1 kg',           'Groceries'),
  ('8901000000066', 'Potato chips 150 g',         'Snacks'),
  ('8901000000073', 'Cheddar cheese block 200 g', 'Dairy'),
  ('8901000000080', 'Frozen green peas 500 g',    'Frozen'),
  ('8901000000097', 'Butter cookies 300 g',       'Snacks'),
  ('8901000000103', 'Cola 2 L bottle',            'Beverages'),
  ('8901000000110', 'Peanut butter 340 g',        'Groceries'),
  ('8901000000127', 'Instant noodles (pack of 4)','Groceries'),
  ('8901000000134', 'Paneer 200 g',               'Dairy'),
  ('8901000000141', 'Hand wash 250 ml',           'Personal care')
) as v(barcode, name, category)
where r.name = 'FreshMart'
on conflict (retailer_id, barcode) do nothing;

-- 3) Give your DEMO CUSTOMER a phone number so the cashier can find them by phone.
--    First sign up in the customer app, copy the SaveBite ID from their dashboard, then:
--
--    update public.profiles set phone = public.normalize_phone('98765 43210') where customer_code = 'SB-XXXXXX';
--
--    (If you use the patched customer app, the phone number is saved at signup and you can skip this.)

-- Sanity check: should show 1 retailer, 1 store, 1 staff row, 14 products
select (select count(*) from public.retailers)      as retailers,
       (select count(*) from public.retail_stores)  as stores,
       (select count(*) from public.retailer_staff) as staff,
       (select count(*) from public.product_catalog) as products;
