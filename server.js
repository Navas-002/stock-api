const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;
const FINNHUB_KEY = process.env.FINNHUB_KEY || '';
const BASE = 'https://finnhub.io/api/v1';
app.use(cors());
app.use(express.json());
async function finn(path) {
  const url = `${BASE}${path}&token=${FINNHUB_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Finnhub error: ${res.status}`);
  return res.json();
}
const cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.data);
  return fn().then(data => { cache.set(key, { data, expires: Date.now() + ttlMs }); return data; });
}
app.get('/', (req, res) => res.json({ status: 'ok' }));
app.get('/stock/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  try {
    const [quote, profile] = await Promise.all([
      cached(`quote:${ticker}`, 60000, () => finn(`/quote?symbol=${ticker}`)),
      cached(`profile:${ticker}`, 86400000, () => finn(`/stock/profile2?symbol=${ticker}`))
    ]);
    if (!quote.c) return res.status(404).json({ error: 'Not found' });
    res.json({ ticker, name: profile.name || ticker, price: quote.c, change: +(quote.c - quote.pc).toFixed(2), changePct: +(((quote.c - quote.pc) / quote.pc) * 100).toFixed(2), high: quote.h, low: quote.l, prevClose: quote.pc, marketCap: profile.marketCapitalization ? `$${(profile.marketCapitalization/1000).toFixed(2)}T` : null, sector: profile.finnhubIndustry || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/stock/:ticker/history', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const days = Math.min(parseInt(req.query.days) || 60, 365);
  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 86400;
  try {
    const data = await cached(`history:${ticker}:${days}`, 300000, () => finn(`/stock/candle?symbol=${ticker}&resolution=D&from=${from}&to=${to}`));
    if (data.s !== 'ok') return res.status(404).json({ error: 'No history' });
    res.json({ ticker, candles: data.t.map((ts, i) => ({ date: new Date(ts*1000).toLocaleDateString('en-US',{month:'short',day:'numeric'}), open: data.o[i], high: data.h[i], low: data.l[i], close: data.c[i], volume: data.v[i] })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/market/movers', async (req, res) => {
  const tickers = ['AAPL','TSLA','NVDA','AMZN','MSFT','GOOGL','META','AMD','NFLX','SPY'];
  try {
    const quotes = await Promise.all(tickers.map(t => cached(`quote:${t}`, 60000, () => finn(`/quote?symbol=${t}`)).then(q => ({ ticker: t, price: q.c, changePct: +(((q.c-q.pc)/q.pc)*100).toFixed(2) })).catch(() => null)));
    const valid = quotes.filter(Boolean).sort((a,b) => b.changePct - a.changePct);
    res.json({ gainers: valid.slice(0,3), losers: valid.slice(-3).reverse() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.listen(PORT, () => console.log(`Stock API running on port ${PORT}`));
