-- =====================================================================
-- Pretend to be the store: send a bill to a customer.
-- 1. Sign up in the SaveBite app and copy your SaveBite ID from the dashboard.
-- 2. Replace SB-XXXXXX below with it, then Run this in the SQL Editor.
-- 3. Watch the app (keep it open): the items appear within a second or two.
-- Run it again with different items to send more bills.
-- =====================================================================
select public.record_purchase(
  p_customer_code := 'SB-XXXXXX',
  p_store_name    := 'FreshMart',
  p_store_branch  := 'Indiranagar',
  p_bill_no       := 'FM-' || (floor(random() * 90000) + 10000)::int,
  p_total_amount  := 482.50,
  p_items := jsonb_build_array(
    jsonb_build_object('name', 'Whole milk 1 L carton',  'category', 'Dairy',     'quantity', 2, 'expiry_date', current_date + 2),
    jsonb_build_object('name', 'Greek yogurt 400 g',     'category', 'Dairy',     'quantity', 1, 'expiry_date', current_date + 4),
    jsonb_build_object('name', 'Sliced bread (packed)',  'category', 'Bakery',    'quantity', 1, 'expiry_date', current_date + 5),
    jsonb_build_object('name', 'Orange juice 1 L carton','category', 'Beverages', 'quantity', 2, 'expiry_date', current_date + 14),
    jsonb_build_object('name', 'Rolled oats 1 kg',       'category', 'Groceries', 'quantity', 1, 'expiry_date', current_date + 120)
  )
);

-- To start over while testing (removes ALL bills for everyone — only do this on your test project):
-- delete from public.purchases;
