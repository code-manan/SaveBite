(() => {
  "use strict";

  /* =====================================================================
     SaveBite — customer app (read-only)
     Stores add purchases at billing. This app only SHOWS them.
     ===================================================================== */

  // Paste your Supabase Project URL and Publishable key (Project Settings → API Keys).
  // Never put your database password or a secret / service_role key in this file.
  const SUPABASE_URL = "PASTE_YOUR_SUPABASE_PROJECT_URL_HERE";
  const SUPABASE_PUBLISHABLE_KEY = "PASTE_YOUR_SUPABASE_PUBLISHABLE_KEY_HERE";

  const EXPIRING_DAYS = 7;       // "expiring soon" = this many days or fewer left
  const HIDE_AFTER_DAYS = 90;    // items expired longer than this are hidden from lists (never deleted)
  const NEW_PURCHASE_DAYS = 3;   // a bill counts as "new" in Notifications for this long
  const THEMES = { dashboard: "trust", notifications: "trust", inventory: "fresh", purchases: "fresh" };
  const VIEW_TITLES = { dashboard: "Dashboard", inventory: "My items", purchases: "Purchases", notifications: "Notifications" };
  const ICONS = { Dairy: "🥛", Groceries: "🥫", Beverages: "🧃", Snacks: "🍪", Bakery: "🍞", Frozen: "🧊", "Personal care": "🧴" };
  const READ_KEY = "savebite_read_alerts_v2";
  const BROWSER_ALERT_KEY = "savebite_browser_alert_day_v1";

  /* ---------- Small helpers ---------- */
  const $ = (id) => document.getElementById(id);
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const today = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
  const localDateString = (date) => {
    const d = new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const dayOffset = (days) => { const d = today(); d.setDate(d.getDate() + days); return localDateString(d); };
  const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const itemIcon = (category) => ICONS[category] || "📦";
  const formatDate = (value) => value ? new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—";
  const formatStamp = (iso, withYear = false) => iso ? new Date(iso).toLocaleDateString(undefined, withYear ? { day: "numeric", month: "short", year: "numeric" } : { day: "numeric", month: "short" }) : "—";
  const daysAgo = (iso) => Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  const money = (value) => value == null ? "" : Number(value).toLocaleString("en-IN", { style: "currency", currency: "INR" });
  const initials = (text) => (String(text || "").trim().split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map(s => s[0].toUpperCase()).join("")) || "SB";
  const safeStorage = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage blocked: ignore */ } }
  };

  /* ---------- App state ---------- */
  let supabaseClient = null;
  let authMode = "signin";
  let channel = null;            // Supabase realtime subscription
  let realtimeOn = false;
  let refreshTimer = null;
  let toastTimer = null;
  const openPurchases = new Set();

  const emptyState = () => ({ user: null, demo: false, loaded: false, profile: null, purchases: [], items: [] });
  let state = emptyState();

  /* ---------- Expiry logic ---------- */
  function statusFor(item) {
    const days = Math.round((new Date(`${item.expiryDate}T00:00:00`) - today()) / 86400000);
    if (days < 0) return { key: "expired", label: "Expired", days };
    if (days <= EXPIRING_DAYS) return { key: "expiring", label: days === 0 ? "Expires today" : `In ${plural(days, "day")}`, days };
    return { key: "safe", label: "Safe", days };
  }
  const byExpiry = (a, b) => a.expiryDate.localeCompare(b.expiryDate);   // YYYY-MM-DD sorts correctly as text
  // Not-yet-expired first (soonest first), then expired ones (most recently expired first)
  function useFirst(list) {
    const live = list.filter(i => statusFor(i).days >= 0).sort(byExpiry);
    const gone = list.filter(i => statusFor(i).days < 0).sort((a, b) => b.expiryDate.localeCompare(a.expiryDate));
    return [...live, ...gone];
  }
  // Items still worth showing (long-expired ones are hidden, not deleted)
  const activeItems = () => state.items.filter(i => statusFor(i).days > -HIDE_AFTER_DAYS);

  /* ---------- Toast & sync badge ---------- */
  function showToast(message) {
    $("toastText").textContent = message;
    $("toast").classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $("toast").classList.remove("show"), 3600);
  }
  function setSync(mode) {
    const labels = { live: "Live", ready: "Up to date", syncing: "Syncing…", error: "Offline", demo: "Demo data" };
    const badge = $("syncStatus");
    badge.className = `sync-status ${mode}`;
    badge.textContent = labels[mode] || "";
  }

  /* =====================================================================
     DATA — everything the screens need comes through here
     ===================================================================== */

  // Sample bills for the "Preview with sample data" button (same shape Supabase returns)
  function demoData() {
    const at = (n) => new Date(Date.now() - n * 86400000).toISOString();
    return {
      profile: { full_name: "Asha Verma", customer_code: "SB-7K3Q9" },
      purchases: [
        { id: "p1", store_name: "FreshMart", store_branch: "Indiranagar", bill_no: "FM-20931", total_amount: 482.5, purchased_at: at(1) },
        { id: "p2", store_name: "City Superstore", store_branch: "Koramangala", bill_no: "CS-88412", total_amount: 936, purchased_at: at(9) },
        { id: "p3", store_name: "GreenCart", store_branch: null, bill_no: "GC-1170", total_amount: 355.75, purchased_at: at(40) }
      ],
      items: [
        { id: "i1", purchase_id: "p1", name: "Whole milk 1 L carton", category: "Dairy", quantity: 2, expiry_date: dayOffset(2) },
        { id: "i2", purchase_id: "p1", name: "Sliced bread (packed)", category: "Bakery", quantity: 1, expiry_date: dayOffset(5) },
        { id: "i3", purchase_id: "p1", name: "Greek yogurt 400 g", category: "Dairy", quantity: 1, expiry_date: dayOffset(4) },
        { id: "i4", purchase_id: "p1", name: "Orange juice 1 L carton", category: "Beverages", quantity: 2, expiry_date: dayOffset(14) },
        { id: "i5", purchase_id: "p2", name: "Potato chips", category: "Snacks", quantity: 3, expiry_date: dayOffset(-2) },
        { id: "i6", purchase_id: "p2", name: "Rolled oats 1 kg", category: "Groceries", quantity: 1, expiry_date: dayOffset(90) },
        { id: "i7", purchase_id: "p2", name: "Cheddar cheese block", category: "Dairy", quantity: 1, expiry_date: dayOffset(6) },
        { id: "i8", purchase_id: "p2", name: "Instant noodles (pack of 4)", category: "Groceries", quantity: 2, expiry_date: dayOffset(120) },
        { id: "i9", purchase_id: "p3", name: "Peanut butter 340 g", category: "Groceries", quantity: 1, expiry_date: dayOffset(200) },
        { id: "i10", purchase_id: "p3", name: "Cola 2 L bottle", category: "Beverages", quantity: 2, expiry_date: dayOffset(45) },
        { id: "i11", purchase_id: "p3", name: "Butter cookies", category: "Snacks", quantity: 1, expiry_date: dayOffset(-20) }
      ]
    };
  }

  // Turn database rows into the shape the UI uses. Returns the items that are new since last time.
  function applyData({ profile, purchases, items }) {
    const known = new Set(state.items.map(i => i.id));
    const bills = new Map(purchases.map(p => [p.id, p]));
    state.profile = profile || null;
    state.purchases = purchases.map(p => ({
      id: p.id, store: p.store_name, branch: p.store_branch, billNo: p.bill_no, total: p.total_amount, purchasedAt: p.purchased_at
    }));
    state.items = items.map(i => {
      const bill = bills.get(i.purchase_id);
      return {
        id: i.id, purchaseId: i.purchase_id, name: i.name, category: i.category || "Other",
        quantity: i.quantity, expiryDate: i.expiry_date,
        store: bill ? bill.store_name : "Store", boughtAt: bill ? bill.purchased_at : null
      };
    });
    const firstLoad = !state.loaded;
    if (firstLoad && state.purchases.length) openPurchases.add(state.purchases[0].id);   // newest bill starts open
    state.loaded = true;
    renderAll();
    return firstLoad ? [] : state.items.filter(i => !known.has(i.id));
  }

  // Read this customer's rows. Row Level Security in Supabase guarantees they only get their own.
  async function loadData({ announce = false } = {}) {
    if (state.demo || !state.user) return;
    const uid = state.user.id;
    setSync("syncing");
    try {
      const [profile, purchases, items] = await Promise.all([
        supabaseClient.from("profiles").select("full_name, customer_code").eq("id", uid).maybeSingle(),
        supabaseClient.from("purchases").select("id, store_name, store_branch, bill_no, total_amount, purchased_at").order("purchased_at", { ascending: false }),
        supabaseClient.from("purchase_items").select("id, purchase_id, name, category, quantity, expiry_date").order("expiry_date", { ascending: true })
      ]);
      const failure = profile.error || purchases.error || items.error;
      if (failure) throw failure;
      if (!state.user || state.user.id !== uid) return;          // signed out while loading
      const fresh = applyData({ profile: profile.data, purchases: purchases.data || [], items: items.data || [] });
      setSync(realtimeOn ? "live" : "ready");
      if (!profile.data) showToast("Your SaveBite ID isn't ready yet. Please refresh in a moment.");
      if (announce && fresh.length) {
        const stores = [...new Set(fresh.map(i => i.store))].join(", ");
        showToast(`${plural(fresh.length, "new item")} added from ${stores}.`);
      }
    } catch (error) {
      console.warn("SaveBite: could not load data", error);
      setSync("error");
      showToast(`Couldn't load your items. ${error.message || ""}`.trim());
    }
  }

  // Live updates: when a store records a bill, the new rows arrive here without a refresh.
  function subscribeToStoreUpdates() {
    if (!supabaseClient || state.demo || channel || !state.user) return;
    const uid = state.user.id;
    channel = supabaseClient.channel(`savebite-items-${uid}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "purchase_items", filter: `customer_id=eq.${uid}` }, () => {
        clearTimeout(refreshTimer);                              // a bill has many items: wait, then reload once
        refreshTimer = setTimeout(() => loadData({ announce: true }), 700);
      })
      .subscribe((status) => {
        realtimeOn = status === "SUBSCRIBED";
        if (state.user && !state.demo && state.loaded) setSync(realtimeOn ? "live" : "ready");
      });
  }

  /* =====================================================================
     AUTHENTICATION
     ===================================================================== */
  function authMessage(message, isError = false) {
    const target = $("authMessage");
    target.textContent = message;
    target.classList.toggle("error", isError);
  }

  function setAuthMode(mode) {
    authMode = mode;
    const signingUp = mode === "signup";
    $("authTitle").textContent = signingUp ? "Create your account" : "Welcome back";
    $("authDescription").textContent = signingUp
      ? "Create an account to get your SaveBite ID and see your store purchases."
      : "Sign in to see what you've bought and when it expires.";
    $("authSubmit").textContent = signingUp ? "Create account" : "Sign in";
    $("authSwitchText").textContent = signingUp ? "Already have an account?" : "New to SaveBite?";
    $("authSwitchButton").textContent = signingUp ? "Sign in" : "Create an account";
    $("authPassword").autocomplete = signingUp ? "new-password" : "current-password";
    $("authNameField").classList.toggle("hidden", !signingUp);
    $("authPhoneField").classList.toggle("hidden", !signingUp);
    authMessage("");
  }

  function showSignedInUser(user) {
    $("authScreen").hidden = Boolean(user);
    $("appShell").hidden = !user;
    if (!user) window.scrollTo({ top: 0 });
  }

  function startSession(user) {
    state = { ...emptyState(), user };       // set synchronously so duplicate auth events are ignored
    realtimeOn = false;
    showSignedInUser(user);
    setView("dashboard");
    renderAll();
    loadData().then(() => { subscribeToStoreUpdates(); maybeBrowserAlert(); });
  }

  function startDemo() {
    state = { ...emptyState(), demo: true, user: { id: "demo", email: "demo@savebite.app" } };
    showSignedInUser(state.user);
    setView("dashboard");
    applyData(demoData());
    setSync("demo");
  }

  function stopSession() {
    if (channel && supabaseClient) supabaseClient.removeChannel(channel);
    channel = null; realtimeOn = false;
    clearTimeout(refreshTimer);
    state = emptyState();
    openPurchases.clear();
    $("searchInput").value = ""; $("statusFilter").value = "all"; $("categoryFilter").value = "all";
    $("authPassword").value = "";
    if (location.hash === "#demo") history.replaceState(null, "", location.pathname + location.search);
    showSignedInUser(null);
    renderAll();
  }

  function handleSession(user) {
    if (state.demo) return;                                              // demo mode ignores real auth events
    if (user && state.user && user.id === state.user.id) return;         // token refresh etc.: nothing to do
    if (user) startSession(user);
    else if (state.user) stopSession();
    else showSignedInUser(null);
  }

  async function initialiseAuthentication() {
    $("authSwitchButton").addEventListener("click", () => setAuthMode(authMode === "signin" ? "signup" : "signin"));
    $("demoButton").addEventListener("click", startDemo);

    $("authForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!supabaseClient) {
        authMessage("Add your Supabase Project URL and Publishable key in script.js first.", true);
        return;
      }
      const email = $("authEmail").value.trim();
      const password = $("authPassword").value;
      const fullName = $("authName").value.trim();
      const submit = $("authSubmit");
      submit.disabled = true;
      authMessage(authMode === "signup" ? "Creating your account..." : "Signing you in...");
      try {
        if (authMode === "signup") {
          const { data, error } = await supabaseClient.auth.signUp({
            email,
            password,
            options: { emailRedirectTo: window.location.origin, data: { full_name: fullName || email.split("@")[0], phone: $("authPhone").value.trim() } }
          });
          if (error) throw error;
          authMessage(data.session
            ? "Account created. You are now signed in."
            : "Account created. Check your email and confirm your address, then return here to sign in.");
        } else {
          const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
          if (error) throw error;
          authMessage("Signed in successfully.");
        }
      } catch (error) {
        authMessage(error.message || "Authentication failed. Please try again.", true);
      } finally {
        submit.disabled = false;
      }
    });

    $("logoutButton").addEventListener("click", async () => {
      if (state.demo) { stopSession(); return; }
      if (!supabaseClient) return;
      const { error } = await supabaseClient.auth.signOut();
      if (error) showToast(error.message || "Could not log out.");
    });

    const configured = SUPABASE_URL.startsWith("https://") && !SUPABASE_URL.includes("PASTE_") &&
      SUPABASE_PUBLISHABLE_KEY && !SUPABASE_PUBLISHABLE_KEY.includes("PASTE_");

    if (location.hash === "#demo") { startDemo(); return; }
    if (!configured) {
      showSignedInUser(null);
      $("demoLine").classList.remove("hidden");
      authMessage("Setup needed: paste your Supabase Project URL and Publishable key into script.js.", true);
      return;
    }
    if (!window.supabase || typeof window.supabase.createClient !== "function") {
      showSignedInUser(null);
      $("demoLine").classList.remove("hidden");
      authMessage("The Supabase library did not load. Check your internet connection and refresh.", true);
      return;
    }

    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
    const { data, error } = await supabaseClient.auth.getSession();
    if (error) { showSignedInUser(null); authMessage(error.message, true); return; }
    handleSession(data.session?.user || null);
    supabaseClient.auth.onAuthStateChange((_event, session) => {
      // Don't call Supabase directly inside this callback; hand over to the next tick.
      setTimeout(() => handleSession(session?.user || null), 0);
    });
  }

  /* =====================================================================
     VIEWS
     ===================================================================== */
  function setView(name) {
    const target = $(`${name}View`);
    if (!target) return;
    document.querySelectorAll(".view").forEach(view => view.classList.remove("active"));
    target.classList.add("active");
    document.body.dataset.theme = THEMES[name] || "trust";
    document.querySelectorAll(".nav-link").forEach(button => button.classList.toggle("active", button.dataset.view === name));
    $("breadcrumbCurrent").textContent = VIEW_TITLES[name] || "Dashboard";
    $("sidebar").classList.remove("open");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // mode: "preview" (dashboard), "full" (My items), "bill" (inside a purchase)
  function itemRow(item, mode) {
    const status = statusFor(item);
    const sub = mode === "full" ? `Bought ${formatStamp(item.boughtAt)}`
      : mode === "bill" ? escapeHTML(item.category)
      : `${escapeHTML(item.store)} · ${formatStamp(item.boughtAt)}`;
    const extra = mode === "full"
      ? `<td class="hide-sm">${escapeHTML(item.category)}</td><td>${escapeHTML(item.quantity)}</td><td class="hide-sm">${escapeHTML(item.store)}</td>`
      : mode === "bill" ? `<td>${escapeHTML(item.quantity)}</td>` : "";
    return `<tr>
      <td><div class="product-cell"><span class="product-thumb">${itemIcon(item.category)}</span><span class="product-meta">${escapeHTML(item.name)}<small>${sub}</small></span></div></td>
      ${extra}
      <td>${formatDate(item.expiryDate)}</td>
      <td><span class="status-pill status-${status.key}">${status.label}</span></td>
    </tr>`;
  }

  function renderProfile() {
    const email = state.user?.email || "";
    const name = state.profile?.full_name || (email ? email.split("@")[0] : "");
    const first = name.split(" ")[0];
    $("profileName").textContent = name || "My account";
    $("profileEmail").textContent = email || "Signed in";
    $("profileAvatar").textContent = initials(name || email);
    $("topAvatar").textContent = initials(name || email);
    $("greetName").textContent = first ? `, ${first}` : "";
    const code = state.profile?.customer_code;
    $("customerCode").textContent = code || (state.loaded ? "Not ready" : "…");
    $("copyCode").disabled = !code;
  }

  function renderDashboard() {
    const items = activeItems();
    const counts = { expired: 0, expiring: 0, safe: 0 };
    items.forEach(i => counts[statusFor(i).key]++);
    $("totalStat").textContent = items.length;
    $("expiredStat").textContent = counts.expired;
    $("expiringStat").textContent = counts.expiring;
    $("safeStat").textContent = counts.safe;
    $("overviewExpired").textContent = counts.expired;
    $("overviewExpiring").textContent = counts.expiring;
    $("overviewSafe").textContent = counts.safe;
    const total = items.length || 1;
    $("expiredTrack").style.width = `${counts.expired / total * 100}%`;
    $("expiringTrack").style.width = `${counts.expiring / total * 100}%`;
    $("safeTrack").style.width = `${counts.safe / total * 100}%`;
    const next = useFirst(items).slice(0, 6);
    $("recentProducts").innerHTML = next.map(i => itemRow(i, "preview")).join("");
    $("recentTableWrap").classList.toggle("hidden", next.length === 0);
    $("recentEmpty").classList.toggle("hidden", next.length > 0 || !state.loaded);
  }

  function renderCategoryFilter(items) {
    const select = $("categoryFilter"), current = select.value;
    const categories = [...new Set(items.map(i => i.category))].sort();
    select.innerHTML = `<option value="all">All categories</option>` + categories.map(c => `<option>${escapeHTML(c)}</option>`).join("");
    select.value = categories.includes(current) ? current : "all";
  }

  function visibleItems() {
    const query = $("searchInput").value.trim().toLowerCase();
    const category = $("categoryFilter").value;
    const status = $("statusFilter").value;
    return activeItems().filter(i => {
      const matches = i.name.toLowerCase().includes(query) || i.category.toLowerCase().includes(query) || i.store.toLowerCase().includes(query);
      return matches && (category === "all" || i.category === category) && (status === "all" || statusFor(i).key === status);
    }).sort(byExpiry);
  }

  function renderInventory() {
    renderCategoryFilter(activeItems());
    const filtered = visibleItems();
    const noItemsAtAll = state.items.length === 0;
    $("inventoryBody").innerHTML = filtered.map(i => itemRow(i, "full")).join("");
    $("inventoryTableWrap").classList.toggle("hidden", filtered.length === 0);
    $("inventoryEmpty").classList.toggle("hidden", filtered.length > 0 || !state.loaded);
    $("inventoryEmptyTitle").textContent = noItemsAtAll ? "No items yet" : "No items found";
    $("inventoryEmptyText").textContent = noItemsAtAll
      ? "Show your SaveBite ID at a partner store's billing counter and your items will appear here."
      : "Try changing your search or filters.";
    $("inventoryResultCount").textContent = plural(filtered.length, "item");
  }

  function purchaseHTML(bill) {
    const items = state.items.filter(i => i.purchaseId === bill.id).sort(byExpiry);
    const expired = items.filter(i => statusFor(i).key === "expired").length;
    const expiring = items.filter(i => statusFor(i).key === "expiring").length;
    const flag = expiring ? { cls: "expiring", text: `${expiring} expiring soon` }
      : expired ? { cls: "expired", text: `${expired} expired` }
      : { cls: "safe", text: "All safe" };
    const place = bill.branch ? `${bill.store} · ${bill.branch}` : bill.store;
    const details = [formatStamp(bill.purchasedAt, true), bill.billNo ? `Bill ${bill.billNo}` : "", money(bill.total)].filter(Boolean).join(" · ");
    return `<details class="purchase" data-bill="${escapeHTML(bill.id)}" ${openPurchases.has(bill.id) ? "open" : ""}>
      <summary>
        <span class="purchase-icon">🛒</span>
        <span class="purchase-main"><strong>${escapeHTML(place)}</strong><small>${escapeHTML(details)}</small></span>
        <span class="purchase-meta"><b>${plural(items.length, "item")}</b><span class="status-pill status-${flag.cls}">${flag.text}</span></span>
        <span class="chevron" aria-hidden="true">▾</span>
      </summary>
      <div class="purchase-body table-wrap">
        <table><thead><tr><th>PRODUCT</th><th>QTY</th><th>EXPIRY DATE</th><th>STATUS</th></tr></thead>
          <tbody>${items.map(i => itemRow(i, "bill")).join("")}</tbody></table>
      </div>
    </details>`;
  }

  function renderPurchases() {
    $("purchaseList").innerHTML = state.purchases.map(purchaseHTML).join("");
    $("purchasesEmpty").classList.toggle("hidden", state.purchases.length > 0 || !state.loaded);
  }

  /* ---------- Notifications ---------- */
  const readKey = () => `${READ_KEY}:${state.user ? state.user.id : "none"}`;
  function getReadIds() {
    try { return new Set(JSON.parse(safeStorage.get(readKey()) || "[]")); } catch { return new Set(); }
  }
  // New bills first, then expiry alerts (soonest first). An alert's id includes its kind,
  // so an item that goes from "expiring" to "expired" becomes a fresh unread alert.
  function getNotices() {
    const bills = state.purchases.filter(p => daysAgo(p.purchasedAt) < NEW_PURCHASE_DAYS)
      .map(p => ({ id: `bill:${p.id}`, kind: "bill", bill: p }));
    const alerts = useFirst(activeItems().filter(i => statusFor(i).key !== "safe"))
      .map(i => ({ id: `${i.id}:${statusFor(i).key}`, kind: statusFor(i).key, item: i }));
    return [...bills, ...alerts];
  }

  function renderNotifications() {
    const notices = getNotices();
    const read = getReadIds();
    const unread = notices.filter(n => !read.has(n.id)).length;
    $("notificationSubtitle").textContent = `${plural(unread, "unread alert")} · ${notices.length} total`;
    $("alertCountLabel").textContent = `${notices.length} ALERT${notices.length === 1 ? "" : "S"}`;
    $("notificationList").innerHTML = notices.map(n => {
      const isUnread = !read.has(n.id);
      let icon, title, body, foot;
      if (n.kind === "bill") {
        const count = state.items.filter(i => i.purchaseId === n.bill.id).length;
        icon = "🛒";
        title = `${plural(count, "item")} added from ${escapeHTML(n.bill.store)}`;
        body = `Your ${n.bill.billNo ? `bill ${escapeHTML(n.bill.billNo)}` : "latest bill"} is now in SaveBite. Open Purchases to see every item and its expiry date.`;
        foot = `Purchased on ${formatStamp(n.bill.purchasedAt, true)}`;
      } else {
        const p = n.item, status = statusFor(p), expired = n.kind === "expired";
        icon = expired ? "!" : "◷";
        title = `${escapeHTML(p.name)} ${expired ? "has expired" : status.days === 0 ? "expires today" : `expires in ${plural(status.days, "day")}`}`;
        body = `${expired ? "This product is past its expiry date. Please check it before using it." : "This product is approaching its expiry date. Consider using it soon."} Bought at ${escapeHTML(p.store)} · Quantity: ${escapeHTML(p.quantity)}`;
        foot = `Expiry date: ${formatDate(p.expiryDate)}`;
      }
      return `<article class="notification-item ${isUnread ? "unread" : ""}">
        <div class="notification-icon ${n.kind}">${icon}</div>
        <div class="notification-copy"><strong>${title}</strong><p>${body}</p><small>${foot}</small></div>
        ${isUnread ? '<span class="unread-mark" aria-label="Unread"></span>' : ""}
      </article>`;
    }).join("");
    $("notificationsEmpty").classList.toggle("hidden", notices.length > 0 || !state.loaded);
  }

  function updateCounters() {
    const read = getReadIds();
    const unread = getNotices().filter(n => !read.has(n.id)).length;
    $("navAlertCount").textContent = unread;
    $("navAlertCount").classList.toggle("hidden", unread === 0);
    $("topAlertDot").classList.toggle("hidden", unread === 0);
    $("inventoryNavCount").textContent = activeItems().length;
    $("purchasesNavCount").textContent = state.purchases.length;
  }

  function renderAll() {
    renderProfile(); renderDashboard(); renderInventory(); renderPurchases(); renderNotifications(); updateCounters();
    updateBrowserAlertButton();
  }

  /* ---------- Browser alerts (work while SaveBite is open in a tab) ---------- */
  const browserAlertsSupported = () => "Notification" in window;
  function updateBrowserAlertButton() {
    const button = $("enableAlertsButton");
    const show = browserAlertsSupported() && Notification.permission === "default";
    button.classList.toggle("hidden", !show);
  }
  async function enableBrowserAlerts() {
    if (!browserAlertsSupported()) return;
    const permission = await Notification.requestPermission();
    updateBrowserAlertButton();
    if (permission === "granted") {
      showToast("Browser alerts are on.");
      maybeBrowserAlert(true);
    } else {
      showToast("Browser alerts are blocked. You can change this in your browser settings.");
    }
  }
  // At most one summary alert per day
  function maybeBrowserAlert(force = false) {
    if (!browserAlertsSupported() || Notification.permission !== "granted" || !state.user) return;
    const key = `${BROWSER_ALERT_KEY}:${state.user.id}`;
    const day = localDateString(today());
    if (!force && safeStorage.get(key) === day) return;
    const soon = useFirst(activeItems().filter(i => statusFor(i).key === "expiring"));
    if (!soon.length) return;
    const names = soon.slice(0, 3).map(i => `${i.name} (${statusFor(i).label.toLowerCase()})`).join(", ");
    try {
      new Notification(`SaveBite: ${plural(soon.length, "item")} expiring soon`, { body: names + (soon.length > 3 ? "…" : ""), icon: "logo.svg" });
      safeStorage.set(key, day);
    } catch { /* some mobile browsers only allow service-worker notifications */ }
  }

  /* =====================================================================
     EVENTS
     ===================================================================== */
  document.addEventListener("click", (event) => {
    const viewButton = event.target.closest("[data-view]");
    if (viewButton) setView(viewButton.dataset.view);
  });
  // Remember which purchase cards the customer opened (the "toggle" event doesn't bubble, so capture it)
  $("purchaseList").addEventListener("toggle", (event) => {
    const card = event.target.closest("[data-bill]");
    if (!card) return;
    card.open ? openPurchases.add(card.dataset.bill) : openPurchases.delete(card.dataset.bill);
  }, true);

  $("searchInput").addEventListener("input", renderInventory);
  $("categoryFilter").addEventListener("change", renderInventory);
  $("statusFilter").addEventListener("change", renderInventory);
  $("mobileMenu").addEventListener("click", () => $("sidebar").classList.toggle("open"));

  $("copyCode").addEventListener("click", async () => {
    const code = state.profile?.customer_code;
    if (!code) return;
    try { await navigator.clipboard.writeText(code); showToast("SaveBite ID copied."); }
    catch { showToast("Couldn't copy automatically. Select the ID and copy it."); }
  });
  $("markReadButton").addEventListener("click", () => {
    safeStorage.set(readKey(), JSON.stringify([...getReadIds(), ...getNotices().map(n => n.id)]));
    renderNotifications(); updateCounters(); showToast("All alerts marked as read.");
  });
  $("enableAlertsButton").addEventListener("click", enableBrowserAlerts);

  // Statuses depend on today's date, so refresh when the tab regains focus and once an hour
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || !state.user) return;
    $("todayLabel").textContent = today().toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    state.demo ? renderAll() : loadData();
  });
  setInterval(() => { if (state.user) { renderAll(); maybeBrowserAlert(); } }, 60 * 60 * 1000);

  /* ---------- Start ---------- */
  $("todayLabel").textContent = today().toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  setAuthMode("signin");
  renderAll();
  initialiseAuthentication().catch(error => { showSignedInUser(null); authMessage(error.message || "Could not initialise authentication.", true); });
})();
