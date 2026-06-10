require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;
const FINNHUB_KEY = process.env.FINNHUB_KEY || '';
const POLYGON_KEY = process.env.POLYGON_KEY || '';
const GROQ_KEY = process.env.GROQ_KEY || '';
const FINNHUB = 'https://finnhub.io/api/v1';
const POLYGON = 'https://api.polygon.io';

// ── ALLOWED ORIGINS ───────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://stockiq-app.onrender.com',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
  'http://localhost:5500',
];

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (curl, Postman during dev)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.json({ limit: '10kb' })); // Limit body size

// ── SECURITY HEADERS ──────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.removeHeader('X-Powered-By');
  next();
});

// ── RATE LIMITER (no external dep) ───────────────────────
const rateLimitMap = new Map();
function rateLimit(maxReqs, windowMs) {
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const key = `${ip}:${req.path}`;
    const entry = rateLimitMap.get(key) || { count: 0, start: now };
    if (now - entry.start > windowMs) { entry.count = 0; entry.start = now; }
    entry.count++;
    rateLimitMap.set(key, entry);
    // Cleanup old entries every 5 min
    if (rateLimitMap.size > 5000) {
      for (const [k, v] of rateLimitMap) { if (now - v.start > windowMs) rateLimitMap.delete(k); }
    }
    if (entry.count > maxReqs) {
      return res.status(429).json({ error: 'Too many requests. Please slow down.' });
    }
    next();
  };
}

// Global: 100 requests per minute per IP
const globalLimit = rateLimit(100, 60_000);
// AI chat: 20 per minute (more expensive)
const aiLimit = rateLimit(20, 60_000);

app.use(globalLimit);

// ── INPUT SANITIZER ───────────────────────────────────────
function sanitizeTicker(ticker) {
  if (!ticker || typeof ticker !== 'string') return null;
  // Only allow alphanumeric, dots, hyphens — max 10 chars
  const clean = ticker.toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 10);
  return clean || null;
}

// ── CACHE ─────────────────────────────────────────────────
const cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.data);
  return fn().then(data => {
    cache.set(key, { data, expires: Date.now() + ttlMs });
    // Cap cache size
    if (cache.size > 1000) {
      const oldest = [...cache.entries()].sort((a,b) => a[1].expires - b[1].expires)[0];
      cache.delete(oldest[0]);
    }
    return data;
  });
}

async function finn(path) {
  const res = await fetch(`${FINNHUB}${path}&token=${FINNHUB_KEY}`);
  if (!res.ok) throw new Error(`Finnhub error: ${res.status}`);
  return res.json();
}
async function poly(path) {
  const res = await fetch(`${POLYGON}${path}?adjusted=true&sort=asc&limit=365&apiKey=${POLYGON_KEY}`);
  if (!res.ok) throw new Error(`Polygon error: ${res.status}`);
  return res.json();
}

// ── ROUTES ────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok' }));

app.get('/stock/:ticker', async (req, res) => {
  const ticker = sanitizeTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ error: 'Invalid ticker' });
  try {
    const [quote, profile, metrics] = await Promise.all([
      cached('quote:'+ticker, 60000, () => finn('/quote?symbol='+ticker)),
      cached('profile:'+ticker, 86400000, () => finn('/stock/profile2?symbol='+ticker)),
      cached('metrics:'+ticker, 86400000, () => finn('/stock/metric?symbol='+ticker+'&metric=all'))
    ]);
    if (!quote.c) return res.status(404).json({ error: 'Ticker not found' });
    const m = metrics.metric || {};
    res.json({
      ticker, name: profile.name||ticker,
      price: quote.c, change: +(quote.c-quote.pc).toFixed(2),
      changePct: +(((quote.c-quote.pc)/quote.pc)*100).toFixed(2),
      high: quote.h, low: quote.l, open: quote.o, prevClose: quote.pc,
      marketCap: profile.marketCapitalization ? `$${(profile.marketCapitalization/1000).toFixed(2)}T` : null,
      sector: profile.finnhubIndustry||null, exchange: profile.exchange||null,
      high52: m['52WeekHigh']||null, low52: m['52WeekLow']||null,
      beta: m.beta||null, pe: m.peBasicExclExtraTTM||null,
      eps: m.epsBasicExclExtraAnnual||null,
      revenueGrowth: m.revenueGrowthTTMYoy||null,
      profitMargin: m.netProfitMarginTTM||null,
      debtEquity: m.totalDebt_totalEquityAnnual||null,
      roe: m.roeRfy||null,
      dividend: m.dividendYieldIndicatedAnnual ? m.dividendYieldIndicatedAnnual.toFixed(2)+'%' : null,
      priceTarget: m['52WeekHigh'] ? `$${(m['52WeekHigh']*1.1).toFixed(2)}` : null,
    });
  } catch(err) { res.status(500).json({ error: 'Failed to fetch stock data' }); }
});

app.get('/stock/:ticker/history', async (req, res) => {
  const ticker = sanitizeTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ error: 'Invalid ticker' });
  const days = Math.min(Math.max(parseInt(req.query.days)||90, 1), 365);
  const to = new Date().toISOString().split('T')[0];
  const from = new Date(Date.now()-days*86400000).toISOString().split('T')[0];
  try {
    const data = await cached('history:'+ticker+':'+days, 300000,
      () => poly('/v2/aggs/ticker/'+ticker+'/range/1/day/'+from+'/'+to));
    if (!data.results?.length) return res.status(404).json({ error: 'No history found' });
    res.json({ ticker, candles: data.results.map(r => ({
      date: new Date(r.t).toLocaleDateString('en-US',{month:'short',day:'numeric'}),
      open:r.o, high:r.h, low:r.l, close:r.c, volume:r.v
    }))});
  } catch(err) { res.status(500).json({ error: 'Failed to fetch history' }); }
});

app.get('/stock/:ticker/news', async (req, res) => {
  const ticker = sanitizeTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ error: 'Invalid ticker' });
  const to = new Date().toISOString().split('T')[0];
  const from = new Date(Date.now()-7*86400000).toISOString().split('T')[0];
  try {
    const articles = await cached('news:'+ticker, 600000,
      () => finn('/company-news?symbol='+ticker+'&from='+from+'&to='+to));
    res.json({ ticker, articles: articles.slice(0,5).map(a => ({
      headline: String(a.headline||'').slice(0,300),
      source: String(a.source||'').slice(0,100),
      url: String(a.url||'').startsWith('http') ? a.url : '#',
      datetime: new Date(a.datetime*1000).toLocaleDateString()
    }))});
  } catch(err) { res.status(500).json({ error: 'Failed to fetch news' }); }
});

app.get('/market/movers', async (req, res) => {
  const tickers = ['AAPL','TSLA','NVDA','AMZN','MSFT','GOOGL','META','AMD','NFLX','SPY'];
  try {
    const quotes = await Promise.all(tickers.map(t =>
      cached('quote:'+t, 60000, () => finn('/quote?symbol='+t))
        .then(q => ({ ticker:t, price:q.c, changePct:+(((q.c-q.pc)/q.pc)*100).toFixed(2) }))
        .catch(()=>null)
    ));
    const valid = quotes.filter(Boolean).sort((a,b) => b.changePct-a.changePct);
    res.json({ gainers: valid.slice(0,3), losers: valid.slice(-3).reverse() });
  } catch(err) { res.status(500).json({ error: 'Failed to fetch movers' }); }
});

app.post('/ai/chat', aiLimit, async (req, res) => {
  const { messages, system } = req.body;
  if (!Array.isArray(messages) || messages.length > 20) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  // Sanitize messages
  const cleanMessages = messages.map(m => ({
    role: ['user','assistant'].includes(m.role) ? m.role : 'user',
    content: String(m.content||'').slice(0, 2000)
  }));
  const cleanSystem = String(system||'').slice(0, 1000);
  if (!GROQ_KEY) return res.status(500).json({ error: 'AI not configured' });
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        max_tokens: 512,
        messages: [{ role:'system', content: cleanSystem }, ...cleanMessages]
      })
    });
    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: 'AI error' });
    res.json({ text: data.choices?.[0]?.message?.content || '' });
  } catch(err) { res.status(500).json({ error: 'AI unavailable' }); }
});

// ── 404 & ERROR HANDLERS ──────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => console.log(`Syndicate API running on port ${PORT}`));
