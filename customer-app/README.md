# SaveBite — customer app (store-billing version)

Customers sign in and **see what their stores sold them, with expiry dates**. They cannot add or delete
anything: the store sends the items at billing, straight into the customer's account.

```
 Store billing system                        Supabase                         Customer's browser
 ───────────────────                  ───────────────────────             ──────────────────────
 scans items + customer's SaveBite ID ─►  record_purchase()  ─► tables  ─►  this web app
 (only if customer said "yes")             (server-only)       (RLS)         (read-only, live)
```

## Files

| File | What it is |
|---|---|
| `index.html`, `style.css`, `script.js` | The customer web app (plain HTML/CSS/JS, no build step) |
| `supabase/schema.sql` | Creates the tables, security rules, signup trigger and the `record_purchase` function |
| `supabase/test_bill.sql` | Pretends to be a store and sends a test bill to a customer |

## Set up Supabase (about 10 minutes)

1. **Create a project** at supabase.com → New project. Save the database password somewhere (you won't need it in the app).
2. **Create the tables.** Dashboard → *SQL Editor* → *New query* → paste all of `supabase/schema.sql` → *Run*.
3. **Make signup quick for the hackathon.** *Authentication → Sign In / Providers → Email* → turn **Confirm email** off.
   (Otherwise every test account needs an email click before it can sign in.)
4. **Copy two values into `script.js`** (top of the file). Dashboard → *Project Settings → API Keys*:
   - `SUPABASE_URL` ← the Project URL
   - `SUPABASE_PUBLISHABLE_KEY` ← the **publishable** key (`sb_publishable_…`).
   The publishable key is safe to put in the browser. **Never** paste the *secret* key here.
5. **Tell Supabase where the app runs.** *Authentication → URL Configuration* → set **Site URL** to the address you serve the app from
   (e.g. `http://127.0.0.1:5500` while developing, your Vercel/Netlify URL later).
6. **Run the app from a local server, not by double-clicking the file** (login redirects don't work from `file://`).
   In VS Code use the *Live Server* extension → "Go Live", or run `npx serve` in this folder.
7. **Sign up** in the app. You land on the dashboard and see your **SaveBite ID** (like `SB-7K3Q9`).
8. **Play the store.** Open `supabase/test_bill.sql`, replace `SB-XXXXXX` with your ID, run it in the SQL Editor.
   Keep the app open: the items appear on their own and the badge at the top shows **Live**.

No Supabase yet? Click **Preview with sample data** on the login screen (or open `index.html#demo`) to see the whole UI with demo bills.

## How the store sends a bill

The store's billing software (or your demo backend) calls one function, **from a server**, using the **secret key**
(Project Settings → API Keys → Secret keys). Never put that key in a web page or an app a customer can open.

```js
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY); // server only

const { data: purchaseId, error } = await supabase.rpc("record_purchase", {
  p_customer_code: "SB-7K3Q9",        // the ID the customer showed at the counter
  p_store_name:    "FreshMart",
  p_store_branch:  "Indiranagar",
  p_bill_no:       "FM-20931",
  p_total_amount:  482.5,
  p_items: [
    { name: "Whole milk 1 L carton", category: "Dairy", quantity: 2, expiry_date: "2026-11-05", barcode: "8901234567890" },
    { name: "Sliced bread (packed)", category: "Bakery", quantity: 1, expiry_date: "2026-11-08" }
  ]
});
```

Rules the store should follow:
- Call it **only when the customer said yes** to "Would you like your items and expiry dates in SaveBite?"
- Send only **packed items that have an expiry date** (`expiry_date` is required, format `YYYY-MM-DD`).
- One call = one bill. It is all-or-nothing: if any item is invalid, nothing is saved.

## How the app stays safe

- **Row Level Security** is on for every table. A signed-in customer can `select` only rows where `customer_id` is their own id.
  Even if someone opens the browser console and tries `supabase.from("purchase_items").select("*")`, they only get their own rows.
- Customers have **no** insert / update / delete rights. The only way to create data is `record_purchase`,
  and only the server-side secret key can run it.
- The browser only ever holds the publishable key.

## How notifications work

- **In the app:** the Notifications page and the red badge are worked out from each item's expiry date
  (expiring within 7 days, expired) plus any bill received in the last 3 days.
- **Browser alerts:** the "Turn on browser alerts" button asks permission and then shows one summary alert per day —
  **only while SaveBite is open in a tab**.
- **Not included yet:** alerts when the app is closed. That needs a scheduled job + email or web push
  (Supabase *Edge Function* + `pg_cron`, sending email with Resend, for example).

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Setup needed…" on the login screen | Paste the URL and publishable key into `script.js`, refresh |
| "Database error saving new user" when signing up | `schema.sql` didn't finish. Re-run it and look for a red error |
| "Account created. Check your email…" | Email confirmation is still on (step 3) |
| SaveBite ID shows "Not ready" | The profile row is missing. Re-run `schema.sql` (it creates profiles for existing users) |
| Dashboard empty after `test_bill.sql` | You used a wrong ID (the function errors with "Unknown SaveBite ID"), or you're signed in as a different user |
| Badge says **Up to date** instead of **Live** | Realtime isn't connected. The app still works. Reload to fetch new bills. Check the last block of `schema.sql` ran |
| Login works then bounces back | Site URL (step 5) doesn't match the address in your browser bar |

## Settings you may want to change (top of `script.js`)

`EXPIRING_DAYS` (default 7), `HIDE_AFTER_DAYS` (default 90: long-expired items are hidden from lists, never deleted),
`NEW_PURCHASE_DAYS` (default 3).

## Note about the current Retailer Portal integration

For the integrated SaveBite demo, the Retailer Portal calls the `retailer-api` Supabase Edge Function, which validates the retailer session and submits bills through the newer `submit_bill()` database function. `record_purchase()` and `test_bill.sql` are retained as legacy/manual testing helpers; they are not the normal Retailer Portal submission path. See `../retailer-portal/README.md` for the current end-to-end setup.
