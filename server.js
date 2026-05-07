require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const multer = require('multer');
const stream = require('stream');
const app = express();

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 3600000 }
}));

const ADMIN_USER = 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS;
const SHEET_ID = process.env.SHEET_ID;
const SHEET_TAB_NAME = process.env.SHEET_TAB_NAME || 'Müştəri';
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;

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

// DÜZƏLDİLDİ: Timezone problemini həll edir
function parseSheetDate(dateStr) {
  if (!dateStr) return null;
  try {
    const datePart = dateStr.split(' ')[0];
    const [month, day, year] = datePart.split('/').map(Number);
    if (!month ||!day ||!year) return null;
    // UTC olaraq yaradırıq ki, server timezone-dan asılı olmasın
    return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  } catch {
    return null;
  }
}

function filterByDateRange(customers, startDate, endDate) {
  if (!startDate &&!endDate) return customers;

  // Input-dan gələn tarixləri UTC-ə çeviririk
  const start = startDate? new Date(startDate + 'T00:00:00Z') : null;
  const end = endDate? new Date(endDate + 'T23:59:59Z') : null;

  return customers.filter(c => {
    const custDate = parseSheetDate(c['Timestamp']);
    if (!custDate) return false;

    if (start && custDate < start) return false;
    if (end && custDate > end) return false;
    return true;
  });
}

function getMonthlyStats(customers) {
  const stats = { total: {}, qosulma: {}, kocurme: {} };
  customers.forEach(c => {
    const date = parseSheetDate(c['Timestamp']);
    if (date) {
      const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
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
  const formatLabel = k => {
    const [y, m] = k.split('-');
    return `${m}/${y}`;
  };
  return {
    labels: sorted.map(formatLabel),
    total: sorted.map(k => stats.total[k] || 0),
    qosulma: sorted.map(k => stats.qosulma[k] || 0),
    kocurme: sorted.map(k => stats.kocurme[k] || 0)
  };
}

async function uploadToDrive(file) {
  if (!file) return '';
  const bufferStream = new stream.PassThrough();
  bufferStream.end(file.buffer);

  const response = await drive.files.create({
    requestBody: {
      name: `${Date.now()}_${file.originalname}`,
      parents: [DRIVE_FOLDER_ID]
    },
    media: {
      mimeType: file.mimetype,
      body: bufferStream
    }
  });

  const fileId = response.data.id;
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' }
  });

  return `https://drive.google.com/uc?id=${fileId}`;
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

async function getSheetData() {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB_NAME}!A:N`,
  });
  const rows = response.data.values || [];
  if (rows.length === 0) return { headers: [], data: [] };
  const headers = rows[0];
  const data = rows.slice(1).reverse().map((row, idx) => {
    const obj = headers.reduce((o, h, i) => {
      o[h] = row[i] || '';
      return o;
    }, {});
    obj.rowIndex = rows.length - idx;
    return obj;
  });
  return { headers, data };
}

app.get('/login', (req, res) => res.render('login', { error: null }));

app.post('/login', (req, res) => {
  if (req.body.username === ADMIN_USER && req.body.password === ADMIN_PASS) {
    req.session.loggedIn = true;
    res.redirect('/');
  } else {
    res.render('login', { error: 'İstifadəçi adı və ya şifrə yanlışdır' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

app.get('/customer/:odemeKodu', checkAuth, async (req, res) => {
  try {
    const { data } = await getSheetData();
    const found = data.find(r => r['Ödəniş kodu'] && r['Ödəniş kodu'].toString().trim() === req.params.odemeKodu);
    res.json({ success:!!found, data: found || null });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/all-customers', checkAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const { data } = await getSheetData();
    const total = data.length;
    const paginated = data.slice((page - 1) * limit, page * limit);
    res.json({ success: true, customers: paginated, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/add', checkAuth, (req, res) => {
  res.render('add-customer', { success: null, error: null });
});

app.post('/add', checkAuth, upload.array('muqavileSekli', 10), async (req, res) => {
  try {
    const { odemeKodu, adSoyad, telefon, aylıqOdenis, fin, seriya, modem, tvbox, komendant, sifre, unvan, qeyd } = req.body;

    const { data } = await getSheetData();
    if (data.some(r => r['Ödəniş kodu'].toString().trim() === odemeKodu.trim())) {
      return res.render('add-customer', { success: null, error: 'Bu ödəniş kodu artıq mövcuddur!' });
    }

    let imageUrl = '';
    if (req.files && req.files.length > 0) {
      imageUrl = await uploadMultipleToDrive(req.files);
    }

    const now = new Date();
    const timestamp = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()} ${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;

    const newRow = [timestamp, odemeKodu, adSoyad, telefon, unvan, modem, tvbox, sifre, seriya, fin, komendant, qeyd, aylıqOdenis, imageUrl];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB_NAME}!A:N`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [newRow] }
    });

    res.render('add-customer', { success: 'Müştəri uğurla əlavə edildi!', error: null });
  } catch (err) {
    res.render('add-customer', { success: null, error: 'Xəta: ' + err.message });
  }
});

app.get('/edit/:odemeKodu', checkAuth, async (req, res) => {
  try {
    const { data } = await getSheetData();
    const customer = data.find(r => r['Ödəniş kodu'].toString().trim() === req.params.odemeKodu);
    if (!customer) return res.redirect('/');
    res.render('edit-customer', { customer, success: null, error: null });
  } catch (err) {
    res.redirect('/');
  }
});

app.post('/edit/:odemeKodu', checkAuth, upload.array('muqavileSekli', 10), async (req, res) => {
  try {
    const { odemeKodu, adSoyad, telefon, aylıqOdenis, fin, seriya, modem, tvbox, komendant, sifre, unvan, qeyd, rowIndex, oldImageUrl } = req.body;

    let imageUrl = oldImageUrl || '';
    if (req.files && req.files.length > 0) {
      const newUrls = await uploadMultipleToDrive(req.files);
      imageUrl = imageUrl? `${imageUrl},${newUrls}` : newUrls;
    }

    const updatedRow = [
      '',
      odemeKodu, adSoyad, telefon, unvan, modem, tvbox, sifre, seriya, fin, komendant, qeyd, aylıqOdenis, imageUrl
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB_NAME}!B${rowIndex}:N${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [updatedRow.slice(1)] }
    });

    const { data } = await getSheetData();
    const customer = data.find(r => r['Ödəniş kodu'].toString().trim() === odemeKodu);
    res.render('edit-customer', { customer, success: 'Məlumatlar yeniləndi!', error: null });
  } catch (err) {
    const { data } = await getSheetData();
    const customer = data.find(r => r['Ödəniş kodu'].toString().trim() === req.params.odemeKodu);
    res.render('edit-customer', { customer, success: null, error: 'Xəta: ' + err.message });
  }
});

app.post('/delete/:odemeKodu', checkAuth, async (req, res) => {
  try {
    const { rowIndex } = req.body;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      resource: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId: 0,
              dimension: 'ROWS',
              startIndex: rowIndex - 1,
              endIndex: rowIndex
            }
          }
        }]
      }
    });
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/', checkAuth, async (req, res) => {
  let results = [];
  let todayCustomers = [];
  let totalCount = 0;
  let monthlyStats = { labels: [], total: [], qosulma: [], kocurme: [] };
  let errorMsg = null;
  const q = req.query.q? req.query.q.trim() : '';
  const startDate = req.query.startDate || '';
  const endDate = req.query.endDate || '';
  const page = parseInt(req.query.page) || 1;
  const limit = 10;

  try {
    let { data } = await getSheetData();
    totalCount = data.length;
    data = filterByDateRange(data, startDate, endDate);
    monthlyStats = getMonthlyStats(data);

    if (q) {
      const searchQuery = q.toLowerCase().replace(/\s/g, '');
      results = data.filter(c => {
        const odemeKodu = c['Ödəniş kodu']? c['Ödəniş kodu'].toString().toLowerCase().trim() : '';
        const telefon = c['Telefon nömrəsi']? c['Telefon nömrəsi'].toString().toLowerCase().replace(/\s/g, '') : '';
        const unvan = c['Ünvan']? c['Ünvan'].toString().toLowerCase() : '';
        const ad = c['Ad, Soyad, Ata adı']? c['Ad, Soyad, Ata adı'].toString().toLowerCase() : '';
        return odemeKodu.includes(searchQuery) || telefon.includes(searchQuery) || unvan.includes(q.toLowerCase()) || ad.includes(q.toLowerCase());
      });
    } else {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      todayCustomers = data.filter(c => {
        const custDate = parseSheetDate(c['Timestamp']);
        return custDate >= today;
      });
    }
  } catch (err) {
    console.log('Sheet xətası:', err.message);
    errorMsg = 'Server xətası. Sheet ID və ya icazələri yoxlayın.';
  }

  const totalResults = results.length;
  const totalPages = Math.ceil(totalResults / limit);
  const paginatedResults = results.slice((page - 1) * limit, page * limit);

  res.render('dashboard', {
    results: paginatedResults, q, startDate, endDate, errorMsg,
    totalResults, currentPage: page, totalPages, todayCustomers, totalCount, monthlyStats
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server ${PORT} portunda işləyir`));