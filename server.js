require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const multer = require('multer');
const stream = require('stream');
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
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || '';

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDS),
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file'
  ],
});
const sheets = google.sheets({ version: 'v4', auth });
const drive = google.drive({ version: 'v3', auth });

const upload = multer({ storage: multer.memoryStorage() });

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

function getMonthlyStats(customers) {
  const stats = { total: {}, qosulma: {}, kocurme: {} };
  customers.forEach(c => {
    const num = dateToNumber(c['Timestamp']);
    if (num > 0) {
      const year = Math.floor(num / 10000);
      const month = Math.floor((num % 10000) / 100);
      const key = `${year}-${String(month).padStart(2, '0')}`;
      const qeyd = (c['Qeyd'] || '').toLowerCase();
      stats.total[key] = (stats.total[key] || 0) + 1;
      if (qeyd.includes('qoşulma')) {
        stats.qosulma[key] = (stats.qosulma[key] || 0) + 1;
      } else if (qeyd.includes('köçürmə') || qeyd.includes('kocurme')) {
        stats.kocurme[key] = (stats.kocurme[key] || 0) + 1;
      }
    }
  });
  const sorted = Object.keys(stats.total).sort().slice(-12);
  return {
    labels: sorted.map(k => { const [y, m] = k.split('-'); return `${m}/${y}`; }),
    total: sorted.map(k => stats.total[k] || 0),
    qosulma: sorted.map(k => stats.qosulma[k] || 0),
    kocurme: sorted.map(k => stats.kocurme[k] || 0)
  };
}

// DRIVE FUNKSİYALARI
async function uploadToDrive(file) {
  if (!file || !DRIVE_FOLDER_ID) return '';
  try {
    const bufferStream = new stream.PassThrough();
    bufferStream.end(file.buffer);
    const response = await drive.files.create({
      requestBody: { name: `${Date.now()}_${file.originalname}`, parents: [DRIVE_FOLDER_ID] },
      media: { mimeType: file.mimetype, body: bufferStream },
      fields: 'id'
    });
    const fileId = response.data.id;
    await drive.permissions.create({ fileId, requestBody: { role: 'reader', type: 'anyone' } });
    return `https://drive.google.com/uc?id=${fileId}`;
  } catch (err) { return ''; }
}

async function uploadMultipleToDrive(files) {
  if (!files || files.length === 0) return '';
  const urls = [];
  for (const file of files) {
    const url = await uploadToDrive(file);
    if (url) urls.push(url);
  }
  return urls.join(',');
}

// DATA GET
async function getSheetData() {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB_NAME}!A:O`,
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

// --- ROUTES ---

app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', (req, res) => {
  if (req.body.username === ADMIN_USER && req.body.password === ADMIN_PASS) {
    req.session.loggedIn = true;
    res.redirect('/');
  } else {
    res.render('login', { error: 'İstifadəçi adı və ya şifrə yanlışdır' });
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
    const customers = Array.isArray(data) ? data : [];
    const totalCustomers = customers.length;
    const totalPages = Math.max(1, Math.ceil(totalCustomers / limit));
    const currentPage = Math.min(page, totalPages);
    const start = (currentPage - 1) * limit;
    const paginatedCustomers = customers.slice(start, start + limit);

    res.json({
      success: true,
      customers: paginatedCustomers,
      data: paginatedCustomers,
      currentPage,
      totalPages,
      totalCustomers,
      limit,
      hasPrevPage: currentPage > 1,
      hasNextPage: currentPage < totalPages
    });
  } catch (err) {
    console.error('GET /api/all-customers failed:', err);
    res.status(500).json({ success: false, customers: [], totalPages: 1, totalCustomers: 0, error: err.message });
  }
});

// --- MÜŞTƏRİ ƏMƏLİYYATLARI ---

// ADD CUSTOMER
app.get('/add', checkAuth, (req, res) => res.render('add-customer', { success: null, error: null }));
app.post('/add', checkAuth, upload.array('muqavileSekli', 10), async (req, res) => {
  try {
    const { odemeKodu, adSoyad, telefon, fin, seriya, modem, tvbox, komendant, sifre, unvan, qeyd } = req.body;
    const ayliqOdenis = req.body.ayliqOdenis || req.body.aylıqOdenis || '';
    
    let imageUrl = await uploadMultipleToDrive(req.files);
    const now = new Date();
    const timestamp = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()} ${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')}`;

    const newRow = [
      timestamp, `'${odemeKodu}`, adSoyad, `'${telefon}`, seriya, fin, unvan, modem, tvbox, ayliqOdenis, sifre, komendant, qeyd, imageUrl, ''
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB_NAME}!A:O`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [newRow] }
    });
    res.render('add-customer', { success: 'Müştəri uğurla əlavə edildi!', error: null });
  } catch (err) { res.render('add-customer', { success: null, error: 'Xəta: ' + err.message }); }
});

// EDIT CUSTOMER (POST)
app.post('/edit/:odemeKodu', checkAuth, upload.array('muqavileSekli', 10), async (req, res) => {
  try {
    const { rowIndex, odemeKodu, adSoyad, telefon, fin, seriya, modem, tvbox, komendant, sifre, unvan, qeyd, oldImageUrl } = req.body;
    const ayliq = req.body.ayliqOdenis || req.body.aylıqOdenis || "";

    let imageUrl = oldImageUrl || '';
    if (req.files && req.files.length > 0) {
      const newUrls = await uploadMultipleToDrive(req.files);
      imageUrl = imageUrl ? `${imageUrl},${newUrls}` : newUrls;
    }

    const updatedRow = [
      `'${odemeKodu}`, // B
      adSoyad,         // C
      `'${telefon}`,   // D
      seriya,          // E
      fin,             // F
      unvan,           // G
      modem,           // H
      tvbox,           // I
      ayliq,           // J (Aylıq ödəniş)
      sifre,           // K
      komendant,       // L
      qeyd,            // M
      imageUrl         // N
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB_NAME}!B${rowIndex}:N${rowIndex}`,
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
  let monthlyStats = { labels: [], total: [], qosulma: [], kocurme: [] };
  let errorMsg = req.query.error || null;
  const q = req.query.q ? req.query.q.trim() : '';
  const startDate = req.query.startDate || '';
  const endDate = req.query.endDate || '';
  const page = parseInt(req.query.page) || 1;
  const limit = 10;

  try {
    let { data } = await getSheetData();
    totalCount = data.length;
    data = filterByDateRange(data, startDate, endDate);
    
    const activeData = data.filter(r => (r['Arxiv'] || '').toLowerCase() !== 'hə');
    archivedCustomers = data.filter(r => (r['Arxiv'] || '').toLowerCase() === 'hə');
    monthlyStats = getMonthlyStats(activeData);

    if (q) {
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
      const todayNum = dateToNumber(new Date().toLocaleDateString('en-US'));
      todayCustomers = activeData.filter(c => dateToNumber(c['Timestamp']) === todayNum);
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
    results: paginatedResults, q, startDate, endDate, errorMsg,
    totalResults, currentPage: page, totalPages, todayCustomers, archivedCustomers, totalCount, monthlyStats, formatDate
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server ${PORT}-da işləyir`));