require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const app = express();

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
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

app.get('/', checkAuth, async (req, res) => {
  let result = null;
  let errorMsg = null;
  const q = req.query.q ? req.query.q.trim() : '';

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
        console.log('===== SHEET BAŞLIQLARI =====');
        console.log(JSON.stringify(headers)); // DƏQİQ ADLARI GÖRƏCƏYİK
        console.log('===========================');
        const data = rows.slice(1);

        // Şəkilə görə: Ödəniş kodu = 1, Telefon = 2
        const foundRow = data.find(row => {
          const odemeKodu = row[1] ? row[1].toString().trim() : '';
          const telefon = row[2] ? row[2].toString().replace(/\s/g, '') : '';
          const searchQuery = q.replace(/\s/g, '');
          return odemeKodu === q || telefon.includes(searchQuery);
        });

        if (foundRow) {
          result = headers.reduce((obj, header, i) => {
            obj[header] = foundRow[i] || '';
            return obj;
          }, {});
          console.log('===== TAPILAN MÜŞTƏRİ OBYEKTİ =====');
          console.log(JSON.stringify(result));
          console.log('=================================');
        }
      }
    } catch (err) {
      console.log('Sheet xətası:', err.message);
      errorMsg = 'Server xətası. Sheet ID və ya icazələri yoxlayın.';
    }
  }
  res.render('dashboard', { result, q, errorMsg });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server ${PORT} portunda işləyir`));
