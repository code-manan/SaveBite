# SaveBite Retailer Portal + Backend

Stores bill a customer, the customer says yes, and the products land in the customer's **existing** SaveBite app with their expiry dates.
Both apps share **one Supabase project**. The customer app is unchanged except for one optional field (phone number at signup).

```
 Cashier's browser                Supabase Edge Function            Postgres (RLS on)              Customer's SaveBite app
 ─────────────────                ──────────────────────            ─────────────────              ───────────────────────
 Retailer Portal  ── login token ─► retailer-api  ── service role ─► lookup_customer()
 (portal/)                          checks staff + validates         submit_bill()  ──► purchases ──► realtime ──► shows new items
                                                                     (atomic, one transaction)  purchase_items
                                                                     consent_records
```

## 1. How the existing customer app works (what I found)

| Thing | What it is |
|---|---|
| Auth | Supabase email + password. A trigger creates a `profiles` row with a short `customer_code` like `SB-7K3Q9` |
| Tables | `profiles`, `purchases` (one per bill), `purchase_items` (one per product, with `expiry_date`) |
| Customer access | Read-only through RLS (`customer_id = auth.uid()`); the app only ever `select`s named columns |
| Store access | `record_purchase()`, callable only by the service role |
| Live updates | `purchase_items` is in the `supabase_realtime` publication, so new items appear without a refresh |

**Compatibility gaps this project fills** (all additive, nothing dropped or renamed):

- Customers had **no phone number or email lookup** → added `profiles.phone`; email is looked up in `auth.users` (confirmed emails only).
- `record_purchase()` has **no consent, retailer, idempotency or batch fields** → new `submit_bill()` adds them. The old function still works (your `test_bill.sql` keeps working).
- No retailer concept at all → new tables below.

## 2. What's in this folder

```
savebite-retailer/
├─ supabase/
│  ├─ migrations/01_retailer_system.sql   tables, RLS, lookup_customer(), submit_bill(), portal_*() functions
│  ├─ migrations/02_demo_data.sql         first admin, FreshMart store, 14 demo products
│  └─ functions/retailer-api/index.ts     the Edge Function (lookup, submit, create/deactivate staff)
├─ portal/                                the Retailer Portal (plain HTML/CSS/JS, no build step)
│  ├─ index.html  css/portal.css  js/app.js  js/config.js  logo.svg
└─ customer-app-patch/                    2-line change so customers can enter a phone at signup (optional)
```

## 3. Setup (about 20 minutes)

You need the Supabase project your customer app already uses, plus the [Supabase CLI](https://supabase.com/docs/guides/cli) (`npm i -g supabase`) for step 5.

1. **Customer schema first.** If you haven't already, run the customer app's `supabase/schema.sql` in *SQL Editor*.
2. **Run the retailer migration.** SQL Editor → new query → paste `supabase/migrations/01_retailer_system.sql` → Run. Safe to re-run.
3. **Create the demo admin login.** *Authentication → Users → Add user → Create new user*: `admin@freshmart.test` + a password, tick **Auto Confirm User**.
4. **Load demo data.** Paste `supabase/migrations/02_demo_data.sql` → Run. The last query should show `1, 1, 1, 14`.
5. **Deploy the Edge Function.**
   ```bash
   supabase login
   supabase link --project-ref YOUR_PROJECT_REF      # the xxxx in https://xxxx.supabase.co
   supabase functions deploy retailer-api
   ```
   Supabase injects the service-role key into the function automatically. You never paste it anywhere.
6. **Point the portal at your project.** Edit `portal/js/config.js`: paste the **Project URL** and the **publishable** key (*Project Settings → API Keys*). Never the secret key.
7. **Host the portal.** Drag the `portal/` folder onto Netlify (like your customer site) → you get a second URL.
   To test locally instead: `cd portal && npx serve` and open the printed address.
8. **(Optional) lock the function to your portal.** Dashboard → *Edge Functions → Secrets* (or `supabase secrets set ALLOWED_ORIGIN=https://your-portal.netlify.app`). Until you do, any website may call it, though it still needs a valid retailer login.
9. **Customer app phone field (optional).** Replace the customer `index.html` and `script.js` with the ones in `customer-app-patch/`, or apply the `.diff` files. Re-paste your Supabase URL and key into `script.js`. If you skip this, set a phone by SQL (see Demo below).

No Supabase "Site URL" change is needed for the portal: it only uses email + password.

## 4. Demo script (the 11 steps)

**Before the demo:**
1. In the **customer app**, sign up as e.g. *Asha Verma*, mobile `98765 43210` (with the patched app). Note the SaveBite ID on her dashboard.
   *Without the patch:* run `update public.profiles set phone = public.normalize_phone('98765 43210') where customer_code = 'SB-XXXXXX';`
2. Leave Asha logged in on a second window or phone, so you can show the live update.

**On stage:**

| # | Do this | You'll see |
|---|---|---|
| 1–2 | Open the portal, sign in as `admin@freshmart.test` | Dashboard with stats |
| 3 | **New bill** → *Phone number* tab → `98765 43210` → *Find customer* | "Asha V.", her SaveBite ID, "phone ending 10". Nothing else about her |
| 4–5 | *This is the customer* → click the barcode box → type `8901000000011` + Enter (a USB scanner does this itself) | Name and category fill in. Enter quantity **2**, expiry from the pack, batch `B77`, price `60`, *Add to bill* |
|   | Repeat with `8901000000028` (yogurt, expiry in ~4 days) and `8901000000035` (bread, expiry in ~5 days) | Three lines in *Current bill* |
| 6 | *Review bill* | Full bill with batch and expiry |
| 7 | Ask the customer: the consent question on screen | Two buttons, no default |
| 8 | **Yes, share my purchase with SaveBite** | Green tick and a transaction ID like `SBT-261031-7K3Q9X` |
| 9–11 | Switch to Asha's SaveBite app | Badge says **Live**. The 3 products appear within ~2 seconds, store shown as *FreshMart · Indiranagar* |

Also worth showing: click **No** on another bill (nothing is sent, the decision is logged and the dashboard consent rate drops), the **Transactions** page (click a row for its products), and **Team** (create a cashier login; log in as them and notice there is no Team page).

## 5. Roles

| | Employee | Administrator |
|---|---|---|
| Find customer, bill, submit | ✓ | ✓ |
| See transactions | own store only | every store of the retailer |
| Add / edit catalogue products | ✓ | ✓ |
| Delete catalogue products | | ✓ |
| Create / deactivate staff | | ✓ |

A customer account that tries the portal login is signed straight out: access requires an active row in `retailer_staff`, which only the server can create.

## 6. Security: what protects what

| Requirement | How |
|---|---|
| RLS everywhere | Enabled on every table. Customers: read own rows only (unchanged). Staff: read only their retailer/store's bills, items, consent records, catalogue |
| Only the server inserts bills | `purchases`, `purchase_items`, `consent_records` have **no** insert grant for browsers. `submit_bill()` is executable by `service_role` only |
| No secrets in the browser | Portal holds only the publishable key. The service-role key exists only inside the Edge Function's environment |
| Customer verified server-side | `lookup_customer()` finds the customer and issues a 30-minute, single-use verification bound to that cashier. `submit_bill()` refuses anything without one |
| Consent enforced server-side | `submit_bill()` needs an explicit `consent_given = true`. Entering a phone number never counts. A "No" is recorded but shares nothing |
| Consent record | `consent_records`: customer, store, cashier, exact consent wording, timestamp, transaction ID |
| Privacy of customers | Cashiers see a masked name ("Asha V."), SaveBite ID and last 2 phone digits. They have no read access to `profiles` or to any other store's bills |
| Guessing protection | 15 failed lookups in 10 minutes pauses that cashier |
| Input validation | Edge Function whitelists fields; database re-validates names, categories, quantities (1–1000), expiry (valid, not past, ≤20 years), batch, barcode, price |
| Duplicate submissions | The portal makes one bill reference per bill; `submit_bill()` locks the verification and has a unique index on `(retailer_id, idempotency_key)`. A double click or retry returns the first bill |
| No half-saved bills | `submit_bill()` is one database transaction: any bad item rolls back the whole bill |
| Staff logins stay out of customer tables | Staff are created with `app_metadata.account_type = 'retailer'`, which the signup trigger skips. A customer cannot set `app_metadata` |

## 7. Honest limitations

- **Consent is attested by the cashier.** The cashier asks the customer and clicks. The system records who clicked and when, but it does not cryptographically prove the customer agreed. For a production system, add an OTP or an in-app approval prompt on the customer's phone. That would be a natural next step after the hackathon.
- **Phone numbers are matched on the last 10 digits** (India-style). Change `normalize_phone()` for other countries.
- **Email lookup** works only for confirmed emails. With *Confirm email* off (the customer README's hackathon setting), Supabase auto-confirms, so it works in the demo.
- **Barcode scanning** uses a normal USB/Bluetooth scanner (it types the digits + Enter) or typing. There is no camera scanning.
- **Catalogue and prices are demo-grade.** Barcodes in `02_demo_data.sql` are made up. Expiry is always typed from the pack; it is never guessed.
- `record_purchase()` from the customer schema still exists (service role only, no consent check). Run `revoke execute on function public.record_purchase(text,text,jsonb,text,text,numeric) from service_role;` once you no longer need `test_bill.sql`.
- The Edge Function was syntax-checked but I could not deploy it to your Supabase project from here. Run the Demo script once end to end before presenting.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| "Setup needed" on login | Fill in `portal/js/config.js` |
| "Couldn't load your store account… migration" | Run `01_retailer_system.sql` |
| "This account isn't authorised" | The login has no `retailer_staff` row. Run `02_demo_data.sql` step 1 for that email |
| `bootstrap_staff` says "No login with email" | Create the user first in Authentication → Users |
| "The retailer-api function isn't deployed" | Step 5. After deploying, check *Edge Functions → retailer-api → Logs* |
| Browser console shows a CORS error | Redeploy the function. If you set `ALLOWED_ORIGIN`, it must exactly match the portal's address (no trailing slash) |
| "No SaveBite customer found" | Wrong phone/ID, or the customer never entered a phone (see Setup 9) |
| Items don't appear live in the customer app | They still appear on refresh. Check the last block of the customer `schema.sql` ran (realtime) |
| "Customer verification expired" | More than 30 minutes passed. Click *Look up the customer again*. Your items are kept |
