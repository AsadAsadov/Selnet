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
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets'
  ],
});
const sheets = google.sheets({ version: 'v4', auth });

function checkAuth(req, res, next) {
  if (req.session.loggedIn) return next();

  const wantsJson = req.path.startsWith('/api/') || req.path.startsWith('/customer/') || req.xhr;
  if (wantsJson) {
    return res.status(401).json({ success: false, error: 'Sessiya bitib. Zəhmət olmasa yenidən daxil olun.' });
  }

  return res.redirect('/login');
}

// TARİX VƏ STATİSTİKA FUNKSİYALARI
function parseTimestampParts(timestamp) {
  if (!timestamp) return null;
  const raw = timestamp.toString().trim();

  let match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (match) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    const year = Number(match[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return { year, month, day };
  }

  match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return { year, month, day };
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return { year: parsed.getFullYear(), month: parsed.getMonth() + 1, day: parsed.getDate() };
  }

  return null;
}

function formatDate(timestamp) {
  const parts = parseTimestampParts(timestamp);
  if (!parts) return 'Tarix yoxdur';
  return `${String(parts.day).padStart(2, '0')}.${String(parts.month).padStart(2, '0')}.${parts.year}`;
}

function dateToNumber(dateStr) {
  const parts = parseTimestampParts(dateStr);
  if (!parts) return 0;
  return parts.year * 10000 + parts.month * 100 + parts.day;
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

const MONTHLY_STATS_START_YEAR = 2026;
const MONTHLY_STATS_START_MONTH = 5;
const AZ_MONTH_NAMES = [
  'Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'İyun',
  'İyul', 'Avqust', 'Sentyabr', 'Oktyabr', 'Noyabr', 'Dekabr'
];

function monthIndex(year, month) {
  return year * 12 + (month - 1);
}

function monthKey(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function monthLabelFromKey(key) {
  const [year, month] = key.split('-').map(Number);
  return `${AZ_MONTH_NAMES[month - 1]} ${year}`;
}

function getCurrentMonthIndex() {
  const now = new Date();
  return monthIndex(now.getFullYear(), now.getMonth() + 1);
}

function getMonthlyStats(customers) {
  const startIndex = monthIndex(MONTHLY_STATS_START_YEAR, MONTHLY_STATS_START_MONTH);
  const statsByMonth = new Map();
  let maxMonthIndex = Math.max(startIndex, getCurrentMonthIndex());

  for (const customer of customers) {
    if (isArchivedCustomer(customer)) continue;

    const parts = parseTimestampParts(customer?.['Timestamp']);
    if (!parts) continue;

    const currentIndex = monthIndex(parts.year, parts.month);
    if (currentIndex < startIndex) continue;

    const key = monthKey(parts.year, parts.month);
    const monthStats = statsByMonth.get(key) || { total: 0, qosulma: 0, kocurme: 0 };
    const qeyd = (customer['Qeyd'] || '').toLowerCase();

    monthStats.total += 1;
    if (qeyd.includes('qoşulma')) {
      monthStats.qosulma += 1;
    } else if (qeyd.includes('köçürmə') || qeyd.includes('kocurme')) {
      monthStats.kocurme += 1;
    }

    statsByMonth.set(key, monthStats);
    maxMonthIndex = Math.max(maxMonthIndex, currentIndex);
  }

  const labels = [];
  const total = [];
  const qosulma = [];
  const kocurme = [];

  for (let index = startIndex; index <= maxMonthIndex; index += 1) {
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    const key = monthKey(year, month);
    const monthStats = statsByMonth.get(key) || { total: 0, qosulma: 0, kocurme: 0 };

    labels.push(monthLabelFromKey(key));
    total.push(monthStats.total);
    qosulma.push(monthStats.qosulma);
    kocurme.push(monthStats.kocurme);
  }

  return { labels, total, qosulma, kocurme };
}

// DATA GET
async function getSheetData() {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB_NAME}!A:P`,
  });
  const rows = response.data.values || [];
  if (rows.length === 0) return { headers: [], data: [] };
  const headers = rows[0];
  const data = rows.slice(1).reverse().map((row, idx) => {
    const obj = headers.reduce((o, h, i) => { o[h] = row[i] || ''; return o; }, {});
    obj.rowIndex = rows.length - idx;
    return obj;
  });
  return { headers, data };
}

function cleanSheetValue(val) {
  return val ? val.toString().replace(/^'/, '').trim() : '';
}

function normalizeDriveLinks(value) {
  return (value || '')
    .toString()
    .split(/[\n,]+/)
    .map(link => link.trim())
    .filter(Boolean)
    .join(',');
}

function isArchivedCustomer(customer) {
  return String(customer?.['Arxiv'] || '').trim().toLowerCase() === 'hə';
}

function isProblemCustomer(customer) {
  return String(customer?.['Qeyd'] || '').toLowerCase().includes('problem');
}

function isTodayCustomer(customer) {
  const todayNum = dateToNumber(new Date().toLocaleDateString('en-US'));
  return dateToNumber(customer?.['Timestamp']) === todayNum;
}

function paginateCustomers(customers, page, limit) {
  const totalCustomers = customers.length;
  const totalPages = Math.max(1, Math.ceil(totalCustomers / limit));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * limit;
  const paginatedCustomers = customers.slice(start, start + limit);

  return {
    customers: paginatedCustomers,
    data: paginatedCustomers,
    currentPage,
    totalPages,
    totalCustomers,
    limit,
    hasPrevPage: currentPage > 1,
    hasNextPage: currentPage < totalPages
  };
}

function sendCustomerList(res, customers, page, limit) {
  res.json({
    success: true,
    ...paginateCustomers(customers, page, limit)
  });
}

// --- ROUTES ---

app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', (req, res) => {
  if (req.body.username === ADMIN_USER && req.body.password === ADMIN_PASS) {
    req.session.loggedIn = true;
    res.redirect('/');
  } else {
    res.render('login', { error: 'İstifadəçi adı və ya parol yanlışdır' });
  }
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// --- API ROUTES ---

// Tək müştəri datası (JSON)
app.get('/customer/:odemeKodu', checkAuth, async (req, res) => {
  try {
    const { data } = await getSheetData();
    const requestedCode = cleanSheetValue(req.params.odemeKodu);
    const found = data.find(r => cleanSheetValue(r['Ödəniş kodu']) === requestedCode);
    if (!found) return res.status(404).json({ success: false, data: null, error: 'Müştəri tapılmadı.' });
    res.json({ success: true, data: found });
  } catch (err) {
    console.error('GET /customer/:odemeKodu failed:', err);
    res.status(500).json({ success: false, data: null, error: err.message });
  }
});

function parsePositiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

// Bütün müştəriləri JSON olaraq qaytaran route (DASHBOARD ÜÇÜN)
app.get('/api/all-customers', checkAuth, async (req, res) => {
  const page = parsePositiveInteger(req.query.page, 1);
  const limit = parsePositiveInteger(req.query.limit, 10, 100);

  try {
    const { data } = await getSheetData();
    sendCustomerList(res, Array.isArray(data) ? data : [], page, limit);
  } catch (err) {
    console.error('GET /api/all-customers failed:', err);
    res.status(500).json({ success: false, customers: [], totalPages: 1, totalCustomers: 0, error: err.message });
  }
});

app.get('/api/today-customers', checkAuth, async (req, res) => {
  const page = parsePositiveInteger(req.query.page, 1);
  const limit = parsePositiveInteger(req.query.limit, 10, 100);

  try {
    const { data } = await getSheetData();
    const customers = (Array.isArray(data) ? data : []).filter(customer => !isArchivedCustomer(customer) && isTodayCustomer(customer));
    sendCustomerList(res, customers, page, limit);
  } catch (err) {
    console.error('GET /api/today-customers failed:', err);
    res.status(500).json({ success: false, customers: [], totalPages: 1, totalCustomers: 0, error: err.message });
  }
});

app.get('/api/archive-customers', checkAuth, async (req, res) => {
  const page = parsePositiveInteger(req.query.page, 1);
  const limit = parsePositiveInteger(req.query.limit, 10, 100);

  try {
    const { data } = await getSheetData();
    const customers = (Array.isArray(data) ? data : []).filter(isArchivedCustomer);
    sendCustomerList(res, customers, page, limit);
  } catch (err) {
    console.error('GET /api/archive-customers failed:', err);
    res.status(500).json({ success: false, customers: [], totalPages: 1, totalCustomers: 0, error: err.message });
  }
});

app.get('/api/problem-customers', checkAuth, async (req, res) => {
  const page = parsePositiveInteger(req.query.page, 1);
  const limit = parsePositiveInteger(req.query.limit, 10, 100);
  const solvedParam = req.query.solved;

  try {
    const { data } = await getSheetData();
    let customers = (Array.isArray(data) ? data : []).filter(isProblemCustomer);

    if (solvedParam === 'true') {
      customers = customers.filter(c => String(c['Nəticə'] || '').trim() !== '');
    } else if (solvedParam === 'false') {
      customers = customers.filter(c => String(c['Nəticə'] || '').trim() === '');
    }

    sendCustomerList(res, customers, page, limit);
  } catch (err) {
    console.error('GET /api/problem-customers failed:', err);
    res.status(500).json({ success: false, customers: [], totalPages: 1, totalCustomers: 0, error: err.message });
  }
});

// --- MÜŞTƏRİ ƏMƏLİYYATLARI ---

// ADD CUSTOMER
app.get('/add', checkAuth, (req, res) => res.render('add-customer', { success: null, error: null }));
app.post('/add', checkAuth, async (req, res) => {
  try {
    const odemeKodu = req.body.odemeKodu || '';
    const adSoyad = req.body.adSoyad || '';
    const telefon = req.body.telefon || '';
    const fin = req.body.fin || '';
    const seriya = req.body.seriya || '';
    const modem = req.body.modem || '';
    const tvbox = req.body.tvbox || '';
    const komendant = req.body.komendant || '';
    const unvan = req.body.unvan || '';
    const operationType = req.body.operationType || '';
    const note = operationType || req.body.qeyd || '';
    const ayliqOdenis = req.body.ayliqOdenis || req.body.aylıqOdenis || '';
    const driveLinks = normalizeDriveLinks(req.body.driveLinks);
    const netice = req.body.netice || '';
    const now = new Date();
    const timestamp = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()} ${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')}`;

    const newRow = [
      timestamp,
      `'${odemeKodu}`,
      adSoyad,
      `'${telefon}`,
      seriya,
      fin,
      unvan,
      modem,
      tvbox,
      ayliqOdenis,
      '',
      komendant,
      note,
      driveLinks,
      '',
      netice
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB_NAME}!A:P`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [newRow] }
    });
    res.render('add-customer', { success: 'Müştəri uğurla əlavə edildi!', error: null });
  } catch (err) { res.render('add-customer', { success: null, error: 'Xəta: ' + err.message }); }
});

// EDIT CUSTOMER (POST)
app.post('/edit/:odemeKodu', checkAuth, async (req, res) => {
  try {
    const rowIndex = req.body.rowIndex;
    const odemeKodu = req.body.odemeKodu || '';
    const adSoyad = req.body.adSoyad || '';
    const telefon = req.body.telefon || '';
    const fin = req.body.fin || '';
    const seriya = req.body.seriya || '';
    const modem = req.body.modem || '';
    const tvbox = req.body.tvbox || '';
    const komendant = req.body.komendant || '';
    const unvan = req.body.unvan || '';
    const qeyd = req.body.qeyd || '';
    const ayliq = req.body.ayliqOdenis || req.body.aylıqOdenis || '';
    const driveLinks = normalizeDriveLinks(req.body.driveLinks);
    const netice = req.body.netice || '';

    let existingArxiv = '';
    try {
      const { data } = await getSheetData();
      const existingRow = data.find(r => String(r.rowIndex) === String(rowIndex));
      existingArxiv = existingRow ? (existingRow['Arxiv'] || '') : '';
    } catch (error) {
      existingArxiv = '';
    }

    const updatedRow = [
      `'${odemeKodu}`,
      adSoyad,
      `'${telefon}`,
      seriya,
      fin,
      unvan,
      modem,
      tvbox,
      ayliq,
      '',
      komendant,
      qeyd,
      driveLinks,
      existingArxiv,
      netice
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB_NAME}!B${rowIndex}:P${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [updatedRow] }
    });

    res.redirect('/edit/' + odemeKodu + '?success=1');
  } catch (err) { 
    console.error(err);
    res.status(500).send("Xəta: " + err.message); 
  }
});

app.get('/edit/:odemeKodu', checkAuth, async (req, res) => {
  try {
    const { data } = await getSheetData();
    const customer = data.find(r => cleanSheetValue(r['Ödəniş kodu']) === req.params.odemeKodu.trim());
    if(!customer) return res.redirect('/');
    customer.ayliqOdenis = customer['Aylıq ödəniş'] || customer['ayliqOdenis'] || "";
    res.render('edit-customer', { customer, success: req.query.success ? 'Yeniləndi' : null, error: null });
  } catch (err) { res.redirect('/'); }
});

// DELETE & ARCHIVE
app.post('/delete/:odemeKodu', checkAuth, async (req, res) => {
  try {
    const { rowIndex } = req.body;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      resource: { requests: [{ deleteDimension: { range: { sheetId: 0, dimension: 'ROWS', startIndex: rowIndex - 1, endIndex: rowIndex } } }] }
    });
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

app.post('/archive/:odemeKodu', checkAuth, async (req, res) => {
  try {
    const { rowIndex, archive } = req.body;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB_NAME}!O${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[archive ? 'Hə' : '']] }
    });
    res.json({ success: true });
  } catch (error) { res.json({ success: false }); }
});

// MAIN DASHBOARD
app.get('/', checkAuth, async (req, res) => {
  let results = [];
  let todayCustomers = [];
  let archivedCustomers = [];
  let totalCount = 0;
  let problemCount = 0;
  let monthlyStats = { labels: [], total: [], qosulma: [], kocurme: [] };
  let errorMsg = req.query.error || null;
  const q = req.query.q ? req.query.q.trim() : '';
  const startDate = req.query.startDate || '';
  const endDate = req.query.endDate || '';
  const status = req.query.status ? req.query.status.trim().toLowerCase() : '';
  const page = parseInt(req.query.page, 10) || 1;
  const limit = 10;

  try {
    let { data } = await getSheetData();
    totalCount = data.length;
    problemCount = (Array.isArray(data) ? data : []).filter(isProblemCustomer).length;
    monthlyStats = getMonthlyStats(data);

    data = filterByDateRange(data, startDate, endDate);

    const activeData = data.filter(r => !isArchivedCustomer(r));
    archivedCustomers = data.filter(isArchivedCustomer);

    if (status === 'problem') {
      results = data.filter(isProblemCustomer);
    } else if (q) {
      const sq = q.toLowerCase().replace(/\s/g, '');
      results = data.filter(c => {
        const ok = cleanSheetValue(c['Ödəniş kodu']).toLowerCase();
        const tel = cleanSheetValue(c['Telefon nömrəsi']).toLowerCase().replace(/\s/g, '');
        const ad = (c['Ad, Soyad, Ata adı'] || '').toLowerCase();
        return ok.includes(sq) || tel.includes(sq) || ad.includes(sq);
      });
    } else if (startDate || endDate) {
      results = data;
    } else {
      todayCustomers = activeData.filter(isTodayCustomer);
      results = activeData;
    }
  } catch (err) {
    console.error(err);
    errorMsg = 'Xəta: ' + err.message;
  }

  const totalResults = results.length;
  const totalPages = Math.ceil(totalResults / limit);
  const paginatedResults = results.slice((page - 1) * limit, page * limit);

  res.render('dashboard', {
    results: paginatedResults,
    q,
    startDate,
    endDate,
    status,
    errorMsg,
    totalResults,
    currentPage: page,
    totalPages,
    todayCustomers,
    archivedCustomers,
    totalCount,
    problemCount,
    monthlyStats,
    formatDate
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server ${PORT}-da işləyir`));
