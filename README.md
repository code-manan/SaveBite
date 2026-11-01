# SaveBite 🥛⏰

Stores bill a customer, the customer says yes, and the products land in the customer's SaveBite app with their expiry dates, so food gets used before it is wasted.

## 🔗 Live demo

| Portal | Who uses it | Link |
|---|---|---|
| **Customer App** | Shoppers: sign up, get a SaveBite ID, see items and expiry dates | https://helpful-beignet-d23553.netlify.app/ |
| **Retailer Portal** | Store staff: find a customer by SaveBite ID / phone and add a bill | https://marvelous-parfait-2b58b6.netlify.app/ |

**Demo login (retailer portal):** `admin@freshmart.test` / `123456`
**Customer app:** sign up with any email.

## How it works

1. Customer signs up and gets a SaveBite ID (e.g. `SB-7K3Q9`).
2. At the counter, the cashier looks the customer up in the Retailer Portal (ID or phone) and, with consent, adds the bill's products with expiry dates.
3. Items appear live in the customer's app.

Both apps share one Supabase project (Postgres + Row Level Security + an Edge Function).

## Repo structure

```
SaveBite/
├─ customer-app/       Customer web app (HTML/CSS/JS) + supabase/schema.sql
└─ retailer-portal/
   ├─ portal/          Retailer web app (HTML/CSS/JS)
   ├─ supabase/        Migrations + retailer-api Edge Function
   └─ customer-app-patch/   Optional phone-number field for customer signup
```

## Run it yourself

See [`customer-app/README.md`](customer-app/README.md) and [`retailer-portal/README.md`](retailer-portal/README.md) for full Supabase setup. In short: create a Supabase project, run the SQL files, paste your Project URL and publishable key into `customer-app/script.js` and `retailer-portal/portal/js/config.js`, and serve each folder with any static host (`npx serve`).

## Tech

HTML, CSS, JavaScript · Supabase (Auth, Postgres, Realtime, Edge Functions) · Netlify/Vercel hosting

## Team

- TripleDev
