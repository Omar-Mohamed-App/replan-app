const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const PDFDocument = require("pdfkit");
const path = require("path");
const fs = require("fs");

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(express.static("public"));
app.use(express.json({ limit: "25mb" }));

/* =========================
   Storage (JSON)
========================= */
const DATA_DIR = path.join(__dirname, "data");
const FONTS_DIR = path.join(__dirname, "fonts");
const AR_FONT_PATH = path.join(FONTS_DIR, "Amiri-Regular.ttf");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "1234";

const STOCK_FILE = path.join(DATA_DIR, "stock_master.json");
const RUNS_FILE = path.join(DATA_DIR, "replan_runs.json");
const NEWC_FILE = path.join(DATA_DIR, "new_collection.json");
const LIMITS_FILE = path.join(DATA_DIR, "floor_limits.json");

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync("uploads")) fs.mkdirSync("uploads", { recursive: true });
  if (!fs.existsSync(FONTS_DIR)) fs.mkdirSync(FONTS_DIR, { recursive: true });
}
ensureDirs();

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}
function saveJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
}

function loadStockMaster() {
  return loadJson(STOCK_FILE, { updatedAt: null, sourceFileName: null, items: {} });
}
function saveStockMaster(master) { saveJson(STOCK_FILE, master); }

function loadRuns() { return loadJson(RUNS_FILE, { runs: [] }); }
function saveRuns(runsObj) { saveJson(RUNS_FILE, runsObj); }

function loadNewCollection() {
  return loadJson(NEWC_FILE, { createdAt: null, mode: null, items: [] });
}
function saveNewCollection(obj) { saveJson(NEWC_FILE, obj); }

function loadLimits() {
  return loadJson(LIMITS_FILE, { defaultMin: 1, defaultMax: 1, skus: {} });
}
function saveLimits(obj) { saveJson(LIMITS_FILE, obj); }

function requireAdmin(req, res) {
  const pw = String(req.headers["x-admin-password"] || req.body?.password || "").trim();
  if (!pw || pw !== ADMIN_PASSWORD) {
    res.status(401).json({ error: "Unauthorized (Admin password required)" });
    return false;
  }
  return true;
}

/* =========================
   Parsing (A text, B Qty)
========================= */
const skuRegex = /\[(\d+)\]/;
const parenRegex = /\(([^()]*)\)/g;

function looksLikeSize(v) {
  const s = String(v || "").trim().toUpperCase();
  if (!s) return false;
  if (/^\d+(\.\d+)?$/.test(s)) return true;
  if (/^(XXS|XS|S|M|L|XL|XXL|XXXL)$/.test(s)) return true;
  if (/^\d+\s*(Y|YR|YEARS|M|MO|MONTHS)$/.test(s)) return true;
  if (/^\d+\s*[-\/]\s*\d+$/.test(s)) return true;
  return false;
}

function parseTextLine(text) {
  const skuMatch = String(text).match(skuRegex);
  if (!skuMatch) return { sku: "", color: "", size: "" };
  const sku = skuMatch[1];

  let color = "";
  let size = "";

  const parens = [];
  let m;
  const t = String(text);
  while ((m = parenRegex.exec(t)) !== null) parens.push(m[1]);

  if (parens.length) {
    const last = parens[parens.length - 1]; // "(منت, 6)" OR "(6, منت)"
    const parts = last.split(/[,،]/).map(x => x.trim()).filter(Boolean);

    if (parts.length >= 2) {
      const p1 = parts[0], p2 = parts[1];
      if (looksLikeSize(p1) && !looksLikeSize(p2)) { size = p1; color = p2; }
      else { color = p1; size = p2; }
    } else if (parts.length === 1) {
      if (looksLikeSize(parts[0])) size = parts[0];
      else color = parts[0];
    }
  }
  return { sku, color, size };
}

function readRowsFromUploadedFile(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  let rows = [];

  if (ext === ".xlsx" || ext === ".xls") {
    const wb = XLSX.readFile(filePath);
    const sheetName = wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const json = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
    rows = json.map(r => [r[0], r[1]]);
  } else if (ext === ".csv") {
    const csv = fs.readFileSync(filePath, "utf8");
    rows = csv.split(/\r?\n/).map(line => {
      const parts = line.split(",");
      return [parts[0], parts[1]];
    });
  } else {
    throw new Error("Unsupported file type. Use .xlsx or .csv");
  }
  return rows;
}

function parseRows(rows) {
  let currentCategory = "";
  const agg = new Map(); // category||sku||size||color -> qty

  for (const r of rows) {
    const text = String(r[0] ?? "").trim();
    const qty = Number(r[1]) || 0;
    if (!text) continue;

    const hasSku = skuRegex.test(text);
    if (!hasSku) {
      if (text.toLowerCase() !== "quantity") currentCategory = text;
      continue;
    }

    const { sku, color, size } = parseTextLine(text);
    if (!sku) continue;

    const key = `${currentCategory}||${sku}||${size}||${color}`;
    agg.set(key, (agg.get(key) || 0) + qty);
  }

  const out = [];
  for (const [key, qty] of agg.entries()) {
    const [category, sku, size, color] = key.split("||");
    out.push({ category, sku, size, color, qty });
  }
  return out;
}

function makeKey(sku, size, color) {
  return `${sku}||${size}||${color}`;
}

/* =========================
   Limits (Min/Max per SKU)
========================= */
function getSkuLimits(sku) {
  const lim = loadLimits();
  const rec = lim.skus?.[String(sku)] || {};
  const min = Number.isFinite(Number(rec.min)) ? Number(rec.min) : Number(lim.defaultMin || 1);
  const max = Number.isFinite(Number(rec.max)) ? Number(rec.max) : Number(lim.defaultMax || 1);
  return { min: Math.max(0, Math.floor(min)), max: Math.max(0, Math.floor(max)) };
}
function clampPull(balance, min, max) {
  if (balance < min) return 0;
  return Math.min(balance, max);
}

/* =========================
   STOCK UPDATE (REPLACE)
   - After Clear: NewCollection = ALL keys, qty=1, Pending
   - Normal update: NewCollection = ONLY new keys, qty=1, Pending
========================= */
app.post("/api/stock/update", upload.single("stock"), (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!req.file) return res.status(400).json({ error: "No stock file uploaded" });

    const oldMaster = loadStockMaster();
    const oldItems = oldMaster.items || {};
    const hadOldStock = Object.keys(oldItems).length > 0;

    const rows = readRowsFromUploadedFile(req.file.path, req.file.originalname);
    fs.unlinkSync(req.file.path);

    const parsed = parseRows(rows);

    // Build new snapshot (REPLACE)
    const newItems = {};
    for (const it of parsed) {
      const key = makeKey(it.sku, it.size, it.color);
      newItems[key] = {
        sku: it.sku,
        size: it.size,
        color: it.color,
        category: it.category,
        qty: Number(it.qty) || 0
      };
    }

    const nowIso = new Date().toISOString();
    const newCollection = [];

    if (!hadOldStock) {
      // Base after clear: ALL keys
      for (const key of Object.keys(newItems)) {
        const x = newItems[key];
        if ((Number(x.qty) || 0) >= 1) {
          newCollection.push({
            lineId: key,
            category: x.category,
            sku: x.sku,
            size: x.size,
            color: x.color,
            qty: 1,
            status: "Pending",
            executedAt: null
          });
        }
      }
      saveNewCollection({ createdAt: nowIso, mode: "BASE_PENDING_ALL", items: newCollection });
    } else {
      // Normal update: ONLY new keys
      for (const key of Object.keys(newItems)) {
        if (!oldItems[key]) {
          const x = newItems[key];
          if ((Number(x.qty) || 0) >= 1) {
            newCollection.push({
              lineId: key,
              category: x.category,
              sku: x.sku,
              size: x.size,
              color: x.color,
              qty: 1,
              status: "Pending",
              executedAt: null
            });
          }
        }
      }
      saveNewCollection({ createdAt: nowIso, mode: "UPDATE_PENDING_NEW_ONLY", items: newCollection });
    }

    const master = { updatedAt: nowIso, sourceFileName: req.file.originalname, items: newItems };
    saveStockMaster(master);

    return res.json({
      updatedAt: master.updatedAt,
      totalLines: Object.keys(newItems).length,
      baseMode: !hadOldStock,
      newCollectionCount: newCollection.length
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// Clear stock (Admin)
app.post("/api/stock/clear", (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    saveStockMaster({ updatedAt: new Date().toISOString(), sourceFileName: null, items: {} });
    saveRuns({ runs: [] });
    saveNewCollection({ createdAt: null, mode: null, items: [] });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

/* =========================
   Stock Search (Qty>0 only)
========================= */
app.get("/api/stock/search", (req, res) => {
  try {
    const q = String(req.query.q || "").trim().toLowerCase();
    const category = String(req.query.category || "").trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 2000);

    const stockMaster = loadStockMaster();
    const itemsObj = stockMaster.items || {};
    let items = Object.values(itemsObj);

    items = items.filter(x => (Number(x.qty) || 0) > 0); // hide zero
    if (category) items = items.filter(x => x.category === category);

    if (q) {
      items = items.filter(x => {
        const sku = String(x.sku || "").toLowerCase();
        const size = String(x.size || "").toLowerCase();
        const color = String(x.color || "").toLowerCase();
        const cat = String(x.category || "").toLowerCase();
        return sku.includes(q) || size.includes(q) || color.includes(q) || cat.includes(q);
      });
    }

    items.sort((a, b) => (Number(b.qty) || 0) - (Number(a.qty) || 0));
    return res.json({ updatedAt: stockMaster.updatedAt, count: items.length, items: items.slice(0, limit) });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

/* =========================
   Limits APIs
========================= */
app.get("/api/limits/get", (req, res) => res.json(loadLimits()));

app.post("/api/limits/setDefault", (req, res) => {
  try {
    const defaultMin = Number(req.body?.defaultMin);
    const defaultMax = Number(req.body?.defaultMax);
    if (!Number.isFinite(defaultMin) || !Number.isFinite(defaultMax)) return res.status(400).json({ error: "defaultMin/defaultMax must be numbers" });

    const lim = loadLimits();
    lim.defaultMin = Math.max(0, Math.floor(defaultMin));
    lim.defaultMax = Math.max(0, Math.floor(defaultMax));
    saveLimits(lim);
    return res.json({ ok: true, defaultMin: lim.defaultMin, defaultMax: lim.defaultMax });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/limits/set", (req, res) => {
  try {
    const sku = String(req.body?.sku || "").trim();
    const min = Number(req.body?.min);
    const max = Number(req.body?.max);
    if (!sku) return res.status(400).json({ error: "Missing sku" });
    if (!Number.isFinite(min) || !Number.isFinite(max)) return res.status(400).json({ error: "min/max must be numbers" });

    const lim = loadLimits();
    lim.skus = lim.skus || {};
    lim.skus[sku] = { min: Math.max(0, Math.floor(min)), max: Math.max(0, Math.floor(max)) };
    saveLimits(lim);
    return res.json({ ok: true, sku, limits: lim.skus[sku] });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

/* =========================
   New Collection APIs
========================= */
app.get("/api/newcollection/latest", (req, res) => res.json(loadNewCollection()));

app.post("/api/newcollection/execute", (req, res) => {
  try {
    const lineId = String(req.body?.lineId || "").trim();
    if (!lineId) return res.status(400).json({ error: "Missing lineId" });

    const nc = loadNewCollection();
    const line = nc.items.find(x => x.lineId === lineId);
    if (!line) return res.status(404).json({ error: "Line not found" });
    if (line.status === "Done") return res.json({ ok: true, line, message: "Already executed" });

    const stock = loadStockMaster();
    const st = stock.items?.[lineId];
    if (!st) return res.status(400).json({ error: "Item not found in stock" });

    const need = Number(line.qty) || 0; // 1
    const have = Number(st.qty) || 0;
    if (have < need) return res.status(400).json({ error: `Insufficient stock. Have ${have}, need ${need}` });

    st.qty = have - need;
    line.status = "Done";
    line.executedAt = new Date().toISOString();

    saveStockMaster(stock);
    saveNewCollection(nc);

    return res.json({ ok: true, line, newStockQty: st.qty });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/newcollection/executeAll", (req, res) => {
  try {
    const nc = loadNewCollection();
    const stock = loadStockMaster();

    let executed = 0, failed = 0;
    const failures = [];
    const now = new Date().toISOString();

    for (const line of nc.items) {
      if (line.status === "Done") continue;

      const st = stock.items?.[line.lineId];
      const need = Number(line.qty) || 0;
      const have = Number(st?.qty) || 0;

      if (!st || need <= 0) { failed++; failures.push({ lineId: line.lineId, reason: "Missing stock / qty<=0" }); continue; }
      if (have < need) { failed++; failures.push({ lineId: line.lineId, reason: `Insufficient have ${have}, need ${need}` }); continue; }

      st.qty = have - need;
      line.status = "Done";
      line.executedAt = now;
      executed++;
    }

    saveStockMaster(stock);
    saveNewCollection(nc);

    return res.json({ ok: true, executed, failed, failures, items: nc.items });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

/* =========================
   Replan Generate + Execute
========================= */
app.post("/api/replan/generate", upload.single("sales"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No sales file uploaded" });

    const categoryFilter = String(req.body?.category || "").trim();
    const stockMaster = loadStockMaster();
    const stockItems = stockMaster.items || {};
    if (!stockMaster.updatedAt || Object.keys(stockItems).length === 0) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "Stock is empty. Update stock first." });
    }

    const salesRows = readRowsFromUploadedFile(req.file.path, req.file.originalname);
    fs.unlinkSync(req.file.path);
    const salesParsed = parseRows(salesRows);

    const salesMap = new Map();
    for (const it of salesParsed) {
      const key = makeKey(it.sku, it.size, it.color);
      salesMap.set(key, (salesMap.get(key) || 0) + (Number(it.qty) || 0));
    }

    const lines = [];
    for (const [key, salesQtyRaw] of salesMap.entries()) {
      const salesQty = Number(salesQtyRaw) || 0;
      if (salesQty <= 0) continue;

      const st = stockItems[key];
      if (!st) continue;
      if (categoryFilter && st.category !== categoryFilter) continue;

      const stockQty = Number(st.qty) || 0;
      const balance = stockQty - salesQty;
      if (balance <= 0) continue;

      const { min, max } = getSkuLimits(st.sku);
      const pullQty = clampPull(balance, min, max);
      if (pullQty <= 0) continue;

      lines.push({
        lineId: key,
        category: st.category,
        sku: st.sku,
        size: st.size,
        color: st.color,
        stockQty,
        salesQty,
        balance,
        pullQty,
        status: "Pending",
        executedAt: null
      });
    }

    const runId = "RUN-" + Date.now();
    const run = {
      runId,
      createdAt: new Date().toISOString(),
      categoryFilter: categoryFilter || "All",
      salesFileName: req.file.originalname,
      lines: lines.sort((a, b) => (b.balance - a.balance) || String(a.sku).localeCompare(String(b.sku)))
    };

    const runsObj = loadRuns();
    runsObj.runs.unshift(run);
    saveRuns(runsObj);

    return res.json({ runId, createdAt: run.createdAt, categoryFilter: run.categoryFilter, linesCount: run.lines.length, lines: run.lines });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/replan/execute", (req, res) => {
  try {
    const runId = String(req.body?.runId || "").trim();
    const lineId = String(req.body?.lineId || "").trim();
    if (!runId || !lineId) return res.status(400).json({ error: "Missing runId or lineId" });

    const runsObj = loadRuns();
    const run = runsObj.runs.find(r => r.runId === runId);
    if (!run) return res.status(404).json({ error: "Run not found" });

    const line = run.lines.find(l => l.lineId === lineId);
    if (!line) return res.status(404).json({ error: "Line not found" });
    if (line.status === "Done") return res.json({ ok: true, line, message: "Already executed" });

    const stock = loadStockMaster();
    const st = stock.items?.[lineId];
    if (!st) return res.status(400).json({ error: "Item not found in stock" });

    const need = Number(line.pullQty) || 0;
    const have = Number(st.qty) || 0;
    if (have < need) return res.status(400).json({ error: `Insufficient stock. Have ${have}, need ${need}` });

    st.qty = have - need;
    line.status = "Done";
    line.executedAt = new Date().toISOString();

    saveStockMaster(stock);
    saveRuns(runsObj);

    return res.json({ ok: true, line, newStockQty: st.qty });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/replan/executeAll", (req, res) => {
  try {
    const runId = String(req.body?.runId || "").trim();
    if (!runId) return res.status(400).json({ error: "Missing runId" });

    const runsObj = loadRuns();
    const run = runsObj.runs.find(r => r.runId === runId);
    if (!run) return res.status(404).json({ error: "Run not found" });

    const stock = loadStockMaster();
    let executed = 0, failed = 0;
    const failures = [];
    const now = new Date().toISOString();

    for (const line of run.lines) {
      if (line.status === "Done") continue;

      const st = stock.items?.[line.lineId];
      const need = Number(line.pullQty) || 0;
      const have = Number(st?.qty) || 0;

      if (!st || need <= 0) { failed++; failures.push({ lineId: line.lineId, reason: "Missing stock / pullQty<=0" }); continue; }
      if (have < need) { failed++; failures.push({ lineId: line.lineId, reason: `Insufficient have ${have}, need ${need}` }); continue; }

      st.qty = have - need;
      line.status = "Done";
      line.executedAt = now;
      executed++;
    }

    saveStockMaster(stock);
    saveRuns(runsObj);

    return res.json({ ok: true, executed, failed, failures, lines: run.lines });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

/* =========================
   Dashboard (from runs JSON)
========================= */
app.get("/api/dashboard", (req, res) => {
  try {
    const days = Math.max(Number(req.query.days) || 30, 1);
    const staleDays = Math.max(Number(req.query.staleDays) || 14, 1);
    const category = String(req.query.category || "").trim();

    const since = Date.now() - days * 24 * 3600 * 1000;
    const staleCutoff = Date.now() - staleDays * 24 * 3600 * 1000;

    const runsObj = loadRuns();
    const doneLines = [];
    const lastBySku = new Map();

    for (const run of runsObj.runs) {
      for (const l of run.lines) {
        if (l.status === "Done" && l.executedAt) {
          const t = new Date(l.executedAt).getTime();
          if (!category || l.category === category) {
            const skuKey = `${l.category}||${l.sku}||${l.size}||${l.color}`;
            lastBySku.set(skuKey, Math.max(lastBySku.get(skuKey) || 0, t));
          }
          if (t >= since) {
            if (!category || l.category === category) doneLines.push(l);
          }
        }
      }
    }

    const byCat = new Map();
    const bySku = new Map();
    for (const l of doneLines) {
      byCat.set(l.category, (byCat.get(l.category) || 0) + (Number(l.pullQty) || 0));
      const skuKey = `${l.category}||${l.sku}`;
      bySku.set(skuKey, (bySku.get(skuKey) || 0) + (Number(l.pullQty) || 0));
    }

    const topCategories = Array.from(byCat.entries())
      .map(([category, qty]) => ({ category, qty }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 15);

    const topSkus = Array.from(bySku.entries())
      .map(([k, qty]) => {
        const [cat, sku] = k.split("||");
        return { category: cat, sku, qty };
      })
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 20);

    const stockMaster = loadStockMaster();
    const stockItems = stockMaster.items || {};
    const noReplan = [];

    for (const key of Object.keys(stockItems)) {
      const st = stockItems[key];
      const qty = Number(st.qty) || 0;
      if (qty <= 0) continue;
      if (category && st.category !== category) continue;

      const skuKey = `${st.category}||${st.sku}||${st.size}||${st.color}`;
      const last = lastBySku.get(skuKey) || 0;

      if (last === 0 || last < staleCutoff) {
        noReplan.push({
          category: st.category,
          sku: st.sku,
          size: st.size,
          color: st.color,
          stockQty: st.qty,
          lastExecutedAt: last ? new Date(last).toISOString() : null
        });
      }
    }

    noReplan.sort((a, b) => (a.lastExecutedAt || "").localeCompare(b.lastExecutedAt || ""));
    return res.json({ windowDays: days, staleDays, category: category || "All", topCategories, topSkus, noReplan: noReplan.slice(0, 200) });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

/* =========================
   PDF (Arabic-ready if font exists)
========================= */
app.post("/api/pdf", (req, res) => {
  try {
    const title = String(req.body?.title || "Report").trim();
    const items = req.body?.items;
    if (!Array.isArray(items)) return res.status(400).json({ error: "Missing items" });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${title.replace(/[^\w\- ]/g, "_")}.pdf"`);

    const doc = new PDFDocument({ margin: 36, size: "A4" });
    doc.pipe(res);

    const hasArabicFont = fs.existsSync(AR_FONT_PATH);
    if (hasArabicFont) {
      doc.registerFont("AR", AR_FONT_PATH);
      doc.font("AR");
    } else {
      doc.font("Helvetica");
    }

    doc.fontSize(16).text(title, { align: "center" });
    doc.moveDown(0.3);
    doc.fontSize(10).text(`Generated: ${new Date().toLocaleString()}`, { align: "center" });
    doc.moveDown(1);

    const headers = ["الفئة", "SKU", "المقاس", "اللون", "الكمية"];
    const col = { cat: 36, sku: 220, size: 320, color: 390, qty: 520 };

    doc.fontSize(11);
    doc.text(headers[0], col.cat, doc.y, { continued: true });
    doc.text(headers[1], col.sku, doc.y, { continued: true });
    doc.text(headers[2], col.size, doc.y, { continued: true });
    doc.text(headers[3], col.color, doc.y, { continued: true });
    doc.text(headers[4], col.qty, doc.y);

    doc.moveDown(0.3);
    doc.moveTo(36, doc.y).lineTo(560, doc.y).stroke();
    doc.moveDown(0.5);

    let y = doc.y;
    for (const it of items) {
      if (y > 760) { doc.addPage(); y = 36; if (hasArabicFont) doc.font("AR"); }
      doc.text(String(it.category ?? ""), col.cat, y, { width: 175, ellipsis: true });
      doc.text(String(it.sku ?? ""), col.sku, y, { width: 90 });
      doc.text(String(it.size ?? ""), col.size, y, { width: 60 });
      doc.text(String(it.color ?? ""), col.color, y, { width: 120, ellipsis: true });
      doc.text(String(it.qty ?? ""), col.qty, y, { width: 40, align: "right" });
      y += 18;
    }

    const totalQty = items.reduce((s, x) => s + (Number(x.qty) || 0), 0);
    doc.moveDown(1);
    doc.fontSize(12).text(`الإجمالي: ${totalQty}`, { align: "right" });

    doc.end();
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

/* =========================
   Start
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on http://localhost:" + PORT));