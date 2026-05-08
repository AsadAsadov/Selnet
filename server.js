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
  if (req.session.loggedIn) next();
  else res.redirect('/login');
}

// TARİX VƏ STATİSTİKA FUNKSİYALARI
function dateToNumber(dateStr) {
  if (!dateStr) return 0;
  try {
    const datePart = dateStr.split(' ')[0];
    const [month, day, year] = datePart.split('/').map(Number);
    if (!month || !day || !year) return 0;
    return year * 10000 + month * 100 + day;
  } catch { return 0; }
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
    const found = data.find(r => cleanSheetValue(r['Ödəniş kodu']) === req.params.odemeKodu);
    res.json({ success: !!found, data: found || null });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// Bütün müştəriləri JSON olaraq qaytaran yeni route (DASHBOARD ÜÇÜN)
app.get('/api/all-customers', checkAuth, async (req, res) => {
  try {
    const { data } = await getSheetData();
    res.json({ success: true, data: data });
  } catch (err) {
    res.json({ success: false, error: err.message });
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
    totalResults, currentPage: page, totalPages, todayCustomers, archivedCustomers, totalCount, monthlyStats
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server ${PORT}-da işləyir`));