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
  secret: process.env.SESSION_SECRET || 'gizli-kaçar',
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
  scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file'],
});
const sheets = google.sheets({ version: 'v4', auth });
const drive = google.drive({ version: 'v3', auth });

const upload = multer({ storage: multer.memoryStorage() });

function checkAuth(req, res, next) {
  if (req.session.loggedIn) next();
  else res.redirect('/login');
}

// YARDIMÇI FUNKSİYALAR
async function uploadMultipleToDrive(files) {
  if (!files || files.length === 0) return '';
  const urls = [];
  for (const file of files) {
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
      urls.push(`https://drive.google.com/uc?id=${fileId}`);
    } catch (e) { console.error("Drive xətası:", e); }
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
    res.render('login', { error: 'Giriş rədd edildi!' });
  }
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// ADD CUSTOMER
app.post('/add', checkAuth, upload.array('muqavileSekli', 10), async (req, res) => {
  try {
    const { odemeKodu, adSoyad, telefon, fin, seriya, modem, tvbox, komendant, sifre, unvan, qeyd } = req.body;
    const ayliq = req.body.ayliqOdenis || req.body.aylıqOdenis || '';
    let imageUrl = await uploadMultipleToDrive(req.files);
    const now = new Date();
    const ts = `${now.getMonth()+1}/${now.getDate()}/${now.getFullYear()} ${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')}`;

    const newRow = [ts, `'${odemeKodu}`, adSoyad, `'${telefon}`, seriya, fin, unvan, modem, tvbox, ayliq, sifre, komendant, qeyd, imageUrl, ''];
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: `${SHEET_TAB_NAME}!A:O`,
      valueInputOption: 'USER_ENTERED', resource: { values: [newRow] }
    });
    res.redirect('/?msg=Ugurla-elave-edildi');
  } catch (err) { res.status(500).send(err.message); }
});

// EDIT CUSTOMER (POST) - SƏNİN ARDICILLIĞINLA TAM DÜZƏLDİLMİŞ HİSSƏ
app.post('/edit/:odemeKodu', checkAuth, upload.array('muqavileSekli', 10), async (req, res) => {
  try {
    const { odemeKodu, adSoyad, telefon, fin, seriya, modem, tvbox, komendant, sifre, unvan, qeyd, rowIndex, oldImageUrl } = req.body;
    
    // EJS-də inputun name-i nədirsə onu götürürük
    const ayliq = req.body.ayliqOdenis || req.body.aylıqOdenis || '';

    let imageUrl = oldImageUrl || '';
    if (req.files && req.files.length > 0) {
      const newUrls = await uploadMultipleToDrive(req.files);
      imageUrl = imageUrl ? `${imageUrl},${newUrls}` : newUrls;
    }

    // ARDICILLIQ (B-dən N-ə qədər tam 13 sütun):
    // B=odeme, C=ad, D=tel, E=seriya, F=fin, G=unvan, H=modem, I=tvbox, J=AYLIQ, K=sifre, L=komendant, M=qeyd, N=img
    const updatedRow = [
      `'${odemeKodu}`, // B
      adSoyad,         // C
      `'${telefon}`,   // D
      seriya,          // E
      fin,             // F
      unvan,           // G
      modem,           // H
      tvbox,           // I
      ayliq,           // J (Aylıq ödəniş burdadır!)
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

    res.redirect('/?msg=Yenilendi');
  } catch (err) { 
    console.error(err);
    res.status(500).send("Xəta baş verdi: " + err.message); 
  }
});

// GET EDIT PAGE
app.get('/edit/:odemeKodu', checkAuth, async (req, res) => {
  try {
    const { data } = await getSheetData();
    const customer = data.find(r => cleanSheetValue(r['Ödəniş kodu']) === req.params.odemeKodu.trim());
    if (!customer) return res.send("Müştəri tapılmadı");
    res.render('edit-customer', { customer, success: null, error: null });
  } catch (err) { res.status(500).send(err.message); }
});

// API & OTHER ROUTES
app.get('/customer/:odemeKodu', checkAuth, async (req, res) => {
  const { data } = await getSheetData();
  const found = data.find(r => cleanSheetValue(r['Ödəniş kodu']) === req.params.odemeKodu);
  res.json({ success: !!found, data: found || null });
});

app.get('/', checkAuth, async (req, res) => {
  try {
    const { data } = await getSheetData();
    const q = req.query.q ? req.query.q.trim().toLowerCase() : '';
    let results = data.filter(r => (r['Arxiv'] || '').toLowerCase() !== 'hə');
    
    if (q) {
      results = results.filter(c => 
        cleanSheetValue(c['Ödəniş kodu']).toLowerCase().includes(q) ||
        (c['Ad, Soyad, Ata adı'] || '').toLowerCase().includes(q)
      );
    }
    
    res.render('dashboard', {
      results: results.slice(0, 50),
      q: req.query.q || '',
      totalCount: data.length,
      todayCustomers: results.filter(r => r['Timestamp'] && r['Timestamp'].includes(new Date().toLocaleDateString())),
      errorMsg: null
    });
  } catch (err) { res.status(500).send(err.message); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server ${PORT}-da qaçır.`));