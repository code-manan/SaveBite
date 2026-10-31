// SaveBite Retailer API — Supabase Edge Function (Deno)
//
// The ONLY place where retailer actions that touch customer data happen.
// The browser sends the retailer's login token; this function checks who they are,
// validates the input, then calls server-only database functions with the service role.
// The service-role key lives in Supabase's environment and never reaches the browser.
//
// Actions (POST JSON { action, ... }):
//   lookup_customer  { method: "phone"|"customer_code"|"email", value }
//   submit_bill      { verification_id, idempotency_key, items[], consent_given, bill_no? }
//   create_staff     { email, password, full_name, role, store_id }          (admin only)
//   set_staff_active { user_id, active }                                     (admin only)

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Set ALLOWED_ORIGIN to your portal's address in production (see README). "*" is fine for a hackathon demo.
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim().length > 0 && v.length <= max ? v.trim() : null);

// Turn a database error into a friendly HTTP error
function fromDb(error: { message: string; code?: string }): HttpError {
  if (error.code === "42501") return new HttpError(403, error.message);
  if (error.code === "54000") return new HttpError(429, error.message);
  if (error.code === "P0001") return new HttpError(400, error.message);   // our own "raise exception" messages
  console.error("database error", error);
  return new HttpError(500, "Something went wrong on the server. Please try again.");
}

async function authenticate(req: Request) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "Please sign in.");
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "Your session has expired. Please sign in again.");
  const { data: staff, error: staffError } = await admin
    .from("retailer_staff").select("user_id, retailer_id, store_id, role, active")
    .eq("user_id", data.user.id).maybeSingle();
  if (staffError) throw fromDb(staffError);
  if (!staff || !staff.active) throw new HttpError(403, "This account is not authorised for the SaveBite Retailer Portal.");
  return { userId: data.user.id, staff };
}

async function lookupCustomer(userId: string, body: Record<string, unknown>) {
  const method = body.method;
  const value = str(body.value, 100);
  if (method !== "phone" && method !== "customer_code" && method !== "email") throw new HttpError(400, "Choose phone, SaveBite ID or email.");
  if (!value) throw new HttpError(400, "Enter the customer's phone number, SaveBite ID or email.");
  const { data, error } = await admin.rpc("lookup_customer", { p_staff: userId, p_method: method, p_value: value });
  if (error) throw fromDb(error);
  if (!data?.found) throw new HttpError(404, "No SaveBite customer found with those details. Ask the customer to check their SaveBite ID in the app.");
  return data;
}

async function submitBill(userId: string, body: Record<string, unknown>) {
  const verification = body.verification_id;
  const key = str(body.idempotency_key, 64);
  if (typeof verification !== "string" || !UUID.test(verification)) throw new HttpError(400, "Customer verification is missing. Look up the customer first.");
  if (!key || key.length < 8) throw new HttpError(400, "Bill reference is missing. Start the bill again.");
  if (typeof body.consent_given !== "boolean") throw new HttpError(400, "The customer's consent decision is required.");
  const consent = body.consent_given;

  let items: unknown[] = [];
  if (consent) {
    const rawItems = body.items;
    if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 100) throw new HttpError(400, "A bill needs between 1 and 100 items.");
    // Whitelist the fields we pass on; the database validates their values again.
    items = rawItems.map((raw, i) => {
      if (!isObj(raw)) throw new HttpError(400, `Item ${i + 1}: invalid data.`);
      return {
        name: raw.name, category: raw.category, quantity: raw.quantity, expiry_date: raw.expiry_date,
        barcode: raw.barcode, batch_no: raw.batch_no, unit_price: raw.unit_price,
      };
    });
  }
  const billNo = body.bill_no == null || body.bill_no === "" ? null : str(body.bill_no, 40);
  if (body.bill_no != null && body.bill_no !== "" && !billNo) throw new HttpError(400, "Bill number is too long.");

  const { data, error } = await admin.rpc("submit_bill", {
    p_staff: userId,
    p_verification: verification,
    p_idempotency_key: key,
    p_items: items,
    p_consent_given: consent,
    p_consent_method: "counter_confirmation",
    p_bill_no: billNo,
  });
  if (error) throw fromDb(error);
  return data;
}

async function requireAdmin(ctx: Awaited<ReturnType<typeof authenticate>>) {
  if (ctx.staff.role !== "admin") throw new HttpError(403, "Only a store administrator can manage the team.");
}

async function createStaff(ctx: Awaited<ReturnType<typeof authenticate>>, body: Record<string, unknown>) {
  await requireAdmin(ctx);
  const email = str(body.email, 200)?.toLowerCase();
  const password = typeof body.password === "string" ? body.password : "";
  const fullName = str(body.full_name, 80);
  const role = body.role;
  const storeId = body.store_id;
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "Enter a valid email address.");
  if (password.length < 8 || password.length > 72) throw new HttpError(400, "Password must be 8 to 72 characters.");
  if (!fullName) throw new HttpError(400, "Enter the employee's name.");
  if (role !== "admin" && role !== "employee") throw new HttpError(400, "Role must be admin or employee.");
  if (typeof storeId !== "string" || !UUID.test(storeId)) throw new HttpError(400, "Choose a store.");

  const { data: store } = await admin.from("retail_stores").select("id").eq("id", storeId).eq("retailer_id", ctx.staff.retailer_id).maybeSingle();
  if (!store) throw new HttpError(400, "That store does not belong to your company.");

  const { data: created, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
    app_metadata: { account_type: "retailer" },   // keeps this login out of the customer profiles table
    user_metadata: { full_name: fullName },
  });
  if (error || !created.user) {
    const taken = /already|registered|exists/i.test(error?.message ?? "");
    throw new HttpError(taken ? 409 : 400, taken ? "That email address already has a SaveBite account. Use a different one." : (error?.message ?? "Could not create the login."));
  }
  const { error: insertError } = await admin.from("retailer_staff").insert({
    user_id: created.user.id, retailer_id: ctx.staff.retailer_id, store_id: storeId, full_name: fullName, role, active: true,
  });
  if (insertError) {
    await admin.auth.admin.deleteUser(created.user.id);   // don't leave a half-created login behind
    throw fromDb(insertError);
  }
  return { user_id: created.user.id };
}

async function setStaffActive(ctx: Awaited<ReturnType<typeof authenticate>>, body: Record<string, unknown>) {
  await requireAdmin(ctx);
  const target = body.user_id;
  if (typeof target !== "string" || !UUID.test(target)) throw new HttpError(400, "Invalid employee.");
  if (typeof body.active !== "boolean") throw new HttpError(400, "Invalid request.");
  if (target === ctx.userId) throw new HttpError(400, "You can't deactivate your own account.");
  const { data, error } = await admin.from("retailer_staff").update({ active: body.active })
    .eq("user_id", target).eq("retailer_id", ctx.staff.retailer_id).select("user_id");
  if (error) throw fromDb(error);
  if (!data || data.length === 0) throw new HttpError(404, "Employee not found.");
  return { ok: true };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  try {
    const ctx = await authenticate(req);
    let body: unknown;
    try { body = await req.json(); } catch { throw new HttpError(400, "Invalid request."); }
    if (!isObj(body)) throw new HttpError(400, "Invalid request.");

    switch (body.action) {
      case "lookup_customer":  return json(await lookupCustomer(ctx.userId, body));
      case "submit_bill":      return json(await submitBill(ctx.userId, body));
      case "create_staff":     return json(await createStaff(ctx, body));
      case "set_staff_active": return json(await setStaffActive(ctx, body));
      default: throw new HttpError(400, "Unknown action.");
    }
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "Something went wrong on the server. Please try again." }, 500);
  }
});
