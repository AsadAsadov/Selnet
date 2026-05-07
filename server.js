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

// M/D/YYYY H:MM:SS formatını Date-ə çevirir
function parseDate(dateStr) {
  if (!dateStr) return null;
  try {
    const parts = dateStr.split(' ');
    const datePart = parts[0].split('/');
    const timePart = parts[1]? parts[1].split(':') : [0,0,0];
    return new Date(datePart[2], datePart[0] - 1, datePart[1], timePart[0], timePart[1], timePart[2]);
  } catch {
    return null;
  }
}

// Tarix aralığı filteri
function filterByDateRange(customers, startDate, endDate) {
  if (!startDate &&!endDate) return customers;
  return customers.filter(c => {
    const custDate = parseDate(c['Timestamp']);
    if (!custDate) return false;
    if (startDate && custDate < new Date(startDate)) return false;
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      if (custDate > end) return false;
    }
    return true;
  });
}

// Aylıq qrafik üçün data
function getMonthlyStats(customers) {
  const months = {};
  customers.forEach(c => {
    const date = parseDate(c['Timestamp']);
    if (date) {
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      months[key] = (months[key] || 0) + 1;
    }
  });
  // Son 12 ayı qaytar
  const sorted = Object.keys(months).sort().slice(-12);
  return {
    labels: sorted.map(k => {
      const [y, m] = k.split('-');
      return `${m}/${y}`;
    }),
    data: sorted.map(k => months[k])
  };
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
  let recentCustomers = [];
  let todayCustomers = [];
  let monthlyStats = { labels: [], data: [] };
  let errorMsg = null;
  const q = req.query.q? req.query.q.trim() : '';
  const startDate = req.query.startDate || '';
  const endDate = req.query.endDate || '';
  const page = parseInt(req.query.page) || 1;
  const limit = 10;

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
      const data = rows.slice(1).reverse();

      let allCustomers = data.map(row => headers.reduce((obj, header, i) => {
        obj[header] = row[i] || '';
        return obj;
      }, {}));

      // Tarix filteri tətbiq et
      allCustomers = filterByDateRange(allCustomers, startDate, endDate);
      monthlyStats = getMonthlyStats(allCustomers);

      if (q) {
        // AXTARIŞ
        const searchQuery = q.toLowerCase().replace(/\s/g, '');
        results = allCustomers.filter(c => {
          const odemeKodu = c['Ödəniş kodu']? c['Ödəniş kodu'].toString().toLowerCase().trim() : '';
          const telefon = c['Telefon nömrəsi']? c['Telefon nömrəsi'].toString().toLowerCase().replace(/\s/g, '') : '';
          const unvan = c['Ünvan']? c['Ünvan'].toString().toLowerCase() : '';
          const ad = c['Ad, Soyad, Ata adı']? c['Ad, Soyad, Ata adı'].toString().toLowerCase() : '';

          return odemeKodu.includes(searchQuery) ||
                 telefon.includes(searchQuery) ||
                 unvan.includes(q.toLowerCase()) ||
                 ad.includes(q.toLowerCase());
        });
      } else {
        // ANA SƏHİFƏ
        recentCustomers = allCustomers.slice(0, 10);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        todayCustomers = allCustomers.filter(c => {
          const custDate = parseDate(c['Timestamp']);
          return custDate >= today;
        });
      }
    }
  } catch (err) {
    console.log('Sheet xətası:', err.message);
    errorMsg = 'Server xətası. Sheet ID və ya icazələri yoxlayın.';
  }

  const totalResults = results.length;
  const totalPages = Math.ceil(totalResults / limit);
  const paginatedResults = results.slice((page - 1) * limit, page * limit);

  res.render('dashboard', {
    results: paginatedResults,
    q,
    startDate,
    endDate,
    errorMsg,
    totalResults,
    currentPage: page,
    totalPages,
    recentCustomers,
    todayCustomers,
    monthlyStats
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server ${PORT} portunda işləyir`));
