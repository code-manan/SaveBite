# SaveBite

SaveBite is a grocery food-waste reduction web application. It connects a retailer billing workflow with a customer's personal inventory so customers can see the packed products they bought and their expiry dates.

## Project structure

```text
SaveBite/
├── customer-app/                 # Customer-facing web application (static HTML/CSS/JS)
│   ├── index.html
│   ├── style.css
│   ├── script.js
│   └── supabase/
│       ├── schema.sql            # Base customer database schema
│       └── test_bill.sql         # Legacy/manual test bill helper
├── retailer-portal/              # Retailer-facing portal and backend integration
│   ├── portal/                   # Static retailer portal (deploy this folder to Netlify)
│   ├── supabase/
│   │   ├── config.toml
│   │   ├── migrations/           # Retailer tables, policies and database functions
│   │   └── functions/retailer-api/ # Supabase Edge Function
│   └── customer-app-patch/       # Optional customer signup phone-field patch
├── .gitignore
└── README.md
```

## How it works

1. A customer creates an account in the Customer App and gets a SaveBite customer ID.
2. A retailer employee signs in to the Retailer Portal and looks up the customer.
3. The cashier asks for the customer's permission to share the purchase.
4. If the customer agrees, the retailer portal sends the bill and product expiry details to the Supabase Edge Function.
5. Supabase validates and stores the purchase. The customer app reads only that customer's records and can update live through Supabase Realtime.

## Technology

- Frontend: HTML, CSS and JavaScript
- Authentication, database, Row Level Security and Realtime: Supabase
- Retailer backend: Supabase Edge Function (Deno/TypeScript)
- Static hosting: Netlify (customer app and retailer portal can be separate Netlify sites)

## Run the frontends locally

Both frontends are static websites. You can use VS Code Live Server, or run a simple static server in the relevant folder:

```bash
npx serve customer-app
```

For the retailer portal:

```bash
npx serve retailer-portal/portal
```

The portal also needs the Supabase database migration and deployed `retailer-api` Edge Function described in [Retailer Portal setup](retailer-portal/README.md).

## Supabase setup

1. Create or use one Supabase project for both apps.
2. Run `customer-app/supabase/schema.sql` first in the Supabase SQL Editor if the customer schema is not already installed.
3. Follow [retailer-portal/README.md](retailer-portal/README.md) to run the retailer migrations, create the demo retailer account, deploy the Edge Function, and configure the portal.
4. The browser apps use the Supabase **publishable** key. The Supabase **secret/service-role** key must remain inside Supabase's server-side Edge Function environment and must never be committed to GitHub or placed in frontend files.

## Deploy on Netlify

Create two Netlify sites if you want both interfaces online:

- Customer site: publish directory / base directory `customer-app`
- Retailer site: publish directory / base directory `retailer-portal/portal`

The database and retailer API are hosted by Supabase, not by Netlify or GitHub. Keep the Supabase project active and the Edge Function deployed for the complete workflow to continue working.

## Important notes for reviewers

- This repository contains the application source code and database setup scripts. It does not contain the live database records or Supabase account credentials.
- The publishable Supabase key in browser configuration is designed to be public; database access must be protected by the configured Row Level Security policies.
- Never add `.env` files, Supabase secret/service-role keys, database passwords, customer personal data, or real customer bills to this repository.
- The phone signup patch is optional if the demo uses the customer's SaveBite ID instead. See the retailer README for details.
- Known demo limitations and security considerations are documented in [retailer-portal/README.md](retailer-portal/README.md).

## License

No license has been selected yet. All rights are reserved by the project authors unless a license is added.
