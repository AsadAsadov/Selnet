require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Supabase Bağlantısı
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('XƏTA: SUPABASE_URL və SUPABASE_ANON_KEY .env faylında müəyyən olunmalıdır');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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
    const custNum = dateToNumber(c.timestamp);
    if (custNum === 0) return false;
    if (startNum && custNum < startNum) return false;
    if (endNum && custNum > endNum) return false;
    return true;
  });
}

const MONTHLY_STATS_START_YEAR = 2026;
const MONTHLY_STATS_START_MONTH = 5;
const AZ_MONTH_NAMES = [
  'Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'İyun',
  'İyul', 'Avqust', 'Sentyabr', 'Oktyabr', 'Noyabr', 'Dekabr'
];

function monthIndex(year, month) {
  return year * 12 + (month - 1);
}

function monthKey(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function monthLabelFromKey(key) {
  const [year, month] = key.split('-').map(Number);
  return `${AZ_MONTH_NAMES[month - 1]} ${year}`;
}

function getCurrentMonthIndex() {
  const now = new Date();
  return monthIndex(now.getFullYear(), now.getMonth() + 1);
}

function getMonthlyStats(customers) {
  const startIndex = monthIndex(MONTHLY_STATS_START_YEAR, MONTHLY_STATS_START_MONTH);
  const statsByMonth = new Map();
  let maxMonthIndex = Math.max(startIndex, getCurrentMonthIndex());

  for (const customer of customers) {
    if (isArchivedCustomer(customer)) continue;

    const parts = parseTimestampParts(customer?.timestamp);
    if (!parts) continue;

    const currentIndex = monthIndex(parts.year, parts.month);
    if (currentIndex < startIndex) continue;

    const key = monthKey(parts.year, parts.month);
    const monthStats = statsByMonth.get(key) || { total: 0, qosulma: 0, kocurme: 0, problem: 0 };
    const qeyd = (customer.qeyd || '').toLowerCase();

    monthStats.total += 1;
    if (qeyd.includes('problem')) {
      monthStats.problem += 1;
    }
    if (qeyd.includes('qoşulma')) {
      monthStats.qosulma += 1;
    } else if (qeyd.includes('köçürmə') || qeyd.includes('kocurme')) {
      monthStats.kocurme += 1;
    }

    statsByMonth.set(key, monthStats);
    maxMonthIndex = Math.max(maxMonthIndex, currentIndex);
  }

  const labels = [];
  const total = [];
  const qosulma = [];
  const kocurme = [];
  const problem = [];

  for (let index = startIndex; index <= maxMonthIndex; index += 1) {
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    const key = monthKey(year, month);
    const monthStats = statsByMonth.get(key) || { total: 0, qosulma: 0, kocurme: 0, problem: 0 };

    labels.push(monthLabelFromKey(key));
    total.push(monthStats.total);
    qosulma.push(monthStats.qosulma);
    kocurme.push(monthStats.kocurme);
    problem.push(monthStats.problem);
  }

  return { labels, total, qosulma, kocurme, problem };
}

// DATA GET
async function getSheetData() {
  try {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .order('id', { ascending: false });
    
    if (error) {
      console.error('Supabase SELECT xətası:', error);
      throw new Error(error.message);
    }

    const customers = Array.isArray(data) ? data.filter(c => !isArchivedCustomer(c)) : [];
    return { headers: [], data: customers };
  } catch (err) {
    console.error('getSheetData failed:', err);
    throw err;
  }
}

function cleanSheetValue(val) {
  return val ? val.toString().replace(/^'/, '').trim() : '';
}

function normalizeDriveLinks(value) {
  return (value || '')
    .toString()
    .split(/[\n,]+/)
    .map(link => link.trim())
    .filter(Boolean)
    .join(',');
}

function parseArchiveValue(value) {
  if (typeof value === 'boolean') return value;
  const normalized = String(value ?? '').trim().toLowerCase();
  return ['hə', 'he', 'true', '1', 'bəli', 'yes'].includes(normalized);
}

function isArchivedCustomer(customer) {
  return parseArchiveValue(customer?.arxiv);
}

function isProblemCustomer(customer) {
  return String(customer?.qeyd || '').toLowerCase().includes('problem');
}

function isTodayCustomer(customer) {
  const today = new Date();
  const todayNum = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
  return dateToNumber(customer?.timestamp) === todayNum;
}

function paginateCustomers(customers, page, limit) {
  const totalCustomers = customers.length;
  const totalPages = Math.max(1, Math.ceil(totalCustomers / limit));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * limit;
  const paginatedCustomers = customers.slice(start, start + limit);

  return {
    customers: paginatedCustomers,
    data: paginatedCustomers,
    currentPage,
    totalPages,
    totalCustomers,
    limit,
    hasPrevPage: currentPage > 1,
    hasNextPage: currentPage < totalPages
  };
}

function sendCustomerList(res, customers, page, limit) {
  res.json({
    success: true,
    ...paginateCustomers(customers, page, limit)
  });
}

// --- ROUTES ---

app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', (req, res) => {
  if (req.body.username === ADMIN_USER && req.body.password === ADMIN_PASS) {
    req.session.loggedIn = true;
    res.redirect('/');
  } else {
    res.render('login', { error: 'İstifadəçi adı və ya parol yanlışdır' });
  }
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// --- API ROUTES ---

// Tək müştəri datası (JSON)
app.get('/customer/:odemeKodu', checkAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .eq('odeme_kodu', req.params.odemeKodu.trim())
      .single();
    
    if (error || !data) {
      return res.status(404).json({ success: false, data: null, error: 'Müştəri tapılmadı.' });
    }
    
    res.json({ success: true, data });
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
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .order('timestamp', { ascending: false });
    
    if (error) {
      throw new Error(error.message);
    }

    const customers = (Array.isArray(data) ? data : []).filter(c => !isArchivedCustomer(c));
    sendCustomerList(res, customers, page, limit);
  } catch (err) {
    console.error('GET /api/all-customers failed:', err);
    res.status(500).json({ success: false, customers: [], totalPages: 1, totalCustomers: 0, error: err.message });
  }
});

app.get('/api/today-customers', checkAuth, async (req, res) => {
  const page = parsePositiveInteger(req.query.page, 1);
  const limit = parsePositiveInteger(req.query.limit, 10, 100);

  try {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .order('timestamp', { ascending: false });
    
    if (error) {
      throw new Error(error.message);
    }

    const customers = (Array.isArray(data) ? data : []).filter(customer => !isArchivedCustomer(customer) && isTodayCustomer(customer));
    sendCustomerList(res, customers, page, limit);
  } catch (err) {
    console.error('GET /api/today-customers failed:', err);
    res.status(500).json({ success: false, customers: [], totalPages: 1, totalCustomers: 0, error: err.message });
  }
});

app.get('/api/archive-customers', checkAuth, async (req, res) => {
  const page = parsePositiveInteger(req.query.page, 1);
  const limit = parsePositiveInteger(req.query.limit, 10, 100);

  try {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .order('timestamp', { ascending: false });
    
    if (error) {
      throw new Error(error.message);
    }

    const customers = (Array.isArray(data) ? data : []).filter(isArchivedCustomer);
    sendCustomerList(res, customers, page, limit);
  } catch (err) {
    console.error('GET /api/archive-customers failed:', err);
    res.status(500).json({ success: false, customers: [], totalPages: 1, totalCustomers: 0, error: err.message });
  }
});

app.get('/api/problem-customers', checkAuth, async (req, res) => {
  const page = parsePositiveInteger(req.query.page, 1);
  const limit = parsePositiveInteger(req.query.limit, 10, 100);
  const solvedParam = req.query.solved;

  try {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .order('timestamp', { ascending: false });
    
    if (error) {
      throw new Error(error.message);
    }

    let customers = (Array.isArray(data) ? data : []).filter(c => !isArchivedCustomer(c) && isProblemCustomer(c));

    if (solvedParam === 'true') {
      customers = customers.filter(c => String(c.netice || '').trim() !== '');
    } else if (solvedParam === 'false') {
      customers = customers.filter(c => String(c.netice || '').trim() === '');
    }

    sendCustomerList(res, customers, page, limit);
  } catch (err) {
    console.error('GET /api/problem-customers failed:', err);
    res.status(500).json({ success: false, customers: [], totalPages: 1, totalCustomers: 0, error: err.message });
  }
});

// --- MÜŞTƏRİ ƏMƏLİYYATLARI ---

// ADD CUSTOMER
app.get('/add', checkAuth, (req, res) => res.render('add-customer', { success: null, error: null }));
app.post('/add', checkAuth, async (req, res) => {
  try {
    const odeme_kodu = req.body.odemeKodu || '';
    const ad_soyad = req.body.adSoyad || '';
    const telefon = req.body.telefon || '';
    const fin = req.body.fin || '';
    const seriya = req.body.seriya || '';
    const modem = req.body.modem || '';
    const tvbox = req.body.tvbox || '';
    const komendant = req.body.komendant || '';
    const unvan = req.body.unvan || '';
    const operationType = req.body.operationType || '';
    const qeyd = operationType || req.body.qeyd || '';
    const ayliq_odenis = req.body.ayliqOdenis || req.body.aylıqOdenis || '';
    const drive_links = normalizeDriveLinks(req.body.driveLinks);
    const netice = req.body.netice || '';
    const problem_sebebi = req.body.problemSebebi || '';
    const now = new Date();
    const timestamp = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()} ${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')}`;

    const { data, error } = await supabase
      .from('customers')
      .insert([{
        timestamp,
        odeme_kodu,
        ad_soyad,
        telefon,
        fin,
        seriya,
        unvan,
        modem,
        tvbox,
        ayliq_odenis,
        komendant,
        qeyd,
        drive_links,
        netice,
        problem_sebebi,
        arxiv: false
      }]);
    
    if (error) {
      throw new Error(error.message);
    }

    res.render('add-customer', { success: 'Müştəri uğurla əlavə edildi!', error: null });
  } catch (err) {
    console.error('POST /add failed:', err);
    res.render('add-customer', { success: null, error: 'Xəta: ' + err.message });
  }
});

// EDIT CUSTOMER (POST)
app.post('/edit/:odemeKodu', checkAuth, async (req, res) => {
  try {
    const id = req.body.customerId;
    const ad_soyad = req.body.adSoyad || '';
    const telefon = req.body.telefon || '';
    const fin = req.body.fin || '';
    const seriya = req.body.seriya || '';
    const modem = req.body.modem || '';
    const tvbox = req.body.tvbox || '';
    const komendant = req.body.komendant || '';
    const unvan = req.body.unvan || '';
    const qeyd = req.body.qeyd || '';
    const ayliq_odenis = req.body.ayliqOdenis || req.body.aylıqOdenis || '';
    const drive_links = normalizeDriveLinks(req.body.driveLinks);
    const netice = req.body.netice || '';
    const problem_sebebi = req.body.problemSebebi || '';

    let existingArxiv = '';
    try {
      const { data } = await supabase
        .from('customers')
        .select('arxiv')
        .eq('id', id)
        .single();
      existingArxiv = data ? (data.arxiv || '') : '';
    } catch (error) {
      existingArxiv = '';
    }

    const { error } = await supabase
      .from('customers')
      .update({
        ad_soyad,
        telefon,
        seriya,
        fin,
        unvan,
        modem,
        tvbox,
        ayliq_odenis,
        komendant,
        qeyd,
        drive_links,
        arxiv: existingArxiv,
        netice,
        problem_sebebi
      })
      .eq('id', id);
    
    if (error) {
      throw new Error(error.message);
    }

    res.redirect('/edit/' + req.params.odemeKodu + '?success=1');
  } catch (err) {
    console.error('POST /edit/:odemeKodu failed:', err);
    res.status(500).send("Xəta: " + err.message);
  }
});

app.get('/edit/:odemeKodu', checkAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .eq('odeme_kodu', req.params.odemeKodu.trim())
      .single();
    
    if (error || !data) {
      return res.redirect('/');
    }

    res.render('edit-customer', { customer: data, success: req.query.success ? 'Yeniləndi' : null, error: null });
  } catch (err) {
    console.error('GET /edit/:odemeKodu failed:', err);
    res.redirect('/');
  }
});

// DELETE & ARCHIVE
async function resolveCustomerByIdOrCode(rawIdentifier, odemeKodu = '') {
  const identifier = String(rawIdentifier ?? '').trim();
  const paymentCode = String(odemeKodu ?? '').trim();
  const canUseNumericId = /^\d+$/.test(identifier);
  const canUseUuidId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identifier);
  const canUseId = canUseNumericId || canUseUuidId;

  if (canUseId) {
    const { data, error } = await supabase
      .from('customers')
      .select('id, odeme_kodu')
      .eq('id', identifier)
      .maybeSingle();
    if (!error && data?.id !== undefined && data?.id !== null) return data;
  }

  if (paymentCode || identifier) {
    const lookupCode = paymentCode || identifier;
    const { data, error } = await supabase
      .from('customers')
      .select('id, odeme_kodu')
      .eq('odeme_kodu', lookupCode)
      .maybeSingle();
    if (!error && data?.id !== undefined && data?.id !== null) return data;
  }

  return null;
}

app.post('/delete/:id', checkAuth, async (req, res) => {
  try {
    const identifier = String(req.params.id ?? '').trim();
    const odemeKodu = String(req.body?.odemeKodu ?? '').trim();
    const target = await resolveCustomerByIdOrCode(identifier, odemeKodu);
    if (!target) {
      return res.status(404).json({ success: false, error: 'Silinəcək müştəri tapılmadı.' });
    }

    const { error } = await supabase
      .from('customers')
      .delete()
      .eq('id', target.id);
    
    if (error) {
      throw new Error(error.message);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('POST /delete/:id failed:', err);
    res.json({ success: false, error: err.message });
  }
});

app.post('/archive/:id', checkAuth, async (req, res) => {
  try {
    const identifier = String(req.params.id ?? '').trim();
    const odemeKodu = String(req.body?.odemeKodu ?? '').trim();
    const archive = req.body?.archive === true || String(req.body?.archive).trim().toLowerCase() === 'true';
    const target = await resolveCustomerByIdOrCode(identifier, odemeKodu);
    if (!target) {
      return res.status(404).json({ success: false, error: 'Arxiv üçün müştəri tapılmadı.' });
    }

    const { error } = await supabase
      .from('customers')
      .update({ arxiv: archive })
      .eq('id', target.id);
    
    if (error) {
      throw new Error(error.message);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('POST /archive/:id failed:', err);
    res.json({ success: false, error: err.message });
  }
});

// MAIN DASHBOARD
app.get('/', checkAuth, async (req, res) => {
  let results = [];
  let todayCustomers = [];
  let archivedCustomers = [];
  let totalCount = 0;
  let problemCount = 0;
  let monthlyStats = { labels: [], total: [], qosulma: [], kocurme: [] };
  let errorMsg = req.query.error || null;
  const q = req.query.q ? req.query.q.trim() : '';
  const startDate = req.query.startDate || '';
  const endDate = req.query.endDate || '';
  const status = req.query.status ? req.query.status.trim().toLowerCase() : '';
  const page = parseInt(req.query.page, 10) || 1;
  const limit = 10;

  try {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .order('timestamp', { ascending: false });
    
    if (error) {
      throw new Error(error.message);
    }

    let allData = Array.isArray(data) ? data : [];
    const activeDataAll = allData.filter(r => !isArchivedCustomer(r));
    totalCount = activeDataAll.length;
    problemCount = activeDataAll.filter(isProblemCustomer).length;
    monthlyStats = getMonthlyStats(allData);

    allData = filterByDateRange(allData, startDate, endDate);

    const activeData = allData.filter(r => !isArchivedCustomer(r));
    archivedCustomers = allData.filter(isArchivedCustomer);

    if (status === 'problem') {
      results = allData.filter(isProblemCustomer);
    } else if (q) {
      const sq = q.toLowerCase().replace(/\s/g, '');
      results = allData.filter(c => {
        const ok = (c.odeme_kodu || '').toLowerCase();
        const tel = (c.telefon || '').toLowerCase().replace(/\s/g, '');
        const ad = (c.ad_soyad || '').toLowerCase();
        return ok.includes(sq) || tel.includes(sq) || ad.includes(sq);
      });
    } else if (startDate || endDate) {
      results = allData;
    } else {
      todayCustomers = activeData.filter(isTodayCustomer);
      results = activeData;
    }
  } catch (err) {
    console.error('Dashboard error:', err);
    errorMsg = 'Xəta: ' + err.message;
  }

  const totalResults = results.length;
  const totalPages = Math.ceil(totalResults / limit);
  const paginatedResults = results.slice((page - 1) * limit, page * limit);

  res.render('dashboard', {
    results: paginatedResults,
    q,
    startDate,
    endDate,
    status,
    errorMsg,
    totalResults,
    currentPage: page,
    totalPages,
    todayCustomers,
    archivedCustomers,
    totalCount,
    problemCount,
    monthlyStats,
    formatDate
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server ${PORT}-da işləyir`));
