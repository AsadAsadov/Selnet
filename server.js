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

// DÜZƏLDİLMİŞ: M/D/YYYY - 5/7/2026 = 7 May 2026
function parseSheetDate(dateStr) {
  if (!dateStr) return null;
  try {
    const datePart = dateStr.split(' ')[0];
    const [month, day, year] = datePart.split('/').map(Number);
    if (!month ||!day ||!year) return null;
    return new Date(year, month - 1, day);
  } catch {
    return null;
  }
}

function filterByDateRange(customers, startDate, endDate) {
  if (!startDate &&!endDate) return customers;
  const start = startDate? new Date(startDate + 'T00:00:00') : null;
  const end = endDate? new Date(endDate + 'T23:59:59') : null;

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
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
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

app.get('/api/all-customers', checkAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB_NAME}!A:N`,
    });
    const rows = response.data.values;
    const headers = rows[0];
    const data = rows.slice(1).reverse();

    const allCustomers = data.map(row => headers.reduce((obj, header, i) => {
      obj[header] = row[i] || '';
      return obj;
    }, {}));

    const total = allCustomers.length;
    const paginated = allCustomers.slice((page - 1) * limit, page * limit);

    res.json({
      success: true,
      customers: paginated,
      total,
      page,
      totalPages: Math.ceil(total / limit)
    });
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

      totalCount = allCustomers.length;
      allCustomers = filterByDateRange(allCustomers, startDate, endDate);
      monthlyStats = getMonthlyStats(allCustomers);

      if (q) {
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
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        todayCustomers = allCustomers.filter(c => {
          const custDate = parseSheetDate(c['Timestamp']);
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
    todayCustomers,
    totalCount,
    monthlyStats
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server ${PORT} portunda işləyir`));