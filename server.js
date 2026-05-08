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
  secret: process.env.SESSION_SECRET,
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

function dateToNumber(dateStr) {
  if (!dateStr) return 0;
  try {
    const datePart = dateStr.split(' ')[0];
    const [month, day, year] = datePart.split('/').map(Number);
    return year * 10000 + month * 100 + day;
  } catch { return 0; }
}

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

async function getSheetData() {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB_NAME}!A:O`,
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

function cleanSheetValue(val) {
  return val ? val.toString().replace(/^'/, '').trim() : '';
}

// LOGIN & LOGOUT ROUTES
app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', (req, res) => {
  if (req.body.username === ADMIN_USER && req.body.password === ADMIN_PASS) {
    req.session.loggedIn = true;
    res.redirect('/');
  } else {
    res.render('login', { error: 'Yanlış şifrə!' });
  }
});
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// GET CUSTOMER FOR MODAL
app.get('/customer/:odemeKodu', checkAuth, async (req, res) => {
  try {
    const { data } = await getSheetData();
    const found = data.find(r => cleanSheetValue(r['Ödəniş kodu']) === req.params.odemeKodu);
    res.json({ success: !!found, data: found || null });
  } catch (err) { res.json({ success: false }); }
});

// ADD CUSTOMER
app.post('/add', checkAuth, upload.array('muqavileSekli', 10), async (req, res) => {
  try {
    const { odemeKodu, adSoyad, telefon, fin, seriya, modem, tvbox, komendant, sifre, unvan, qeyd } = req.body;
    const ayliqOdenis = req.body.ayliqOdenis || req.body.aylıqOdenis || '';
    
    let imageUrl = '';
    if (req.files && req.files.length > 0) imageUrl = await uploadMultipleToDrive(req.files);
    
    const now = new Date();
    const timestamp = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()} ${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')}`;

    // Sənin verdiyin A-O ardıcıllığı
    const newRow = [
      timestamp,      // A: Timestamp
      `'${odemeKodu}`,// B: Ödəniş kodu
      adSoyad,        // C: Ad, Soyad...
      `'${telefon}`,  // D: Telefon
      seriya,         // E: Seriya
      fin,            // F: Fin
      unvan,          // G: Ünvan
      modem,          // H: Modem S/N
      tvbox,          // I: Tv Box
      ayliqOdenis,    // J: Aylıq ödəniş
      sifre,          // K: Şifrə
      komendant,      // L: Komendant
      qeyd,           // M: Qeyd
      imageUrl,       // N: Şəkillər
      ''              // O: Arxiv
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB_NAME}!A:O`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [newRow] }
    });
    res.render('add-customer', { success: 'Müştəri əlavə edildi!', error: null });
  } catch (err) { res.render('add-customer', { success: null, error: err.message }); }
});

// EDIT CUSTOMER (GET)
app.get('/edit/:odemeKodu', checkAuth, async (req, res) => {
  try {
    const { data } = await getSheetData();
    const customer = data.find(r => cleanSheetValue(r['Ödəniş kodu']) === req.params.odemeKodu.trim());
    if (!customer) return res.redirect('/');
    res.render('edit-customer', { customer, success: null, error: null });
  } catch (err) { res.redirect('/'); }
});

// EDIT CUSTOMER (POST) - ƏSAS DÜZƏLİŞ BURADADIR
app.post('/edit/:odemeKodu', checkAuth, upload.array('muqavileSekli', 10), async (req, res) => {
  try {
    const { odemeKodu, adSoyad, telefon, fin, seriya, modem, tvbox, komendant, sifre, unvan, qeyd, rowIndex, oldImageUrl } = req.body;
    const ayliqOdenis = req.body.ayliqOdenis || req.body.aylıqOdenis || '';

    let imageUrl = oldImageUrl || '';
    if (req.files && req.files.length > 0) {
      const newUrls = await uploadMultipleToDrive(req.files);
      imageUrl = imageUrl ? `${imageUrl},${newUrls}` : newUrls;
    }

    // ARDICILLIQ (B-dən N-ə qədər):
    // B=0, C=1, D=2, E=3, F=4, G=5, H=6, I=7, J=8, K=9, L=10, M=11, N=12
    const updatedRow = [
      `'${odemeKodu}`, // B (Sütun 2)
      adSoyad,        // C
      `'${telefon}`,  // D
      seriya,         // E
      fin,            // F
      unvan,          // G
      modem,          // H
      tvbox,          // I
      ayliqOdenis,    // J (Sütun 10 - Aylıq ödəniş)
      sifre,          // K
      komendant,      // L
      qeyd,           // M
      imageUrl        // N (Sütun 14)
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB_NAME}!B${rowIndex}:N${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [updatedRow] }
    });

    res.redirect('/edit/' + odemeKodu + '?success=1');
  } catch (err) { res.redirect('/?error=' + err.message); }
});

// ARCHIVE & DELETE
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
  } catch (err) { res.json({ success: false }); }
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

// DASHBOARD
app.get('/', checkAuth, async (req, res) => {
  let results = [];
  const q = req.query.q ? req.query.q.trim().toLowerCase() : '';
  const page = parseInt(req.query.page) || 1;
  const limit = 10;

  try {
    let { data } = await getSheetData();
    const activeData = data.filter(r => (r['Arxiv'] || '').toLowerCase() !== 'hə');
    
    if (q) {
      results = activeData.filter(c => 
        cleanSheetValue(c['Ödəniş kodu']).toLowerCase().includes(q) ||
        (c['Ad, Soyad, Ata adı'] || '').toLowerCase().includes(q)
      );
    } else {
      results = activeData;
    }

    const totalResults = results.length;
    const paginatedResults = results.slice((page - 1) * limit, page * limit);

    res.render('dashboard', {
      results: paginatedResults, q, currentPage: page,
      totalPages: Math.ceil(totalResults / limit),
      totalCount: data.length,
      todayCustomers: activeData.filter(c => dateToNumber(c['Timestamp']) === dateToNumber(new Date().toLocaleDateString('en-US'))),
      errorMsg: req.query.error || null
    });
  } catch (err) { res.render('dashboard', { results: [], q: '', totalCount: 0 }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server ${PORT} portunda aktivdir.`));