require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const app = express();

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'gizli-secret',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 3600000 }
}));

const ADMIN_USER = 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS;
const SHEET_ID = process.env.SHEET_ID;
const SHEET_TAB_NAME = process.env.SHEET_TAB_NAME || 'Müştəri';

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

function checkAuth(req, res, next) {
  if (req.session.loggedIn) return next();
  const wantsJson = req.path.startsWith('/api/') || req.path.startsWith('/customer/') || req.xhr;
  if (wantsJson) return res.status(401).json({ success: false, error: 'Sessiya bitib.' });
  return res.redirect('/login');
}

// --- TARİX VƏ STATİSTİKA FUNKSİYALARI (HƏMİSİ QALDI) ---
function parseTimestampParts(timestamp) {
  if (!timestamp) return null;
  const raw = timestamp.toString().trim();
  let match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (match) return { year: Number(match), month: Number(match), day: Number(match) };
  match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) return { year: Number(match), month: Number(match), day: Number(match) };
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return { year: parsed.getFullYear(), month: parsed.getMonth() + 1, day: parsed.getDate() };
  return null;
}

function formatDate(timestamp) {
  const parts = parseTimestampParts(timestamp);
  if (!parts) return 'Tarix yoxdur';
  return `${String(parts.day).padStart(2, '0')}.${String(parts.month).padStart(2, '0')}.${parts.year}`;
}

function dateToNumber(dateStr) {
  const parts = parseTimestampParts(dateStr);
  return parts ? parts.year * 10000 + parts.month * 100 + parts.day : 0;
}

function inputDateToNumber(dateStr) {
  if (!dateStr) return null;
  try {
    const [year, month, day] = dateStr.split('-').map(Number);
    return year * 10000 + month * 100 + day;
  } catch { return null; }
}

function filterByDateRange(customers, startDate, endDate) {
  if (!startDate && !endDate) return customers;
  const startNum = inputDateToNumber(startDate);
  const endNum = inputDateToNumber(endDate);
  return customers.filter(c => {
    const custNum = dateToNumber(c['Timestamp']);
    if (custNum === 0) return false;
    if (startNum && custNum < startNum) return false;
    if (endNum && custNum > endNum) return false;
    return true;
  });
}

const AZ_MONTH_NAMES = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'İyun', 'İyul', 'Avqust', 'Sentyabr', 'Oktyabr', 'Noyabr', 'Dekabr'];

function getMonthlyStats(customers) {
  const statsByMonth = new Map();
  const now = new Date();
  let maxMonthIndex = now.getFullYear() * 12 + now.getMonth();
  const startIndex = 2026 * 12 + 4; // May 2026

  for (const customer of customers) {
    if (isArchivedCustomer(customer)) continue;
    const parts = parseTimestampParts(customer?.['Timestamp']);
    if (!parts) continue;
    const key = `${parts.year}-${String(parts.month).padStart(2, '0')}`;
    const s = statsByMonth.get(key) || { total: 0, qosulma: 0, kocurme: 0 };
    
    // M sütunundakı "Qeyd"ə baxır
    const qeydVal = (customer['Qeyd'] || '').toLowerCase();
    s.total += 1;
    if (qeydVal.includes('qoşulma')) s.qosulma += 1;
    else if (qeydVal.includes('köçürmə') || qeydVal.includes('kocurme')) s.kocurme += 1;
    statsByMonth.set(key, s);
  }
  
  const labels = [], total = [], qosulma = [], kocurme = [];
  for (let i = startIndex; i <= maxMonthIndex; i++) {
    const y = Math.floor(i / 12), m = (i % 12) + 1;
    const key = `${y}-${String(m).padStart(2, '0')}`;
    const s = statsByMonth.get(key) || { total: 0, qosulma: 0, kocurme: 0 };
    labels.push(`${AZ_MONTH_NAMES[m-1]} ${y}`);
    total.push(s.total); qosulma.push(s.qosulma); kocurme.push(s.kocurme);
  }
  return { labels, total, qosulma, kocurme };
}

// --- DATA ACCESS ---
async function getSheetData() {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB_NAME}!A:P`, // P-yə qədər oxuyuruq
  });
  const rows = response.data.values || [];
  if (rows.length === 0) return { headers: [], data: [] };
  const headers = rows;
  const data = rows.slice(1).reverse().map((row, idx) => {
    const obj = headers.reduce((o, h, i) => { o[h] = row[i] || ''; return o; }, {});
    obj.rowIndex = rows.length - idx;
    return obj;
  });
  return { headers, data };
}

function cleanSheetValue(val) { return val ? val.toString().replace(/^'/, '').trim() : ''; }
function normalizeDriveLinks(value) { return (value || '').toString().split(/[\n,]+/).map(link => link.trim()).filter(Boolean).join(','); }
function isArchivedCustomer(customer) { return String(customer?.['Arxiv'] || '').trim().toLowerCase() === 'hə'; }
function isTodayCustomer(customer) { 
  const parts = parseTimestampParts(customer?.['Timestamp']);
  const now = new Date();
  return parts && parts.day === now.getDate() && parts.month === (now.getMonth()+1) && parts.year === now.getFullYear();
}

// --- ROUTES ---
app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', (req, res) => {
  if (req.body.username === ADMIN_USER && req.body.password === ADMIN_PASS) {
    req.session.loggedIn = true; res.redirect('/');
  } else { res.render('login', { error: 'Yanlışdır' }); }
});

app.get('/customer/:odemeKodu', checkAuth, async (req, res) => {
  try {
    const { data } = await getSheetData();
    const found = data.find(r => cleanSheetValue(r['Ödəniş kodu']) === req.params.odemeKodu);
    res.json({ success: !!found, data: found });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- ADD (SÜTUNLAR TAM DÜZGÜN) ---
app.post('/add', checkAuth, async (req, res) => {
  try {
    const { odemeKodu, adSoyad, telefon, fin, seriya, modem, tvbox, komendant, unvan, qeyd, operationType, netice } = req.body;
    const ayliq = req.body.ayliqOdenis || '';
    const now = new Date();
    const ts = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()} ${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')}`;

    // A:TS, B:Kod, C:Ad, D:Tel, E:Seriya, F:FIN, G:Unvan, H:Modem, I:TvBox, J:Ayliq, K:Sifre, L:Komendant, M:Qeyd, N:Sekil, O:Arxiv, P:Natica
    const newRow = [
      ts, `'${odemeKodu}`, adSoyad, `'${telefon}`, seriya, fin, unvan, modem, tvbox, ayliq, 
      '', // K: Şifrə (Boş qalır)
      komendant, 
      operationType || qeyd, // M: Qeyd (Bura "Qoşulma" və s. düşür)
      normalizeDriveLinks(req.body.driveLinks), // N: Şəkil
      '', // O: Arxiv
      netice || '' // P: Nəticə
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB_NAME}!A:P`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [newRow] }
    });
    res.render('add-customer', { success: 'Əlavə edildi!', error: null });
  } catch (err) { res.render('add-customer', { success: null, error: err.message }); }
});

// --- EDIT (B-DƏN P-YƏ QƏDƏR) ---
app.post('/edit/:odemeKodu', checkAuth, async (req, res) => {
  try {
    const { rowIndex, odemeKodu, adSoyad, telefon, fin, seriya, modem, tvbox, komendant, unvan, qeyd, operationType, netice } = req.body;
    const updatedRow = [
      `'${odemeKodu}`, adSoyad, `'${telefon}`, seriya, fin, unvan, modem, tvbox, 
      req.body.ayliqOdenis || "", 
      '', // K: Şifrə
      komendant, 
      operationType || qeyd, // M: Qeyd
      normalizeDriveLinks(req.body.driveLinks), // N: Şəkil
      '', // O: Arxiv
      netice || "" // P: Nəticə
    ];
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB_NAME}!B${rowIndex}:P${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [updatedRow] }
    });
    res.redirect('/edit/' + odemeKodu + '?success=1');
  } catch (err) { res.status(500).send(err.message); }
});

app.get('/edit/:odemeKodu', checkAuth, async (req, res) => {
  try {
    const { data } = await getSheetData();
    const customer = data.find(r => cleanSheetValue(r['Ödəniş kodu']) === req.params.odemeKodu.trim());
    if(!customer) return res.redirect('/');
    customer.ayliqOdenis = customer['Aylıq ödəniş'] || "";
    res.render('edit-customer', { customer, success: req.query.success, error: null });
  } catch (err) { res.redirect('/'); }
});

app.get('/', checkAuth, async (req, res) => {
  try {
    let { data } = await getSheetData();
    const totalCount = data.length;
    const monthlyStats = getMonthlyStats(data);
    const q = req.query.q ? req.query.q.trim().toLowerCase() : '';
    
    let filtered = data.filter(r => !isArchivedCustomer(r));
    if(q) {
      filtered = data.filter(c => 
        cleanSheetValue(c['Ödəniş kodu']).toLowerCase().includes(q) || 
        (c['Ad, Soyad, Ata adı'] || '').toLowerCase().includes(q)
      );
    }
    
    const page = parseInt(req.query.page) || 1, limit = 10;
    res.render('dashboard', {
      results: filtered.slice((page-1)*limit, page*limit),
      totalResults: filtered.length,
      currentPage: page,
      totalPages: Math.ceil(filtered.length / limit),
      todayCustomers: data.filter(r => !isArchivedCustomer(r) && isTodayCustomer(r)),
      archivedCustomers: data.filter(isArchivedCustomer),
      totalCount, monthlyStats, formatDate, q, startDate: '', endDate: '', errorMsg: null
    });
  } catch (err) { res.send(err.message); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server ${PORT}-da işləyir`));
