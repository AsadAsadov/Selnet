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
const SHEET_TAB_NAME = process.env.SHEET_TAB_NAME || 'Müştəri'; // Sheet tab adını .env-dən oxu

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
        const data = rows.slice(1);

        // Ödəniş kodu = index 1, Telefon = index 3
        // includes() ilə axtar ki, nömrənin bir hissəsi ilə də tapsın
        const foundRow = data.find(row => 
          (row[1] && row[1].toString() === q) || 
          (row[3] && row[3].toString().replace(/\s/g, '').includes(q.replace(/\s/g, '')))
        );

        if (foundRow) {
          result = headers.reduce((obj, header, i) => {
            obj[header] = foundRow[i] || '';
            return obj;
          }, {});
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
