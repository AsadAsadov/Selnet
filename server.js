require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
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

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});
const sheets = google.sheets({ version: 'v4', auth });

function checkAuth(req, res, next) {
  if (req.session.loggedIn) next();
  else res.redirect('/login');
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

// MÜŞTƏRİ DETALLARINI JSON KİMİ QAYTARIR - POPUP ÜÇÜN
app.get('/customer/:odemeKodu', checkAuth, async (req, res) => {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB_NAME}!A:N`,
    });
    const rows = response.data.values;
    const headers = rows[0];
    const data = rows.slice(1);
    const foundRow = data.find(row => row[1] && row[1].toString().trim() === req.params.odemeKodu);

    if (foundRow) {
      const result = headers.reduce((obj, header, i) => {
        obj[header] = foundRow[i] || '';
        return obj;
      }, {});
      res.json({ success: true, data: result });
    } else {
      res.json({ success: false });
    }
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/', checkAuth, async (req, res) => {
  let results = [];
  let errorMsg = null;
  const q = req.query.q? req.query.q.trim() : '';
  const page = parseInt(req.query.page) || 1;
  const limit = 10;

  if (q) {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_TAB_NAME}!A:N`,
      });
      const rows = response.data.values;
      if (!rows || rows.length === 0) {
        errorMsg = 'Sheet boşdur və ya oxuna bilmədi.';
      } else {
        const headers = rows[0];
        const data = rows.slice(1);
        const searchQuery = q.toLowerCase().replace(/\s/g, '');

        const filteredRows = data.filter(row => {
          const odemeKodu = row[1]? row[1].toString().toLowerCase().trim() : '';
          const telefon = row[3]? row[3].toString().toLowerCase().replace(/\s/g, '') : '';
          const unvan = row[6]? row[6].toString().toLowerCase() : '';
          const ad = row[2]? row[2].toString().toLowerCase() : '';

          return odemeKodu.includes(searchQuery) ||
                 telefon.includes(searchQuery) ||
                 unvan.includes(q.toLowerCase()) ||
                 ad.includes(q.toLowerCase());
        });

        results = filteredRows.map(row => headers.reduce((obj, header, i) => {
          obj[header] = row[i] || '';
          return obj;
        }, {}));
      }
    } catch (err) {
      console.log('Sheet xətası:', err.message);
      errorMsg = 'Server xətası. Sheet ID və ya icazələri yoxlayın.';
    }
  }

  // Səhifələmə
  const totalResults = results.length;
  const totalPages = Math.ceil(totalResults / limit);
  const paginatedResults = results.slice((page - 1) * limit, page * limit);

  res.render('dashboard', {
    results: paginatedResults,
    q,
    errorMsg,
    totalResults,
    currentPage: page,
    totalPages
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server ${PORT} portunda işləyir`));
