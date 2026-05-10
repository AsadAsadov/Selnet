require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const app = express();

// --- GÖRÜNÜŞ VƏ PARSER AYARLARI ---
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

app.use(session({
  secret: process.env.SESSION_SECRET || 'gizli-secret-key-123',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 3600000 } // 1 saat
}));

const ADMIN_USER = 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS;
const SHEET_ID = process.env.SHEET_ID;
const SHEET_TAB_NAME = process.env.SHEET_TAB_NAME || 'Müştəri';

// --- GOOGLE SHEETS LOGIN ---
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// --- GİRİŞ YOXLAMA ---
function checkAuth(req, res, next) {
  if (req.session.loggedIn) {
    return next();
  }
  const isApiRequest = req.path.startsWith('/api/') || req.path.startsWith('/customer/') || req.xhr;
  if (isApiRequest) {
    return res.status(401).json({ success: false, error: 'Sessiya bitib.' });
  }
  return res.redirect('/login');
}

// --- TARİX FUNKSİYALARI (TAM GENİŞ) ---

function parseTimestampParts(timestamp) {
  if (!timestamp) return null;
  const raw = timestamp.toString().trim();

  // Format: MM/DD/YYYY
  let match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (match) {
    const month = Number(match);
    const day = Number(match);
    const year = Number(match);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { year, month, day };
    }
  }

  // Format: YYYY-MM-DD
  match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) {
    const year = Number(match);
    const month = Number(match);
    const day = Number(match);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { year, month, day };
    }
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return { 
      year: parsed.getFullYear(), 
      month: parsed.getMonth() + 1, 
      day: parsed.getDate() 
    };
  }
  return null;
}

function formatDate(timestamp) {
  const parts = parseTimestampParts(timestamp);
  if (!parts) return 'Tarix yoxdur';
  const d = String(parts.day).padStart(2, '0');
  const m = String(parts.month).padStart(2, '0');
  return `${d}.${m}.${parts.year}`;
}

function dateToNumber(dateStr) {
  const parts = parseTimestampParts(dateStr);
  if (!parts) return 0;
  return parts.year * 10000 + parts.month * 100 + parts.day;
}

function inputDateToNumber(dateStr) {
  if (!dateStr) return null;
  try {
    const parts = dateStr.split('-');
    const year = Number(parts);
    const month = Number(parts);
    const day = Number(parts);
    return year * 10000 + month * 100 + day;
  } catch (e) {
    return null;
  }
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

// --- STATİSTİKA (MAY 2026-DAN BAŞLAYAN) ---

const AZ_MONTH_NAMES = [
  'Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'İyun',
  'İyul', 'Avqust', 'Sentyabr', 'Oktyabr', 'Noyabr', 'Dekabr'
];

function getMonthlyStats(customers) {
  const statsByMonth = new Map();
  const startYear = 2026;
  const startMonth = 5; // May
  
  const now = new Date();
  const currentTotalMonths = now.getFullYear() * 12 + (now.getMonth());
  const startTotalMonths = startYear * 12 + (startMonth - 1);
  
  let maxMonthIndex = Math.max(startTotalMonths, currentTotalMonths);

  for (const customer of customers) {
    if (isArchivedCustomer(customer)) continue;

    const parts = parseTimestampParts(customer?.['Timestamp']);
    if (!parts) continue;

    const currentIndex = parts.year * 12 + (parts.month - 1);
    if (currentIndex < startTotalMonths) continue;

    const key = `${parts.year}-${String(parts.month).padStart(2, '0')}`;
    const mStats = statsByMonth.get(key) || { total: 0, qosulma: 0, kocurme: 0 };
    
    // M Sütunu: Qeyd (Burada Qoşulma/Köçürmə yazılır)
    const qeyd = (customer['Qeyd'] || '').toLowerCase();

    mStats.total += 1;
    if (qeyd.includes('qoşulma')) {
      mStats.qosulma += 1;
    } else if (qeyd.includes('köçürmə') || qeyd.includes('kocurme')) {
      mStats.kocurme += 1;
    }

    statsByMonth.set(key, mStats);
    if (currentIndex > maxMonthIndex) maxMonthIndex = currentIndex;
  }

  const labels = [], total = [], qosulma = [], kocurme = [];

  for (let i = startTotalMonths; i <= maxMonthIndex; i++) {
    const year = Math.floor(i / 12);
    const month = (i % 12) + 1;
    const key = `${year}-${String(month).padStart(2, '0')}`;
    const data = statsByMonth.get(key) || { total: 0, qosulma: 0, kocurme: 0 };

    labels.push(`${AZ_MONTH_NAMES[month - 1]} ${year}`);
    total.push(data.total);
    qosulma.push(data.qosulma);
    kocurme.push(data.kocurme);
  }

  return { labels, total, qosulma, kocurme };
}

// --- DATA İDARƏETMƏ ---

async function getSheetData() {
  // P sütununa qədər (Nəticə) bütün datanı götürürük
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB_NAME}!A:P`,
  });
  
  const rows = response.data.values || [];
  if (rows.length === 0) return { headers: [], data: [] };
  
  const headers = rows;
  const data = rows.slice(1).reverse().map((row, idx) => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = row[i] || '';
    });
    obj.rowIndex = rows.length - idx;
    return obj;
  });
  
  return { headers, data };
}

function cleanSheetValue(val) {
  return val ? val.toString().replace(/^'/, '').trim() : '';
}

function normalizeDriveLinks(value) {
  if (!value) return '';
  return value.toString().split(/[\n,]+/).map(l => l.trim()).filter(Boolean).join(',');
}

function isArchivedCustomer(customer) {
  const val = customer?.['Arxiv'] || '';
  return val.trim().toLowerCase() === 'hə';
}

function isTodayCustomer(customer) {
  const parts = parseTimestampParts(customer?.['Timestamp']);
  if (!parts) return false;
  const now = new Date();
  return parts.day === now.getDate() && 
         parts.month === (now.getMonth() + 1) && 
         parts.year === now.getFullYear();
}

// --- ROUTES ---

app.get('/login', (req, res) => res.render('login', { error: null }));

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.loggedIn = true;
    return res.redirect('/');
  }
  res.render('login', { error: 'Giriş məlumatları səhvdir!' });
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// MÜŞTƏRİ ƏLAVƏ ET
app.get('/add', checkAuth, (req, res) => {
  res.render('add-customer', { success: null, error: null });
});

app.post('/add', checkAuth, async (req, res) => {
  try {
    const { odemeKodu, adSoyad, telefon, fin, seriya, modem, tvbox, komendant, unvan, qeyd, operationType, netice, ayliqOdenis } = req.body;
    const now = new Date();
    const ts = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()} ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;

    // A:TS, B:Kod, C:Ad, D:Tel, E:Seriya, F:FIN, G:Unvan, H:Modem, I:TvBox, J:Ayliq, K:Sifre, L:Komendant, M:Qeyd, N:Sekil, O:Arxiv, P:Natica
    const row = [
      ts, `'${odemeKodu}`, adSoyad, `'${telefon}`, seriya, fin, unvan, modem, tvbox, ayliqOdenis, 
      '', // K: Sifre boş
      komendant, 
      operationType || qeyd, // M: Qeyd
      normalizeDriveLinks(req.body.driveLinks), // N: Şəkil
      '', // O: Arxiv
      netice || '' // P: Nəticə
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB_NAME}!A:P`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [row] }
    });
    
    res.render('add-customer', { success: 'Müştəri bazaya yazıldı!', error: null });
  } catch (err) {
    res.render('add-customer', { success: null, error: err.message });
  }
});

// REDAKTƏ
app.get('/edit/:odemeKodu', checkAuth, async (req, res) => {
  try {
    const { data } = await getSheetData();
    const customer = data.find(c => cleanSheetValue(c['Ödəniş kodu']) === req.params.odemeKodu.trim());
    if (!customer) return res.redirect('/');
    
    customer.ayliqOdenis = customer['Aylıq ödəniş'] || '';
    res.render('edit-customer', { customer, success: req.query.success ? 'Yeniləndi' : null, error: null });
  } catch (e) {
    res.redirect('/');
  }
});

app.post('/edit/:odemeKodu', checkAuth, async (req, res) => {
  try {
    const { rowIndex, odemeKodu, adSoyad, telefon, fin, seriya, modem, tvbox, komendant, unvan, qeyd, operationType, netice, ayliqOdenis } = req.body;
    
    const row = [
      `'${odemeKodu}`, adSoyad, `'${telefon}`, seriya, fin, unvan, modem, tvbox, ayliqOdenis, 
      '', // K: Sifre
      komendant, 
      operationType || qeyd, // M: Qeyd
      normalizeDriveLinks(req.body.driveLinks), // N: Sekil
      '', // O: Arxiv
      netice || '' // P: Nəticə
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB_NAME}!B${rowIndex}:P${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [row] }
    });

    res.redirect(`/edit/${odemeKodu}?success=1`);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ANA SƏHİFƏ (DASHBOARD)
app.get('/', checkAuth, async (req, res) => {
  try {
    let { data } = await getSheetData();
    const totalCount = data.length;
    const stats = getMonthlyStats(data);
    
    const q = req.query.q ? req.query.q.trim().toLowerCase() : '';
    const startDate = req.query.startDate || '';
    const endDate = req.query.endDate || '';
    
    // Filtrləmə
    let filtered = data.filter(r => !isArchivedCustomer(r));
    
    if (q) {
      filtered = data.filter(c => {
        const code = cleanSheetValue(c['Ödəniş kodu']).toLowerCase();
        const name = (c['Ad, Soyad, Ata adı'] || '').toLowerCase();
        const tel = cleanSheetValue(c['Telefon nömrəsi']).toLowerCase();
        return code.includes(q) || name.includes(q) || tel.includes(q);
      });
    } else if (startDate || endDate) {
      filtered = filterByDateRange(data, startDate, endDate);
    }

    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const totalPages = Math.ceil(filtered.length / limit);
    const results = filtered.slice((page - 1) * limit, page * limit);

    res.render('dashboard', {
      results,
      totalResults: filtered.length,
      currentPage: page,
      totalPages,
      todayCustomers: data.filter(r => !isArchivedCustomer(r) && isTodayCustomer(r)),
      archivedCustomers: data.filter(isArchivedCustomer),
      totalCount,
      monthlyStats: stats,
      formatDate,
      q, startDate, endDate, errorMsg: null
    });

  } catch (err) {
    res.send("Sistem xətası: " + err.message);
  }
});

// ARXİV VƏ SİLMƏ APİ
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
  } catch (e) { res.json({ success: false }); }
});

app.post('/delete/:odemeKodu', checkAuth, async (req, res) => {
  try {
    const { rowIndex } = req.body;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      resource: { requests: [{ deleteDimension: { range: { sheetId: 0, dimension: 'ROWS', startIndex: rowIndex - 1, endIndex: rowIndex } } }] }
    });
    res.json({ success: true });
  } catch (err) { res.json({ success: false }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server port ${PORT}-da aktivdir.`));
