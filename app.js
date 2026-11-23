/* سكانر مستودع التوالف — منطق التطبيق.
   البيانات:
   - شيت الأصناف (الباركود، رقم الصنف، الوصف، المستودع، المورد، الموقع المستهدف) في storage bucket خاص على Supabase.
     الموبايل بينزله لما يتغير بس، ويحفظه (IndexedDB) عشان المسح يبقى فوري ويشتغل من غير نت.
   - كل دفعة (سيشن) وأصنافها بتتحفظ على الموبايل الأول (localStorage)، وبعدين بتترفع لجداول tw_sessions و tw_items.
     لو النت قاطع، التغييرات بتستنى في "outbox" وبتترفع أول ما النت يرجع. */
(() => {
"use strict";
const CFG = window.TW_CONFIG || {};
const BUCKET = CFG.BUCKET || "tawalef-data", FILE = CFG.FILE || "products.csv";
const $ = id => document.getElementById(id);
const clean = s => String(s ?? "").trim();
const norm = s => clean(s).replace(/\s+/g, "").replace(/\.0+$/, "");
const stripZeros = s => s.replace(/^0+/, "");
const num = n => Number(n).toLocaleString("en-US");
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));

// العواميد اللي التطبيق بيدور عليها في شيت الأصناف (بالترتيب ده، عشان "Target Location" متتلخبطش مع "Warehouse").
const FIELDS = [
  { k: "code", label: "الباركود",        re: /barcode|ean|upc|gtin|باركود/ },
  { k: "loc",  label: "الموقع المستهدف", re: /target|location|^loc|bin|slot|shelf|موقع/ },
  { k: "wh",   label: "المستودع",        re: /warehouse|^wh\b|store|مستودع/ },
  { k: "sup",  label: "المورد",          re: /supplier|vendor|مورد/ },
  { k: "item", label: "رقم الصنف",       re: /item ?(no|num|number|code|#|id)\b|^item$|sku|article|material|رقم الصنف|كود الصنف|رقم/ },
  { k: "desc", label: "الوصف",           re: /desc|name|product|وصف|اسم/ },
];

let sb = null, user = null, isAdmin = false;
let data = null;            // شيت الأصناف: { headers, rows, version, updatedAt }
let cols = {};              // { code, loc, wh, sup, item, desc } → رقم العمود أو -1
let byCode = new Map(), byItem = new Map();

/* ---------- تخزين ---------- */
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("tawalef", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("kv");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("kv", mode); const st = tx.objectStore("kv");
      const req = fn(st);
      tx.oncomplete = () => resolve(req && req.result); tx.onerror = () => reject(tx.error);
    };
  });
}
const saveData = d => idb("readwrite", st => st.put(d, "data")).catch(() => {});
const loadData = () => idb("readonly", st => st.get("data")).catch(() => null);
const clearData = () => idb("readwrite", st => st.delete("data")).catch(() => {});
const pref = { get(k) { try { return JSON.parse(localStorage.getItem("tw-" + k)); } catch (e) { return null; } },
               set(k, v) { try { v == null ? localStorage.removeItem("tw-" + k) : localStorage.setItem("tw-" + k, JSON.stringify(v)); } catch (e) {} } };

/* ---------- الدفعة الحالية + اللي مستني يترفع ---------- */
// S = { session: { id, startedAt, batchNo, exportedSig }, items: [ {id, barcode, item, desc, wh, sup, loc, qty, at} ] }
// OUT = { sessions: {id: row}, items: {id: row}, del: [id] }
let S = pref.get("state");
let OUT = pref.get("outbox") || { sessions: {}, items: {}, del: [] };
const saveState = () => { pref.set("state", S); pref.set("outbox", OUT); };
function newSession() {
  S = { session: { id: uuid(), startedAt: new Date().toISOString(), batchNo: null, exportedSig: null }, items: [] };
  queueSession(); saveState();
}
function queueSession(closedAt) {
  const s = S.session;
  OUT.sessions[s.id] = { id: s.id, started_at: s.startedAt, closed_at: closedAt || null, device: (navigator.userAgent || "").slice(0, 160) };
}
function queueItem(it) {
  OUT.items[it.id] = { id: it.id, session_id: S.session.id, barcode: it.barcode, item_no: it.item || null, description: it.desc || null,
    warehouse: it.wh || null, supplier: it.sup || null, target_location: it.loc || null, qty: it.qty,
    first_scanned_at: it.at, updated_at: new Date().toISOString() };
}
function queueDelete(id) { delete OUT.items[id]; if (!OUT.del.includes(id)) OUT.del.push(id); }
const pendingCount = () => Object.keys(OUT.sessions).length + Object.keys(OUT.items).length + OUT.del.length;
if (!S || !S.session) newSession();

/* ---------- CSV / Excel ---------- */
function parseCSV(text) {
  text = text.replace(/^﻿/, "");
  const first = text.split("\n")[0];
  const delim = (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? "\t" : ",";
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(f); f = ""; }
    else if (ch === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else if (ch !== "\r") f += ch;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const csvCell = v => /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
const toCSV = d => [d.headers, ...d.rows].map(r => r.map(csvCell).join(",")).join("\n");
const cellText = v => typeof v === "number" ? (Number.isInteger(v) ? v.toFixed(0) : String(v)) : clean(v);
function tableToData(table) {
  table = table.filter(r => r.some(c => cellText(c) !== ""));
  if (table.length < 2) throw new Error("الملف مفيهوش أصناف تحت صف العناوين");
  const headers = table[0].map(cellText);
  const seen = new Set(), rows = []; let dupes = 0;
  for (const r of table.slice(1)) {
    const row = headers.map((_, i) => cellText(r[i]).replace(/\s+/g, " "));
    const k = row.join("\u0001"); if (seen.has(k)) { dupes++; continue; } seen.add(k); rows.push(row);
  }
  return { headers, rows, dupes };
}
function loadXLSX() {
  if (window.XLSX) return Promise.resolve();
  return new Promise((res, rej) => { const s = document.createElement("script"); s.src = "vendor/xlsx.min.js"; s.onload = res; s.onerror = () => rej(new Error("قارئ الإكسل ما اتحملش. اتأكد من النت")); document.head.appendChild(s); });
}

/* ---------- العواميد والفهرس ---------- */
function detectCols(headers, useSaved = true) {
  const saved = (useSaved && pref.get("cols-" + headers.join("|"))) || {};
  const c = {}, used = [];
  for (const f of FIELDS) {
    let i = saved[f.k] ?? headers.findIndex((h, j) => !used.includes(j) && f.re.test(h.toLowerCase()));
    if (f.k === "code" && i < 0) i = 0;
    c[f.k] = i; if (i >= 0) used.push(i);
  }
  return c;
}
const val = (r, k) => cols[k] >= 0 ? clean(r[cols[k]]) : "";
function buildIndex() {
  byCode = new Map(); byItem = new Map();
  if (!data) { $("count").textContent = "0"; renderSync(); return; }
  cols = detectCols(data.headers);
  const add = (m, k, r) => { if (!k) return; const a = m.get(k); if (a) a.push(r); else m.set(k, [r]); };
  let n = 0;
  for (const r of data.rows) {
    const c = norm(r[cols.code]); if (!c) continue; n++;
    add(byCode, c, r); add(byCode, "z:" + stripZeros(c), r);
    if (cols.item >= 0) add(byItem, norm(r[cols.item]).toLowerCase(), r);
  }
  $("count").textContent = num(n);
  const box = $("colPickers"); box.innerHTML = "";
  for (const f of FIELDS) {
    const id = "col-" + f.k, lab = el("label", null, f.label); lab.htmlFor = id;
    const sel = el("select"); sel.id = id;
    if (f.k !== "code") { const o = el("option", null, "— مش موجود —"); o.value = -1; sel.appendChild(o); }
    data.headers.forEach((h, i) => { const o = el("option", null, h || "عمود " + (i + 1)); o.value = i; sel.appendChild(o); });
    sel.value = cols[f.k];
    sel.addEventListener("change", () => {
      const pick = {}; FIELDS.forEach(x => pick[x.k] = +$("col-" + x.k).value);
      pref.set("cols-" + data.headers.join("|"), pick); buildIndex(); renderCurrent();
    });
    box.append(lab, sel);
  }
  renderSync();
}

/* ---------- الشاشات ---------- */
function view(name) { $("loginView").hidden = name !== "login"; $("appView").hidden = name !== "app"; $("setupView").hidden = name !== "setup"; }
function status(t) { $("status").textContent = t; }
let toastT = 0;
function toast(t) { const b = $("toast"); b.textContent = t; b.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => b.hidden = true, 2600); }
function fmt(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString("ar-EG-u-nu-latn", { day: "numeric", month: "short" }) + "، " + d.toLocaleTimeString("ar-EG-u-nu-latn", { hour: "numeric", minute: "2-digit" });
}

/* ---------- مزامنة شيت الأصناف ---------- */
let syncing = false, syncNote = "";
function renderSync() {
  const line = $("syncLine"); line.textContent = "";
  if ($("appView").hidden) { line.textContent = $("loginView").hidden ? "" : "سجّل دخول عشان تحمّل الأصناف"; return; }
  const dot = el("span", "dot" + (navigator.onLine ? "" : " off"));
  let t;
  if (syncing) t = "بيتحقق من وجود شيت أصناف أحدث…";
  else if (!data) t = "مفيش شيت أصناف على الموبايل لسه";
  else t = "شيت الأصناف من " + fmt(data.updatedAt) + (navigator.onLine ? "" : " · من غير نت");
  line.append(dot, document.createTextNode(t));
  if (syncNote && !syncing) line.append(el("br"), document.createTextNode(syncNote));
}
async function remoteInfo() {
  const { data: list, error } = await sb.storage.from(BUCKET).list("", { search: FILE, limit: 20 });
  if (error) throw error;
  return (list || []).find(o => o.name === FILE) || null;
}
const versionOf = info => (info.updated_at || "") + "|" + ((info.metadata && info.metadata.size) || "");
async function syncData(manual) {
  if (!user || !sb) return;
  if (!navigator.onLine) { if (manual) status(data ? "مفيش نت. شغال بالشيت المحفوظ على الموبايل." : "مفيش نت. اتصل مرة واحدة عشان تنزل شيت الأصناف."); return; }
  syncing = true; syncNote = ""; renderSync(); $("refreshBtn").disabled = true;
  try {
    const info = await remoteInfo();
    if (!info) { syncNote = isAdmin ? "لسه مفيش شيت أصناف. ارفعه من قسم المشرف تحت." : "لسه مفيش شيت أصناف. اطلب من المشرف يرفعه."; return; }
    const version = versionOf(info);
    if (data && data.version === version) { if (manual) status("عندك آخر نسخة من شيت الأصناف."); return; }
    const { data: blob, error } = await sb.storage.from(BUCKET).download(FILE);
    if (error) throw error;
    const t = tableToData(parseCSV(await blob.text()));
    data = { headers: t.headers, rows: t.rows, version, updatedAt: Date.parse(info.updated_at) || Date.now() };
    await saveData(data); buildIndex();
    status(`اتحدث شيت الأصناف: ${$("count").textContent} باركود.`);
  } catch (e) {
    syncNote = "ماقدرش يتحقق من التحديث (" + (e.message || "مشكلة في النت") + ")." + (data ? " شغال بالشيت المحفوظ." : "");
    if (/jwt|token|auth|401|403/i.test(e.message || "") && navigator.onLine) { await sessionLost(); return; }
  } finally { syncing = false; $("refreshBtn").disabled = false; renderSync(); }
}
$("refreshBtn").addEventListener("click", () => syncData(true));

/* ---------- رفع الدفعات لـ Supabase ---------- */
let pushing = false, pushErr = "";
async function flush() {
  renderPending();
  if (!sb || !user || pushing || !navigator.onLine || !pendingCount()) return;
  pushing = true; pushErr = "";
  try {
    if (!user.id) { // اتفتح من غير نت قبل كده: هات الجلسة الأول
      const r = await sb.auth.getSession(); const ses = r.data && r.data.session;
      if (!ses) { pushing = false; await sessionLost(); return; }
      user = ses.user;
    }
    const sRows = Object.values(OUT.sessions);
    if (sRows.length) {
      const snap = JSON.stringify(OUT.sessions);
      const { data: got, error } = await sb.from("tw_sessions").upsert(sRows).select("id,batch_no");
      if (error) throw error;
      for (const g of got || []) if (g.id === S.session.id && S.session.batchNo !== g.batch_no) { S.session.batchNo = g.batch_no; renderBatch(); }
      if (JSON.stringify(OUT.sessions) === snap) OUT.sessions = {};
      else { const now = JSON.parse(snap); for (const id in now) if (JSON.stringify(OUT.sessions[id]) === JSON.stringify(now[id])) delete OUT.sessions[id]; }
      saveState();
    }
    const iRows = Object.values(OUT.items);
    if (iRows.length) {
      const snap = {}; iRows.forEach(r => snap[r.id] = JSON.stringify(r));
      const { error } = await sb.from("tw_items").upsert(iRows);
      if (error) throw error;
      for (const id in snap) if (OUT.items[id] && JSON.stringify(OUT.items[id]) === snap[id]) delete OUT.items[id];
      saveState();
    }
    if (OUT.del.length) {
      const ids = OUT.del.slice();
      const { error } = await sb.from("tw_items").delete().in("id", ids);
      if (error) throw error;
      OUT.del = OUT.del.filter(id => !ids.includes(id)); saveState();
    }
  } catch (e) {
    pushErr = e.message || "مشكلة في النت";
    if (/jwt|token|401/i.test(pushErr)) { pushing = false; await sessionLost(); return; }
  } finally { pushing = false; renderPending(); }
  if (pendingCount() && !pushErr) setTimeout(flush, 300); // اتغير حاجة أثناء الرفع
}
function renderPending() {
  const n = pendingCount(), t = $("pendingLine");
  t.className = "muted";
  if (!n) { t.textContent = S.items.length ? "✓ متسجل على السيرفر" : ""; return; }
  if (pushErr) { t.className = "muted status err"; t.textContent = "لسه ما اترفعش: " + pushErr; return; }
  t.textContent = navigator.onLine ? "بيرفع…" : "محفوظ على الموبايل، هيترفع لما النت يرجع";
}
setInterval(() => { if (pendingCount()) flush(); }, 20000);
window.addEventListener("online", () => { renderSync(); syncData(false); flush(); });
window.addEventListener("offline", () => { renderSync(); renderPending(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && user) { syncData(false); flush(); } });

/* ---------- تسجيل الدخول (باسورد واحد للكل) ---------- */
let adminMode = false;
$("adminToggle").addEventListener("click", () => {
  adminMode = !adminMode; $("emailWrap").hidden = !adminMode; $("email").required = adminMode;
  $("adminToggle").textContent = adminMode ? "دخول بباسورد الفريق" : "دخول كمشرف";
  (adminMode ? $("email") : $("password")).focus();
});
async function afterSignIn(u) {
  user = u; pref.set("user", u.email);
  $("userLine").textContent = u.email;
  view("app"); renderSync(); renderAll();
  try { const { data: row } = await sb.from("app_admins").select("user_id").eq("user_id", u.id).maybeSingle(); isAdmin = !!row; }
  catch (e) { isAdmin = false; }
  $("adminPanel").hidden = !isAdmin;
  flush();
  await syncData(false);
}
async function sessionLost() {
  user = null; isAdmin = false; data = null; $("adminPanel").hidden = true; syncNote = ""; await clearData(); buildIndex();
  if (running) stopScan();
  $("loginStatus").textContent = "تسجيل الدخول انتهى. ادخل تاني (الدفعة الحالية محفوظة ومش هتضيع).";
  view("login"); renderSync();
}
$("loginView").addEventListener("submit", async e => {
  e.preventDefault();
  const email = adminMode ? $("email").value.trim() : CFG.SHARED_EMAIL;
  const btn = $("loginBtn"); btn.disabled = true; $("loginStatus").className = "status"; $("loginStatus").textContent = "بيسجل دخول…";
  try {
    const { data: res, error } = await sb.auth.signInWithPassword({ email, password: $("password").value });
    if (error) throw error;
    $("password").value = ""; $("loginStatus").textContent = "";
    await afterSignIn(res.user);
  } catch (err) {
    $("loginStatus").className = "status err";
    $("loginStatus").textContent = !navigator.onLine ? "مفيش نت. اتصل بالإنترنت عشان تسجل دخول."
      : /invalid/i.test(err.message || "") ? "الباسورد غلط. اتأكد منه أو اسأل المشرف."
      : "ماقدرش يسجل دخول: " + (err.message || "خطأ غير معروف");
  } finally { btn.disabled = false; }
});
$("signOutBtn").addEventListener("click", async () => {
  if (pendingCount() && !confirm("فيه أصناف لسه ما اترفعتش للسيرفر. لو خرجت دلوقتي ممكن تضيع. تخرج برضه؟")) return;
  if (running) stopScan();
  try { await sb.auth.signOut(); } catch (e) {}
  pref.set("user", null); await sessionLost(); $("loginStatus").textContent = "خرجت، واتمسح شيت الأصناف من الموبايل ده.";
});

/* ---------- رفع شيت الأصناف (للمشرف) ---------- */
let pending = null;
$("uploadFile").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  const st = $("adminStatus"); st.className = "status"; st.textContent = "بيقرا " + f.name + "…"; $("confirmBox").hidden = true;
  try {
    let table;
    if (/\.(csv|txt)$/i.test(f.name)) table = parseCSV(await f.text());
    else {
      await loadXLSX();
      const wb = XLSX.read(await f.arrayBuffer(), { type: "array" });
      table = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: "" });
    }
    const t = tableToData(table);
    const c = detectCols(t.headers, false);
    let sci = 0; for (const r of t.rows) { r[c.code] = r[c.code].replace(/\s+/g, ""); if (/e\+/i.test(r[c.code])) sci++; }
    pending = { t };
    const found = FIELDS.map(x => `${x.label}: ${c[x.k] >= 0 ? "«" + t.headers[c[x.k]] + "»" : "مش موجود ⚠️"}`).join("، ");
    $("confirmText").textContent = `${f.name}: ${num(t.rows.length)} صف` + (t.dupes ? `، واتشال ${num(t.dupes)} صف مكرر` : "") + `. العواميد اللي لقاها: ${found}.`
      + (sci ? ` تحذير: ${sci} باركود شكلهم زي 6.28E+12. خلي عمود الباركود Text في الإكسل واحفظ تاني.` : "");
    $("confirmBox").hidden = false; st.textContent = "";
  } catch (err) { st.className = "status err"; st.textContent = "ماقدرش يقرا الملف: " + (err.message || err) + ". احفظه .xlsx أو .csv وجرب تاني."; }
});
$("cancelUpload").addEventListener("click", () => { pending = null; $("confirmBox").hidden = true; });
$("confirmUpload").addEventListener("click", async () => {
  if (!pending) return;
  const st = $("adminStatus"); st.className = "status"; st.textContent = "بيرفع…"; $("confirmUpload").disabled = true;
  try {
    const blob = new Blob(["﻿" + toCSV(pending.t)], { type: "text/csv" });
    const { error } = await sb.storage.from(BUCKET).upload(FILE, blob, { upsert: true, contentType: "text/csv; charset=utf-8", cacheControl: "0" });
    if (error) throw error;
    const info = await remoteInfo().catch(() => null);
    data = { headers: pending.t.headers, rows: pending.t.rows, version: info ? versionOf(info) : "", updatedAt: info ? Date.parse(info.updated_at) : Date.now() };
    syncNote = ""; await saveData(data); buildIndex();
    st.textContent = `اتنشر ${num(pending.t.rows.length)} صف. الموبايلات هتاخده أول ما التطبيق يتفتح.`;
    $("confirmBox").hidden = true; pending = null;
  } catch (err) {
    st.className = "status err";
    st.textContent = /row-level|policy|403|unauthorized/i.test(err.message || "") ? "الرفع اترفض: الحساب ده مش مشرف في Supabase (جدول app_admins)." : "الرفع فشل: " + (err.message || err);
  } finally { $("confirmUpload").disabled = false; }
});

/* ---------- البحث ---------- */
function lookup(raw, fromCamera) {
  const n = norm(raw); if (!n) return [];
  let rows = byCode.get(n) || byCode.get("z:" + stripZeros(n));
  if (!rows && !fromCamera) rows = byItem.get(n.toLowerCase());
  if (!rows) return [];
  // نفس الصنف مكرر بنفس البيانات؟ اعرضه مرة واحدة
  const seen = new Set();
  return rows.filter(r => { const k = ["code", "loc", "wh", "sup", "item", "desc"].map(x => val(r, x)).join("|"); if (seen.has(k)) return false; seen.add(k); return true; });
}

/* ---------- الصنف الحالي + العداد ---------- */
// cur = { code, rows, row (المختار أو null), qty, miss }
let cur = null;
function scanned(raw, fromCamera) {
  const code = norm(raw); if (!code) return;
  if (cur && !cur.miss && cur.row && (cur.code === code || norm(val(cur.row, "code")) === code)) {
    cur.qty++; renderCurrent(true); feedback(true); status("نفس الصنف: العدد بقى " + cur.qty); return;
  }
  if (cur && cur.row && $("autoAdd").checked) submit(true);
  const rows = lookup(raw, fromCamera);
  if (rows.length) cur = { code: norm(val(rows[0], "code")) || code, rows, row: rows.length === 1 ? rows[0] : null, qty: 1, miss: false };
  else cur = { code, rows: [], row: null, qty: 1, miss: true };
  renderCurrent(true); feedback(!cur.miss);
  status(cur.miss ? "الباركود ده مش في شيت الأصناف: " + code : "اتقرا: " + code);
}
function dl(pairs) {
  const box = el("dl", "fields");
  for (const [k, v, mono] of pairs) { box.append(el("dt", null, k), el("dd", mono ? "mono" : null, v || "—")); }
  return box;
}
function renderCurrent(fresh) {
  const box = $("current"); box.innerHTML = "";
  if (!cur) {
    box.className = "current idle";
    box.append(el("div", "eyebrow", "الصنف"), el("div", "idle-text", "امسح باركود عشان تظهر بيانات الصنف"));
    return;
  }
  box.className = "current " + (cur.miss ? "miss" : "found") + (fresh ? " fresh" : "");
  if (!cur.miss && !cur.row) {           // الباركود ليه أكتر من صف: اختار
    box.append(el("div", "eyebrow", `الباركود ده ليه ${cur.rows.length} صفوف في الشيت. اختار الصح:`));
    const ch = el("div", "choices");
    cur.rows.slice(0, 20).forEach(r => {
      const b = el("button"); b.type = "button";
      b.append(el("span", null, `${val(r, "loc") || "—"} · ${val(r, "sup") || "—"}`), el("span", "muted", val(r, "wh")));
      b.addEventListener("click", () => { cur.row = r; renderCurrent(true); });
      ch.appendChild(b);
    });
    box.appendChild(ch);
    box.appendChild(curFoot());
    return;
  }
  if (cur.miss) {
    box.append(el("div", "eyebrow", "النتيجة"), el("div", "loc", "مش في الشيت"),
      dl([["الباركود", cur.code, true]]),
      el("p", "muted", "تقدر تضيفه برضه بالباركود بس، وتكمّل بياناته بعدين في الإكسل."));
  } else {
    const r = cur.row;
    box.append(el("div", "eyebrow", "الموقع المستهدف"), el("div", "loc", val(r, "loc") || "(فاضي)"),
      el("div", "desc", val(r, "desc") || "—"),
      dl([["المستودع", val(r, "wh")], ["المورد", val(r, "sup")], ["رقم الصنف", val(r, "item"), true], ["الباركود", val(r, "code") || cur.code, true]]));
  }
  // العداد
  const ctr = el("div", "counter");
  const minus = el("button", null, "−"); minus.type = "button"; minus.setAttribute("aria-label", "نقص واحد");
  const plus = el("button", null, "+"); plus.type = "button"; plus.setAttribute("aria-label", "زود واحد");
  const inp = el("input"); inp.type = "number"; inp.inputMode = "numeric"; inp.min = "1"; inp.value = cur.qty; inp.setAttribute("aria-label", "العدد");
  minus.disabled = cur.qty <= 1;
  minus.addEventListener("click", () => { if (cur.qty > 1) { cur.qty--; inp.value = cur.qty; minus.disabled = cur.qty <= 1; } });
  plus.addEventListener("click", () => { cur.qty++; inp.value = cur.qty; minus.disabled = false; });
  inp.addEventListener("input", () => { const v = parseInt(inp.value, 10); if (v > 0) { cur.qty = v; minus.disabled = v <= 1; } });
  inp.addEventListener("blur", () => { inp.value = cur.qty; });
  inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); inp.blur(); submit(); } });
  ctr.append(plus, inp, minus);
  const sub = el("button", "submit", cur.miss ? "إضافة بالباركود بس" : "سبميت"); sub.type = "button";
  sub.addEventListener("click", () => submit());
  box.append(ctr, sub, curFoot());
}
function curFoot() {
  const f = el("div", "cur-foot");
  const cancel = el("button", "link", "إلغاء الصنف ده"); cancel.type = "button";
  cancel.addEventListener("click", () => { cur = null; renderCurrent(); status("اتلغى. امسح الصنف اللي بعده."); });
  f.appendChild(cancel);
  return f;
}
function submit(auto) {
  if (!cur || (!cur.miss && !cur.row)) return;
  const r = cur.row, now = new Date().toISOString();
  const line = r ? { barcode: val(r, "code") || cur.code, item: val(r, "item"), desc: val(r, "desc"), wh: val(r, "wh"), sup: val(r, "sup"), loc: val(r, "loc") }
                 : { barcode: cur.code, item: "", desc: "", wh: "", sup: "", loc: "" };
  const same = S.items.find(x => x.barcode === line.barcode && x.loc === line.loc && x.wh === line.wh && x.sup === line.sup && x.item === line.item);
  let it;
  if (same) { same.qty += cur.qty; it = same; S.items = [same, ...S.items.filter(x => x !== same)]; }
  else { it = { id: uuid(), ...line, qty: cur.qty, at: now }; S.items.unshift(it); }
  queueItem(it); saveState();
  toast(`${auto ? "اتضاف تلقائي: " : "اتضاف: "}${cur.qty} × ${line.desc || line.barcode}${same ? ` (الإجمالي ${it.qty})` : ""}`);
  cur = null; renderCurrent(); renderLines(it.id); flush();
  if (!auto) status("اتضاف. امسح الصنف اللي بعده.");
}

/* ---------- أصناف الدفعة ---------- */
function renderBatch() {
  const s = S.session;
  $("batchName").textContent = s.batchNo ? "دفعة رقم " + s.batchNo : "دفعة جديدة";
  $("batchDate").textContent = "بدأت " + fmt(s.startedAt);
  $("lineCount").textContent = num(S.items.length);
  $("qtyCount").textContent = num(S.items.reduce((a, x) => a + x.qty, 0));
}
function changeQty(it, d) {
  if (it.qty + d <= 0) {
    if (!confirm(`تشيل «${it.desc || it.barcode}» من الدفعة؟`)) return;
    S.items = S.items.filter(x => x !== it); queueDelete(it.id);
  } else { it.qty += d; queueItem(it); }
  saveState(); renderLines(); flush();
}
function renderLines(flashId) {
  const ul = $("lines"); ul.innerHTML = "";
  if (!S.items.length) ul.appendChild(el("li", "empty", "لسه مفيش أصناف في الدفعة دي."));
  for (const it of S.items) {
    const li = el("li"); if (it.id === flashId) li.classList.add("flash");
    const main = el("div", "ln-main");
    main.appendChild(el("div", "ln-desc", it.desc || "(صنف مش في الشيت)"));
    const sub = el("div", "ln-sub");
    sub.append(el("span", "ln-loc", it.loc || "—"), document.createTextNode(" · " + (it.sup || "—") + " · "), el("span", "mono", it.item || it.barcode));
    main.appendChild(sub);
    const q = el("div", "ln-qty");
    const p = el("button", null, "+"); p.type = "button"; p.setAttribute("aria-label", "زود واحد"); p.addEventListener("click", () => changeQty(it, 1));
    const m = el("button", null, it.qty > 1 ? "−" : "×"); m.type = "button"; m.setAttribute("aria-label", it.qty > 1 ? "نقص واحد" : "شيل الصنف"); m.addEventListener("click", () => changeQty(it, -1));
    q.append(p, el("output", null, num(it.qty)), m);
    li.append(main, q); ul.appendChild(li);
  }
  if (flashId) setTimeout(() => ul.querySelector(".flash")?.classList.remove("flash"), 900);
  renderBatch(); renderPending();
}
function renderAll() { renderBatch(); renderLines(); renderCurrent(); }

/* ---------- شيت الإكسل للدفعة ---------- */
const sig = () => S.items.map(x => x.id + ":" + x.qty).join(",");
$("exportBtn").addEventListener("click", async () => {
  if (cur && cur.row) { if (confirm("فيه صنف ظاهر ما دوستش عليه سبميت. تضيفه الأول؟")) submit(); }
  if (!S.items.length) { toast("الدفعة فاضية، مفيش حاجة تتصدّر."); return; }
  const btn = $("exportBtn"); btn.disabled = true;
  try {
    await loadXLSX();
    const s = S.session, exportedAt = new Date();
    const head = ["م", "الباركود", "رقم الصنف", "الوصف", "المستودع", "المورد", "الموقع المستهدف", "الكمية", "وقت المسح"];
    const items = S.items.slice().reverse(); // بترتيب المسح
    const rows = items.map((x, i) => [i + 1, x.barcode, x.item, x.desc, x.wh, x.sup, x.loc, x.qty, new Date(x.at).toLocaleString("en-GB")]);
    const total = items.reduce((a, x) => a + x.qty, 0);
    rows.push(["", "", "", "الإجمالي", "", "", "", total, ""]);
    const ws = XLSX.utils.aoa_to_sheet([head, ...rows]);
    for (let r = 1; r <= items.length; r++) { const a = XLSX.utils.encode_cell({ r, c: 1 }), b = XLSX.utils.encode_cell({ r, c: 2 }); if (ws[a]) ws[a].t = "s"; if (ws[b]) ws[b].t = "s"; }
    ws["!cols"] = [{ wch: 5 }, { wch: 16 }, { wch: 14 }, { wch: 40 }, { wch: 18 }, { wch: 22 }, { wch: 16 }, { wch: 8 }, { wch: 18 }];
    ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: items.length, c: head.length - 1 } }) };
    const info = XLSX.utils.aoa_to_sheet([
      ["رقم الدفعة", s.batchNo || "لسه ما اترفعتش"], ["بداية الدفعة", new Date(s.startedAt).toLocaleString("en-GB")],
      ["وقت التصدير", exportedAt.toLocaleString("en-GB")], ["عدد الأصناف", items.length], ["إجمالي الكمية", total]]);
    info["!cols"] = [{ wch: 16 }, { wch: 24 }];
    const wb = XLSX.utils.book_new();
    wb.Workbook = { Views: [{ RTL: true }] };
    XLSX.utils.book_append_sheet(wb, ws, "الأصناف");
    XLSX.utils.book_append_sheet(wb, info, "بيانات الدفعة");
    const d = exportedAt, pad = n => String(n).padStart(2, "0");
    const name = `tawalef-batch-${s.batchNo || "new"}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.xlsx`;
    const blob = new Blob([XLSX.write(wb, { type: "array", bookType: "xlsx" })], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const file = new File([blob], name, { type: blob.type });
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    let shared = false;
    if (ios && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); shared = true; } catch (e) { if (e.name === "AbortError") return; }
    }
    if (!shared) {
      const a = el("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    }
    s.exportedSig = sig(); saveState();
    toast("اتعمل شيت الإكسل: " + name);
  } catch (e) { toast("ماقدرش يعمل الشيت: " + (e.message || e)); }
  finally { btn.disabled = false; }
});

/* ---------- سيشن جديدة ---------- */
$("newSessionBtn").addEventListener("click", () => {
  if (!S.items.length && !cur) { toast("الدفعة دي فاضية بالفعل. ابدأ مسح."); return; }
  const s = S.session, label = s.batchNo ? "دفعة رقم " + s.batchNo : "الدفعة الحالية";
  const notExported = s.exportedSig !== sig();
  $("newConfirmText").textContent = `هتقفل ${label} (${num(S.items.length)} صنف) وتبدأ دفعة جديدة. أصنافها هتفضل متسجلة على السيرفر.`
    + (notExported ? " ⚠️ لسه ما نزلتش شيت إكسل لآخر نسخة من الدفعة دي." : "")
    + (cur && cur.row ? " الصنف الظاهر اللي ما اتعملوش سبميت هيتلغى." : "");
  $("newConfirm").hidden = false; $("newConfirmYes").focus();
});
$("newConfirmNo").addEventListener("click", () => { $("newConfirm").hidden = true; });
$("newConfirmYes").addEventListener("click", () => {
  $("newConfirm").hidden = true;
  queueSession(new Date().toISOString()); // اقفل القديمة
  cur = null; newSession(); renderAll(); flush();
  status("بدأت دفعة جديدة. امسح أول صنف.");
  toast("بدأت دفعة جديدة");
});

/* ---------- صوت واهتزاز ---------- */
let audio = null;
function feedback(ok) {
  try { navigator.vibrate && navigator.vibrate(ok ? 60 : [80, 60, 80]); } catch (e) {}
  if (!audio) return;
  try {
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = ok ? 1200 : 300; g.gain.value = 0.08;
    o.connect(g); g.connect(audio.destination); o.start(); o.stop(audio.currentTime + (ok ? 0.09 : 0.25));
  } catch (e) {}
}

/* ---------- الكاميرا ---------- */
const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf", "qr_code", "data_matrix"];
let stream = null, running = false, detector = null, wakeLock = null, lastCode = "", lastAt = 0;
const canvas = document.createElement("canvas"); const ctx = canvas.getContext("2d", { willReadFrequently: true });
async function makeDetector() {
  if ("BarcodeDetector" in window) {
    try {
      const sup = await BarcodeDetector.getSupportedFormats();
      const f = FORMATS.filter(x => sup.includes(x));
      if (f.length) return { kind: "native", d: new BarcodeDetector({ formats: f }) };
    } catch (e) {}
  }
  if (window.ZXing) {
    const Z = window.ZXing, hints = new Map();
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A,
      Z.BarcodeFormat.UPC_E, Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.ITF, Z.BarcodeFormat.QR_CODE]);
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    const r = new Z.MultiFormatReader(); r.setHints(hints);
    return { kind: "zxing", d: r };
  }
  return null;
}
async function detectFrame(video) {
  if (detector.kind === "native") { const found = await detector.d.detect(video); return found.length ? found[0].rawValue : null; }
  const Z = window.ZXing, vw = video.videoWidth, vh = video.videoHeight; if (!vw) return null;
  const cw = Math.round(vw * 0.8), ch = Math.round(vh * 0.56), sx = (vw - cw) / 2, sy = (vh - ch) / 2;
  const scale = Math.min(1, 900 / cw);
  canvas.width = Math.round(cw * scale); canvas.height = Math.round(ch * scale);
  ctx.drawImage(video, sx, sy, cw, ch, 0, 0, canvas.width, canvas.height);
  try { return detector.d.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas)))).getText(); }
  catch (e) { return null; } finally { detector.d.reset && detector.d.reset(); }
}
async function loop() {
  const video = $("video");
  while (running) {
    if (video.readyState >= 2) {
      let code = null;
      try { code = await detectFrame(video); } catch (e) {}
      if (code) {
        const now = Date.now();
        const isNew = code !== lastCode || now - lastAt > 1500; // نفس الباركود لو فضل قدام الكاميرا مش بيتعد تاني
        lastAt = now;
        if (isNew) {
          lastCode = code; scanned(code, true);
          $("scanner").classList.add("hit"); setTimeout(() => $("scanner").classList.remove("hit"), 400);
          await new Promise(r => setTimeout(r, 900));
        }
      }
    }
    await new Promise(r => setTimeout(r, detector && detector.kind === "native" ? 120 : 200));
  }
}
async function startScan() {
  try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume && audio.resume(); } catch (e) {}
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { status("المتصفح ده مش بيفتح الكاميرا هنا. استخدم «صوّر الباركود»، أو افتح التطبيق من لينك https."); return; }
  detector = detector || await makeDetector();
  if (!detector) { status("قارئ الباركود ما اتحملش. اتصل بالنت مرة وجرب تاني."); return; }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 }, focusMode: "continuous" } });
  } catch (e) {
    status(e.name === "NotAllowedError" ? "إذن الكاميرا اترفض. اسمح للتطبيق بالكاميرا من إعدادات الموبايل وجرب تاني." : "ماقدرش يفتح الكاميرا: " + (e.message || e.name)); return;
  }
  const video = $("video"); video.srcObject = stream; await video.play().catch(() => {});
  $("scanner").hidden = false; $("startBtn").hidden = true;
  status("وجّه الكاميرا على الباركود. بيفضل يمسح لحد ما تدوس إيقاف.");
  const track = stream.getVideoTracks()[0];
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  $("torchBtn").hidden = !caps.torch; $("torchBtn").setAttribute("aria-pressed", "false");
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch (e) {}
  running = true; loop();
}
function stopScan() {
  running = false;
  if (stream) stream.getTracks().forEach(t => t.stop()); stream = null;
  $("scanner").hidden = true; $("startBtn").hidden = false;
  try { wakeLock && wakeLock.release(); } catch (e) {} wakeLock = null;
}
$("startBtn").addEventListener("click", startScan);
$("stopBtn").addEventListener("click", stopScan);
$("torchBtn").addEventListener("click", async () => {
  const track = stream && stream.getVideoTracks()[0]; if (!track) return;
  const on = $("torchBtn").getAttribute("aria-pressed") !== "true";
  try { await track.applyConstraints({ advanced: [{ torch: on }] }); $("torchBtn").setAttribute("aria-pressed", String(on)); } catch (e) {}
});
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && running) stopScan(); });
$("manual").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); scanned(e.target.value, false); e.target.value = ""; } });

/* ---------- صورة بدل الكاميرا ---------- */
$("photo").addEventListener("change", async e => {
  const f = e.target.files[0]; if (!f) return;
  status("بيقرا الباركود…");
  try {
    const bmp = await createImageBitmap(f);
    let code = null;
    detector = detector || await makeDetector();
    if (detector && detector.kind === "native") { const r = await detector.d.detect(bmp); code = r.length ? r[0].rawValue : null; }
    if (!code && window.ZXing) {
      const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      canvas.width = Math.round(bmp.width * s); canvas.height = Math.round(bmp.height * s);
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const Z = window.ZXing, r = new Z.MultiFormatReader(), h = new Map(); h.set(Z.DecodeHintType.TRY_HARDER, true); r.setHints(h);
      try { code = r.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas)))).getText(); } catch (err) {}
    }
    if (code) scanned(code, true);
    else status("ماقدرش يقرا باركود في الصورة. قرّب، وخلي الباركود مفرود وواضح، أو اكتب الرقم.");
  } catch (err) { status("ماقدرش يفتح الصورة."); }
  e.target.value = "";
});

/* ---------- الإعدادات الصغيرة ---------- */
$("autoAdd").checked = pref.get("autoAdd") !== false;
$("autoAdd").addEventListener("change", () => pref.set("autoAdd", $("autoAdd").checked));

/* ---------- تثبيت + أوفلاين ---------- */
let installEvt = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; $("installBtn").hidden = false; });
$("installBtn").addEventListener("click", async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $("installBtn").hidden = true; });
window.addEventListener("appinstalled", () => { $("installBtn").hidden = true; });
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});

/* ---------- البداية ---------- */
async function boot() {
  if (CFG.APP_NAME) { $("appName").textContent = CFG.APP_NAME; document.title = CFG.APP_NAME; }
  if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY || !window.supabase) { view("setup"); $("syncLine").textContent = ""; return; }
  sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  const remembered = pref.get("user");
  if (remembered && remembered !== CFG.SHARED_EMAIL) { $("email").value = remembered; }
  const cached = remembered ? await loadData() : null;
  if (cached && cached.rows) { data = cached; user = { email: remembered }; $("userLine").textContent = remembered; view("app"); buildIndex(); renderAll(); }
  let session = null;
  try { const r = await sb.auth.getSession(); session = r.data && r.data.session; } catch (e) {}
  if (session) { await afterSignIn(session.user); return; }
  if (cached && !navigator.onLine) return;     // من غير نت: كمّل بالشيت المحفوظ
  if (cached) { await sessionLost(); return; }
  view("login"); renderSync();
}
boot();
})();
