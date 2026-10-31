(() => {
  "use strict";

  /* =====================================================================
     SaveBite Retailer Portal
     - Reads (dashboard, transactions, catalogue, team) go straight to Supabase; Row Level Security
       limits every query to the signed-in retailer.
     - Anything that touches a customer (find customer, submit bill, create staff) goes through the
       "retailer-api" Edge Function. No secret key is ever used in this file.
     ===================================================================== */

  const CFG = window.SAVEBITE_CONFIG || {};
  const API_URL = `${(CFG.SUPABASE_URL || "").replace(/\/$/, "")}/functions/v1/retailer-api`;
  const PAGE = 20;

  /* ---------- helpers ---------- */
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const money = (v) => (v == null || v === "" ? "—" : Number(v).toLocaleString("en-IN", { style: "currency", currency: "INR" }));
  const pad = (n) => String(n).padStart(2, "0");
  const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const fmtDate = (s) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—");
  const fmtStamp = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—");
  const initials = (t) => (String(t || "").trim().split(/\s+/).slice(0, 2).map((s) => s[0]?.toUpperCase() || "").join("")) || "SB";
  const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

  let toastTimer;
  function toast(msg, isError = false) {
    $("toastText").textContent = msg;
    $("toast").classList.toggle("error", isError);
    $("toast").classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $("toast").classList.remove("show"), 3800);
  }
  function say(id, text, kind = "") {
    const el = $(id);
    el.textContent = text || "";
    el.className = `form-message ${kind}`.trim();
  }
  const busy = (btn, on, label) => {
    if (!btn) return;
    if (on) { btn.dataset.label = btn.textContent; btn.disabled = true; if (label) btn.textContent = label; }
    else { btn.disabled = false; if (btn.dataset.label) btn.textContent = btn.dataset.label; }
  };

  /* ---------- state ---------- */
  let sb = null;
  let me = null;             // { user, staff, store, retailerName }
  let signingOut = false;

  const freshBill = () => ({ key: newKey(), verification: null, items: [], step: 1 });
  let bill = freshBill();
  let method = "phone";
  let currentBarcode = "";
  let tx = { offset: 0, search: "", loading: false };
  let catalogue = [];
  let editingBarcode = null;

  /* ---------- server calls ---------- */
  async function api(action, payload = {}) {
    const { data } = await sb.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) throw new Error("Your session has expired. Please sign in again.");
    let res;
    try {
      res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, apikey: CFG.SUPABASE_PUBLISHABLE_KEY },
        body: JSON.stringify({ action, ...payload })
      });
    } catch {
      throw new Error("Can't reach the SaveBite server. Check the internet connection and try again.");
    }
    let body = {};
    try { body = await res.json(); } catch { /* non-JSON response */ }
    if (!res.ok) {
      const err = new Error(body.error || (res.status === 404 ? "The retailer-api function isn't deployed yet (see README step 5)." : `Request failed (${res.status}).`));
      err.status = res.status;
      throw err;
    }
    return body;
  }

  /* =====================================================================
     AUTH
     ===================================================================== */
  function showLogin() {
    $("loginScreen").hidden = false;
    $("appShell").hidden = true;
  }

  async function loadStaff(user) {
    const { data: staff, error } = await sb.from("retailer_staff")
      .select("user_id, retailer_id, store_id, full_name, role, active").eq("user_id", user.id).maybeSingle();
    if (error) throw error;
    if (!staff || !staff.active) return null;
    const [store, retailer] = await Promise.all([
      sb.from("retail_stores").select("id, name, branch").eq("id", staff.store_id).maybeSingle(),
      sb.from("retailers").select("name").eq("id", staff.retailer_id).maybeSingle()
    ]);
    return { user, staff, store: store.data, retailerName: retailer.data?.name || "" };
  }

  async function handleSession(session) {
    if (!session?.user) { if (me) { me = null; } showLogin(); return; }
    if (me && me.user.id === session.user.id) return;
    try {
      const ctx = await loadStaff(session.user);
      if (!ctx) {
        signingOut = true;
        await sb.auth.signOut();
        signingOut = false;
        showLogin();
        say("loginMessage", "This account isn't authorised for the Retailer Portal. Customers sign in on the SaveBite app.", "error");
        return;
      }
      me = ctx;
      startApp();
    } catch (e) {
      console.warn(e);
      showLogin();
      say("loginMessage", "Couldn't load your store account. Has the database migration been run? " + (e.message || ""), "error");
    }
  }

  async function initAuth() {
    const configured = /^https:\/\//.test(CFG.SUPABASE_URL || "") && !String(CFG.SUPABASE_URL).includes("PASTE_") &&
      CFG.SUPABASE_PUBLISHABLE_KEY && !String(CFG.SUPABASE_PUBLISHABLE_KEY).includes("PASTE_");
    $("loginForm").addEventListener("submit", onLogin);
    if (!configured) { showLogin(); say("loginMessage", "Setup needed: paste your Supabase URL and publishable key into js/config.js.", "error"); return; }
    if (!window.supabase?.createClient) { showLogin(); say("loginMessage", "The Supabase library did not load. Check your internet connection and refresh.", "error"); return; }
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_PUBLISHABLE_KEY);
    const { data } = await sb.auth.getSession();
    await handleSession(data.session);
    sb.auth.onAuthStateChange((_e, session) => setTimeout(() => { if (!signingOut) handleSession(session); }, 0));
  }

  async function onLogin(e) {
    e.preventDefault();
    if (!sb) { say("loginMessage", "Setup needed: paste your Supabase URL and publishable key into js/config.js.", "error"); return; }
    const email = $("loginEmail").value.trim();
    const password = $("loginPassword").value;
    if (!email || !password) { say("loginMessage", "Enter your email and password.", "error"); return; }
    busy($("loginSubmit"), true, "Signing in…");
    say("loginMessage", "");
    try {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } catch (err) {
      say("loginMessage", /invalid login/i.test(err.message) ? "Wrong email or password." : err.message, "error");
    } finally { busy($("loginSubmit"), false); }
  }

  async function logout() {
    await sb.auth.signOut();
    me = null; bill = freshBill(); resetBillUI(); $("loginPassword").value = "";
    showLogin();
  }

  function startApp() {
    $("loginScreen").hidden = true;
    $("appShell").hidden = false;
    const s = me.staff;
    $("staffName").textContent = s.full_name;
    $("staffRole").textContent = s.role === "admin" ? "Administrator" : "Employee";
    $("staffAvatar").textContent = initials(s.full_name);
    const place = me.store ? `${me.store.name}${me.store.branch ? " · " + me.store.branch : ""}` : me.retailerName;
    $("storeLabel").textContent = place;
    document.querySelectorAll(".admin-only").forEach((el) => (el.hidden = s.role !== "admin"));
    $("txScope").textContent = s.role === "admin" ? `Bills from every ${me.retailerName} store.` : "Bills from your store.";
    resetBillUI();
    setView("dashboard");
  }

  /* =====================================================================
     NAVIGATION
     ===================================================================== */
  const TITLES = { dashboard: "Dashboard", bill: "New bill", transactions: "Transactions", catalogue: "Product catalogue", team: "Team" };
  function setView(name) {
    if (name === "team" && me?.staff.role !== "admin") name = "dashboard";
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    $(`${name}View`).classList.add("active");
    document.querySelectorAll(".nav-link").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
    $("viewTitle").textContent = TITLES[name];
    $("sidebar").classList.remove("open");
    window.scrollTo({ top: 0 });
    if (name === "dashboard") loadDashboard();
    if (name === "transactions") loadTransactions(true);
    if (name === "catalogue") loadCatalogue();
    if (name === "team") loadTeam();
    if (name === "bill" && bill.step === 1) $("lookupValue").focus();
  }

  /* =====================================================================
     DASHBOARD
     ===================================================================== */
  async function loadDashboard() {
    const [stats, txs, items] = await Promise.all([
      sb.rpc("portal_dashboard_stats"),
      sb.rpc("portal_transactions", { p_limit: 8, p_offset: 0, p_search: null }),
      sb.from("purchase_items").select("name, quantity, expiry_date, created_at").order("created_at", { ascending: false }).limit(6)
    ]);
    if (stats.error) { toast("Couldn't load the dashboard: " + stats.error.message, true); return; }
    const s = stats.data;
    $("statBills").textContent = s.total_bills;
    $("statBills24").textContent = `${s.bills_24h} in the last 24 hours`;
    $("statCustomers").textContent = s.registered_customers;
    $("statServed").textContent = `${s.customers_served} served by this store`;
    $("statProducts").textContent = s.total_products;
    const asked = s.consent_granted + s.consent_declined;
    $("statConsent").textContent = asked ? `${Math.round((s.consent_granted / asked) * 100)}%` : "—";
    $("statConsentSub").textContent = asked ? `${s.consent_granted} of ${plural(asked, "customer")} said yes` : "No customers asked yet";
    $("consentYes").textContent = s.consent_granted;
    $("consentNo").textContent = s.consent_declined;
    $("consentYesBar").style.width = asked ? `${(s.consent_granted / asked) * 100}%` : "0";

    const rows = txs.data || [];
    $("recentTx").innerHTML = rows.map((t) => `<tr>
      <td><span class="mono">${esc(t.transaction_ref)}</span></td>
      <td>${esc(t.customer_name)}<span class="sub">${esc(t.customer_code)}</span></td>
      <td class="num">${t.item_count}</td><td class="num">${money(t.total_amount)}</td><td>${fmtStamp(t.purchased_at)}</td></tr>`).join("");
    $("recentTxEmpty").classList.toggle("hidden", rows.length > 0);

    const list = items.data || [];
    $("recentItems").innerHTML = list.map((i) => `<li><span>${esc(i.name)}<small>Expires ${fmtDate(i.expiry_date)}</small></span><strong>×${i.quantity}</strong></li>`).join("");
    $("recentItemsEmpty").classList.toggle("hidden", list.length > 0);
  }

  /* =====================================================================
     BILLING — step 1: customer
     ===================================================================== */
  const METHODS = {
    phone: { label: "Registered phone number", placeholder: "98765 43210", mode: "tel" },
    customer_code: { label: "SaveBite ID", placeholder: "SB-7K3Q9", mode: "text" },
    email: { label: "Verified email address", placeholder: "customer@example.com", mode: "email" }
  };
  function setMethod(m) {
    method = m;
    document.querySelectorAll("#methodTabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.method === m));
    $("lookupLabel").textContent = METHODS[m].label;
    $("lookupValue").placeholder = METHODS[m].placeholder;
    $("lookupValue").inputMode = METHODS[m].mode;
    $("lookupValue").value = "";
    $("customerCard").classList.add("hidden");
    say("lookupMessage", "");
    $("lookupValue").focus();
  }

  async function onLookup(e) {
    e.preventDefault();
    const value = $("lookupValue").value.trim();
    if (!value) { say("lookupMessage", "Enter the customer's details first.", "error"); return; }
    busy($("lookupBtn"), true, "Searching…");
    say("lookupMessage", "");
    $("customerCard").classList.add("hidden");
    try {
      const r = await api("lookup_customer", { method, value });
      pendingVerification = r;
      $("custName").textContent = r.display_name;
      $("custAvatar").textContent = initials(r.display_name);
      $("custCode").textContent = r.customer_code;
      $("custPhone").textContent = r.phone_hint ? ` · phone ending ${r.phone_hint}` : "";
      $("customerCard").classList.remove("hidden");
      say("lookupMessage", "Customer found. Confirm it's the person at the counter.", "ok");
    } catch (err) {
      say("lookupMessage", err.message, "error");
    } finally { busy($("lookupBtn"), false); }
  }
  let pendingVerification = null;

  function confirmCustomer() {
    if (!pendingVerification) return;
    // a different customer than before means a different bill: start a fresh bill reference
    if (bill.verification && bill.verification.customer_code !== pendingVerification.customer_code) bill.key = newKey();
    bill.verification = pendingVerification;
    $("billFor").textContent = `For ${bill.verification.display_name} · ${bill.verification.customer_code}`;
    goStep(2);
  }

  /* =====================================================================
     BILLING — step 2: products
     ===================================================================== */
  function fillProduct(p) {
    currentBarcode = p.barcode || "";
    $("barcode").value = currentBarcode;
    $("itemName").value = p.name || "";
    if (p.category) $("itemCategory").value = p.category;
    $("productSearch").value = "";
    hideResults();
    $("itemExpiry").focus();
  }

  async function onBarcode(e) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const code = $("barcode").value.trim();
    if (!code) return;
    if (!/^[A-Za-z0-9-]{4,32}$/.test(code)) { say("itemMessage", "Barcodes are 4–32 letters, digits or dashes.", "error"); return; }
    say("itemMessage", "Looking up…");
    const { data, error } = await sb.from("product_catalog").select("barcode, name, category").eq("barcode", code).maybeSingle();
    if (error) { say("itemMessage", "Catalogue lookup failed: " + error.message, "error"); return; }
    if (data) {
      fillProduct(data);
      say("itemMessage", `Found: ${data.name}. Enter the expiry date printed on the pack.`, "ok");
    } else {
      currentBarcode = code;
      $("itemName").value = "";
      say("itemMessage", "New barcode — enter the product name and category.", "");
      $("itemName").focus();
    }
  }

  let searchTimer;
  function onSearchInput() {
    clearTimeout(searchTimer);
    const q = $("productSearch").value.trim().replace(/[%_,()*\\]/g, " ").trim();
    if (q.length < 2) { hideResults(); return; }
    searchTimer = setTimeout(async () => {
      const { data, error } = await sb.from("product_catalog").select("barcode, name, category").ilike("name", `%${q}%`).order("name").limit(6);
      if (error) { say("itemMessage", "Search failed: " + error.message, "error"); return; }
      const box = $("searchResults");
      if (!data.length) { box.innerHTML = `<li><small>No matching products. Type the details below instead.</small></li>`; box.classList.remove("hidden"); return; }
      box.innerHTML = data.map((p, i) => `<li data-i="${i}"><span>${esc(p.name)}</span><small>${esc(p.category)}</small></li>`).join("");
      box._data = data;
      box.classList.remove("hidden");
    }, 220);
  }
  function hideResults() { $("searchResults").classList.add("hidden"); }

  function onAddItem(e) {
    e.preventDefault();
    const name = $("itemName").value.trim();
    const qty = Number($("itemQty").value);
    const expiry = $("itemExpiry").value;
    const batch = $("itemBatch").value.trim();
    const priceRaw = $("itemPrice").value.trim();
    const barcode = ($("barcode").value.trim() || currentBarcode).trim();
    if (!name) return say("itemMessage", "Enter the product name.", "error");
    if (!Number.isInteger(qty) || qty < 1 || qty > 1000) return say("itemMessage", "Quantity must be a whole number from 1 to 1000.", "error");
    if (!expiry) return say("itemMessage", "Enter the expiry date printed on the pack.", "error");
    if (expiry < todayStr()) return say("itemMessage", "That product is already past its expiry date. Check the pack.", "error");
    if (barcode && !/^[A-Za-z0-9-]{4,32}$/.test(barcode)) return say("itemMessage", "Barcodes are 4–32 letters, digits or dashes.", "error");
    if (priceRaw && !(Number(priceRaw) >= 0)) return say("itemMessage", "Price must be a positive number.", "error");

    const item = { name, category: $("itemCategory").value, quantity: qty, expiry_date: expiry, batch_no: batch, barcode, unit_price: priceRaw === "" ? "" : Number(priceRaw) };
    const same = barcode && bill.items.find((i) => i.barcode === barcode && i.expiry_date === expiry && i.batch_no === batch && i.unit_price === item.unit_price);
    if (same) same.quantity = Math.min(1000, same.quantity + qty); else bill.items.push(item);

    $("itemForm").reset(); $("itemQty").value = 1; $("barcode").value = ""; currentBarcode = "";
    say("itemMessage", `Added ${name}.`, "ok");
    renderBill();
    $("barcode").focus();
  }

  function billTotal() {
    const priced = bill.items.filter((i) => i.unit_price !== "");
    return priced.length ? priced.reduce((s, i) => s + i.unit_price * i.quantity, 0) : null;
  }
  const totalText = () => {
    const t = billTotal();
    return t == null ? "—" : money(t) + (bill.items.some((i) => i.unit_price === "") ? " (priced items only)" : "");
  };
  function renderBill() {
    $("billBody").innerHTML = bill.items.map((i, idx) => `<tr>
      <td>${esc(i.name)}<span class="sub">${esc(i.category)}${i.batch_no ? " · batch " + esc(i.batch_no) : ""}</span></td>
      <td class="num">${i.quantity}</td><td>${fmtDate(i.expiry_date)}</td>
      <td class="num"><button class="btn btn-sm btn-danger" data-remove="${idx}" type="button" aria-label="Remove ${esc(i.name)}">Remove</button></td></tr>`).join("");
    $("billEmpty").classList.toggle("hidden", bill.items.length > 0);
    $("billCount").textContent = plural(bill.items.length, "item");
    $("billTotal").textContent = totalText();
    $("toReview").disabled = bill.items.length === 0;
  }

  /* =====================================================================
     BILLING — step 3: review + consent + submit
     ===================================================================== */
  function renderReview() {
    $("reviewFor").textContent = `Customer: ${bill.verification.display_name} · SaveBite ID ${bill.verification.customer_code}`;
    $("reviewCount").textContent = plural(bill.items.length, "item");
    $("reviewBody").innerHTML = bill.items.map((i) => `<tr>
      <td>${esc(i.name)}</td><td>${esc(i.category)}</td><td class="num">${i.quantity}</td>
      <td>${esc(i.batch_no) || "—"}</td><td>${fmtDate(i.expiry_date)}</td><td class="num">${i.unit_price === "" ? "—" : money(i.unit_price)}</td></tr>`).join("");
    $("reviewTotal").textContent = totalText();
    say("submitMessage", "");
    $("reverify").classList.add("hidden");
  }

  async function submit(consent) {
    const yes = $("consentYesBtn"), no = $("consentNoBtn");
    if (consent && bill.verification && Date.now() > Date.parse(bill.verification.expires_at)) {
      say("submitMessage", "The customer check expired. Look up the customer again to continue.", "error");
      $("reverify").classList.remove("hidden");
      return;
    }
    yes.disabled = no.disabled = true;
    say("submitMessage", consent ? "Sending to SaveBite…" : "Recording the customer's choice…");
    try {
      const r = await api("submit_bill", {
        verification_id: bill.verification.verification_id,
        idempotency_key: bill.key,
        consent_given: consent,
        items: consent ? bill.items.map((i) => ({ ...i, unit_price: i.unit_price === "" ? null : i.unit_price, batch_no: i.batch_no || null, barcode: i.barcode || null })) : []
      });
      showDone(r);
    } catch (err) {
      say("submitMessage", `Not submitted: ${err.message} Your bill is still here, so you can try again.`, "error");
      if (/verification|look up the customer/i.test(err.message)) $("reverify").classList.remove("hidden");
    } finally { yes.disabled = no.disabled = false; }
  }

  function showDone(r) {
    const c = bill.verification;
    let html;
    if (r.status === "declined") {
      html = `<div class="done-icon grey">✕</div><h3>Not shared with SaveBite</h3>
        <p class="muted">The customer chose not to share this purchase. Nothing was sent to their account, and their decision has been recorded.</p>`;
    } else {
      html = `<div class="done-icon">✓</div><h3>${r.duplicate ? "Already submitted" : "Bill submitted to SaveBite"}</h3>
        <p class="muted">${plural(r.item_count, "product")} ${r.duplicate ? "were already saved for" : "added to the inventory of"} ${esc(c.display_name)} (${esc(c.customer_code)}). ${r.duplicate ? "No duplicate was created." : "They will see it in their SaveBite app now."}</p>
        <div class="txn mono">${esc(r.transaction_ref)}</div>
        ${r.total_amount != null ? `<p class="muted">Bill total ${money(r.total_amount)}</p>` : ""}`;
    }
    $("doneCard").innerHTML = html + `<div><button class="btn btn-primary" id="newBillBtn" type="button">Start a new bill</button></div>`;
    goStep("done");
    $("newBillBtn").addEventListener("click", () => { bill = freshBill(); resetBillUI(); $("lookupValue").focus(); });
  }

  /* ---------- step plumbing ---------- */
  function goStep(n) {
    bill.step = n;
    ["1", "2", "3", "Done"].forEach((k) => $(k === "Done" ? "stepDone" : `step${k}`).classList.add("hidden"));
    $(n === "done" ? "stepDone" : `step${n}`).classList.remove("hidden");
    document.querySelectorAll("#steps li").forEach((li) => {
      const s = Number(li.dataset.step);
      const cur = n === "done" ? 4 : n;
      li.classList.toggle("current", s === cur);
      li.classList.toggle("done", s < cur);
    });
    if (n === 2) { renderBill(); $("barcode").focus(); }
    if (n === 3) renderReview();
  }

  function resetBillUI() {
    pendingVerification = null; currentBarcode = "";
    $("lookupValue").value = ""; $("customerCard").classList.add("hidden");
    say("lookupMessage", ""); say("itemMessage", ""); say("submitMessage", "");
    $("itemForm").reset(); $("itemQty").value = 1; $("barcode").value = "";
    $("itemExpiry").min = todayStr();
    setMethodQuiet("phone");
    renderBill(); goStep(1);
  }
  function setMethodQuiet(m) {
    method = m;
    document.querySelectorAll("#methodTabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.method === m));
    $("lookupLabel").textContent = METHODS[m].label; $("lookupValue").placeholder = METHODS[m].placeholder; $("lookupValue").inputMode = METHODS[m].mode;
  }

  /* =====================================================================
     TRANSACTIONS
     ===================================================================== */
  async function loadTransactions(reset) {
    if (tx.loading) return;
    tx.loading = true;
    if (reset) { tx.offset = 0; $("txBody").innerHTML = ""; }
    const { data, error } = await sb.rpc("portal_transactions", { p_limit: PAGE, p_offset: tx.offset, p_search: tx.search || null });
    tx.loading = false;
    if (error) { toast("Couldn't load transactions: " + error.message, true); return; }
    $("txBody").insertAdjacentHTML("beforeend", data.map((t) => `<tr class="clickable" data-purchase="${esc(t.purchase_id)}" title="Click to see the products">
      <td><span class="mono">${esc(t.transaction_ref || "—")}</span></td><td>${esc(t.bill_no || "—")}</td>
      <td>${esc(t.customer_name)}<span class="sub">${esc(t.customer_code)}</span></td>
      <td>${esc(t.store_name)}${t.store_branch ? `<span class="sub">${esc(t.store_branch)}</span>` : ""}</td>
      <td class="num">${t.item_count}<span class="sub">${plural(Number(t.units), "unit")}</span></td><td class="num">${money(t.total_amount)}</td>
      <td>${esc(t.staff_name || "—")}</td><td>${fmtStamp(t.purchased_at)}</td></tr>`).join(""));
    tx.offset += data.length;
    $("txEmpty").classList.toggle("hidden", tx.offset > 0);
    $("txMore").classList.toggle("hidden", data.length < PAGE);
  }

  async function toggleTxDetail(row) {
    const next = row.nextElementSibling;
    if (next?.classList.contains("detail")) { next.remove(); return; }
    const id = row.dataset.purchase;
    const detail = document.createElement("tr");
    detail.className = "detail";
    detail.innerHTML = `<td colspan="8">Loading…</td>`;
    row.after(detail);
    const { data, error } = await sb.from("purchase_items").select("name, category, quantity, batch_no, expiry_date, unit_price").eq("purchase_id", id).order("name");
    if (error) { detail.firstElementChild.textContent = "Couldn't load products: " + error.message; return; }
    detail.firstElementChild.innerHTML = `<table><thead><tr><th>Product</th><th>Category</th><th class="num">Qty</th><th>Batch</th><th>Expiry</th><th class="num">Unit price</th></tr></thead><tbody>${
      data.map((i) => `<tr><td>${esc(i.name)}</td><td>${esc(i.category)}</td><td class="num">${i.quantity}</td><td>${esc(i.batch_no) || "—"}</td><td>${fmtDate(i.expiry_date)}</td><td class="num">${i.unit_price == null ? "—" : money(i.unit_price)}</td></tr>`).join("")
    }</tbody></table>`;
  }

  /* =====================================================================
     CATALOGUE
     ===================================================================== */
  async function loadCatalogue() {
    const { data, error } = await sb.from("product_catalog").select("barcode, name, category").order("name").limit(1000);
    if (error) { toast("Couldn't load the catalogue: " + error.message, true); return; }
    catalogue = data;
    renderCatalogue();
  }
  function renderCatalogue() {
    const q = $("catFilter").value.trim().toLowerCase();
    const rows = catalogue.filter((p) => !q || p.name.toLowerCase().includes(q) || p.barcode.toLowerCase().includes(q) || p.category.toLowerCase().includes(q));
    const admin = me?.staff.role === "admin";
    $("catBody").innerHTML = rows.map((p) => `<tr><td class="mono">${esc(p.barcode)}</td><td>${esc(p.name)}</td><td><span class="pill">${esc(p.category)}</span></td>
      <td class="num"><button class="btn btn-sm" data-edit="${esc(p.barcode)}" type="button">Edit</button>
      ${admin ? `<button class="btn btn-sm btn-danger" data-del="${esc(p.barcode)}" type="button">Delete</button>` : ""}</td></tr>`).join("");
    $("catEmpty").classList.toggle("hidden", rows.length > 0);
  }
  async function saveProduct(e) {
    e.preventDefault();
    const barcode = $("catBarcode").value.trim(), name = $("catName").value.trim();
    if (!/^[A-Za-z0-9-]{4,32}$/.test(barcode)) return say("catMessage", "Barcode must be 4–32 letters, digits or dashes.", "error");
    if (!name) return say("catMessage", "Enter the product name.", "error");
    const { error } = await sb.from("product_catalog").upsert(
      { retailer_id: me.staff.retailer_id, barcode, name, category: $("catCategory").value }, { onConflict: "retailer_id,barcode" });
    if (error) return say("catMessage", error.message, "error");
    say("catMessage", "Saved.", "ok");
    $("catForm").reset();
    loadCatalogue();
  }

  /* =====================================================================
     TEAM (admin)
     ===================================================================== */
  async function loadTeam() {
    const [staff, stores] = await Promise.all([
      sb.from("retailer_staff").select("user_id, full_name, role, active, store_id").order("full_name"),
      sb.from("retail_stores").select("id, name, branch").order("name")
    ]);
    if (staff.error || stores.error) { toast("Couldn't load the team.", true); return; }
    const storeName = new Map(stores.data.map((s) => [s.id, `${s.name}${s.branch ? " · " + s.branch : ""}`]));
    $("teamStore").innerHTML = stores.data.map((s) => `<option value="${esc(s.id)}">${esc(storeName.get(s.id))}</option>`).join("");
    $("teamBody").innerHTML = staff.data.map((s) => `<tr><td>${esc(s.full_name)}${s.user_id === me.user.id ? ' <span class="pill">You</span>' : ""}</td>
      <td>${s.role === "admin" ? "Administrator" : "Employee"}</td><td>${esc(storeName.get(s.store_id) || "—")}</td>
      <td><span class="pill ${s.active ? "green" : "red"}">${s.active ? "Active" : "Deactivated"}</span></td>
      <td class="num">${s.user_id === me.user.id ? "" : `<button class="btn btn-sm" data-toggle="${esc(s.user_id)}" data-active="${s.active}" type="button">${s.active ? "Deactivate" : "Reactivate"}</button>`}</td></tr>`).join("");
  }
  async function createStaff(e) {
    e.preventDefault();
    const btn = e.submitter || $("teamForm").querySelector("button[type=submit]");
    busy(btn, true, "Creating…");
    say("teamMessage", "");
    try {
      await api("create_staff", {
        full_name: $("teamName").value, email: $("teamEmail").value, password: $("teamPassword").value,
        role: $("teamRole").value, store_id: $("teamStore").value
      });
      say("teamMessage", "Login created. Share the email and temporary password with the employee.", "ok");
      $("teamForm").reset();
      loadTeam();
    } catch (err) { say("teamMessage", err.message, "error"); }
    finally { busy(btn, false); }
  }

  /* =====================================================================
     EVENTS
     ===================================================================== */
  document.addEventListener("click", (e) => {
    const v = e.target.closest("[data-view]");
    if (v) setView(v.dataset.view);
    const rm = e.target.closest("[data-remove]");
    if (rm) { bill.items.splice(Number(rm.dataset.remove), 1); renderBill(); }
    const tab = e.target.closest("#methodTabs .tab");
    if (tab) setMethod(tab.dataset.method);
    const row = e.target.closest("#txBody tr.clickable");
    if (row) toggleTxDetail(row);
    const edit = e.target.closest("[data-edit]");
    if (edit) {
      const p = catalogue.find((c) => c.barcode === edit.dataset.edit);
      if (p) { $("catBarcode").value = p.barcode; $("catName").value = p.name; $("catCategory").value = p.category; $("catName").focus(); }
    }
    const del = e.target.closest("[data-del]");
    if (del && confirm(`Delete ${del.dataset.del} from the catalogue? Past bills are not affected.`)) {
      sb.from("product_catalog").delete().eq("barcode", del.dataset.del).then(({ error }) => { if (error) toast(error.message, true); else { toast("Deleted."); loadCatalogue(); } });
    }
    const tog = e.target.closest("[data-toggle]");
    if (tog) {
      const makeActive = tog.dataset.active !== "true";
      api("set_staff_active", { user_id: tog.dataset.toggle, active: makeActive }).then(() => { toast(makeActive ? "Reactivated." : "Deactivated."); loadTeam(); }).catch((err) => toast(err.message, true));
    }
    const li = e.target.closest("#searchResults li[data-i]");
    if (li) fillProduct($("searchResults")._data[Number(li.dataset.i)]);
    if (!e.target.closest(".search-box")) hideResults();
  });

  $("logoutButton").addEventListener("click", logout);
  $("menuButton").addEventListener("click", () => $("sidebar").classList.toggle("open"));
  $("lookupForm").addEventListener("submit", onLookup);
  $("confirmCustomer").addEventListener("click", confirmCustomer);
  $("barcode").addEventListener("keydown", onBarcode);
  $("productSearch").addEventListener("input", onSearchInput);
  $("productSearch").addEventListener("keydown", (e) => { if (e.key === "Escape") hideResults(); });
  $("itemForm").addEventListener("submit", onAddItem);
  $("backToCustomer").addEventListener("click", () => goStep(1));
  $("toReview").addEventListener("click", () => bill.items.length && goStep(3));
  $("backToItems").addEventListener("click", () => goStep(2));
  $("consentYesBtn").addEventListener("click", () => submit(true));
  $("consentNoBtn").addEventListener("click", () => submit(false));
  $("reverify").addEventListener("click", () => { goStep(1); $("lookupValue").focus(); say("lookupMessage", "Look up the customer again to continue this bill."); });
  $("resetBill").addEventListener("click", () => {
    if (bill.items.length && !confirm("Cancel this bill and remove its products?")) return;
    bill = freshBill(); resetBillUI();
  });
  $("txSearchForm").addEventListener("submit", (e) => { e.preventDefault(); tx.search = $("txSearch").value.trim(); loadTransactions(true); });
  $("txMore").addEventListener("click", () => loadTransactions(false));
  $("catFilter").addEventListener("input", renderCatalogue);
  $("catForm").addEventListener("submit", saveProduct);
  $("teamForm").addEventListener("submit", createStaff);

  $("todayLabel").textContent = new Date().toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  initAuth().catch((e) => { showLogin(); say("loginMessage", e.message || "Could not start the portal.", "error"); });
})();
