require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;
const FINNHUB_KEY = process.env.FINNHUB_KEY || '';
const POLYGON_KEY = process.env.POLYGON_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || '';
const FINNHUB = 'https://finnhub.io/api/v1';
const POLYGON = 'https://api.polygon.io';

app.use(cors());
app.use(express.json());

const cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.data);
  return fn().then(data => { cache.set(key, { data, expires: Date.now() + ttlMs }); return data; });
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

app.get('/', (req, res) => res.json({ status: 'ok', message: 'StockIQ API running' }));

app.get('/stock/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  try {
    const [quote, profile, metrics] = await Promise.all([
      cached('quote:'+ticker, 60000, () => finn('/quote?symbol='+ticker)),
      cached('profile:'+ticker, 86400000, () => finn('/stock/profile2?symbol='+ticker)),
      cached('metrics:'+ticker, 86400000, () => finn('/stock/metric?symbol='+ticker+'&metric=all'))
    ]);
    if (!quote.c) return res.status(404).json({ error: 'Not found' });
    const m = metrics.metric || {};
    res.json({
      ticker, name: profile.name||ticker,
      price: quote.c, change: +(quote.c-quote.pc).toFixed(2),
      changePct: +(((quote.c-quote.pc)/quote.pc)*100).toFixed(2),
      high: quote.h, low: quote.l, open: quote.o, prevClose: quote.pc,
      marketCap: profile.marketCapitalization ? `$${(profile.marketCapitalization/1000).toFixed(2)}T` : null,
      sector: profile.finnhubIndustry||null, exchange: profile.exchange||null, logo: profile.logo||null,
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
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/stock/:ticker/history', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const days = Math.min(parseInt(req.query.days)||90, 365);
  const to = new Date().toISOString().split('T')[0];
  const from = new Date(Date.now()-days*86400000).toISOString().split('T')[0];
  try {
    const data = await cached('history:'+ticker+':'+days, 300000,
      () => poly('/v2/aggs/ticker/'+ticker+'/range/1/day/'+from+'/'+to));
    if (!data.results||!data.results.length) return res.status(404).json({ error: 'No history' });
    res.json({ ticker, candles: data.results.map(r => ({
      date: new Date(r.t).toLocaleDateString('en-US',{month:'short',day:'numeric'}),
      open:r.o, high:r.h, low:r.l, close:r.c, volume:r.v
    }))});
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/stock/:ticker/news', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const to = new Date().toISOString().split('T')[0];
  const from = new Date(Date.now()-7*86400000).toISOString().split('T')[0];
  try {
    const articles = await cached('news:'+ticker, 600000,
      () => finn('/company-news?symbol='+ticker+'&from='+from+'&to='+to));
    res.json({ ticker, articles: articles.slice(0,5).map(a => ({
      headline:a.headline, source:a.source, url:a.url,
      datetime: new Date(a.datetime*1000).toLocaleDateString()
    }))});
  } catch(err) { res.status(500).json({ error: err.message }); }
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
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── AI CHAT ENDPOINT ─────────────────────────────────────
app.post('/ai/chat', async (req, res) => {
  const { messages, system } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }
  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_KEY not set' });
  }
  try {
    console.log('AI chat request, messages:', messages.length);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system: system || 'You are a friendly financial coach for teenagers learning to invest.',
        messages
      })
    });
    const data = await response.json();
    console.log('Anthropic response status:', response.status);
    if (!response.ok) {
      console.error('Anthropic error:', JSON.stringify(data));
      return res.status(500).json({ error: data.error?.message || 'AI error', detail: data });
    }
    const text = data.content?.map(c => c.text||'').join('') || '';
    res.json({ text });
  } catch(err) {
    console.error('AI chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log('StockIQ API running on port '+PORT));
