// advis0r's own WebMCP tools, on top of the @profullstack/webmcp embed in
// index.html (site_info, open_page, search_site). Each one calls the same JSON
// API the page already uses, with the visitor's cookies, so an AI agent in the
// browser gets the data instead of screen-scraping the SPA.

const getJson = async (path, init) => {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
};

const tools = [
  {
    name: 'lookup_ticker',
    description: 'Find a stock ticker by company name (e.g. "rivian" -> RIVN), and whether advis0r has a report for it.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Company name or ticker' },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['query'],
    },
    annotations: { readOnlyHint: true },
    execute: ({ query, limit = 5 }) =>
      getJson(`/api/lookup?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(limit)}`),
  },
  {
    name: 'get_report',
    description: 'The stored research report for one ticker: score, technicals, fundamentals, thesis and signals. Research aid, not financial advice.',
    inputSchema: {
      type: 'object',
      properties: { ticker: { type: 'string', description: 'Ticker symbol, e.g. NVDA' } },
      required: ['ticker'],
    },
    annotations: { readOnlyHint: true },
    execute: ({ ticker }) => getJson(`/api/ticker?symbol=${encodeURIComponent(ticker)}`),
  },
  {
    name: 'get_signals',
    description: 'What executives actually said about a ticker on earnings calls: extracted signals with quotes, dates and sources.',
    inputSchema: {
      type: 'object',
      properties: { ticker: { type: 'string', description: 'Ticker symbol, e.g. NVDA' } },
      required: ['ticker'],
    },
    annotations: { readOnlyHint: true },
    execute: ({ ticker }) => getJson(`/api/signals?ticker=${encodeURIComponent(ticker)}`),
  },
  {
    name: 'discover',
    description: 'Build a ranked watchlist of candidate tickers for a theme from the transcript index (deterministic scoring, no AI credits). Slow: it analyzes each candidate.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Theme, e.g. "AI datacenter power"; empty for the whole index' },
        horizon: { type: 'integer', enum: [1, 2], description: 'Horizon in quarters' },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      },
    },
    annotations: { readOnlyHint: true },
    execute: ({ topic, horizon = 2, limit = 10 }) => {
      const qs = new URLSearchParams({ horizon: String(horizon), limit: String(limit) });
      if (topic) qs.set('topic', topic);
      return getJson(`/api/discover?${qs}`);
    },
  },
  {
    name: 'add_to_watchlist',
    description: "Save a ticker to the signed-in visitor's watchlist.",
    inputSchema: {
      type: 'object',
      properties: { ticker: { type: 'string', description: 'Ticker symbol, e.g. NVDA' } },
      required: ['ticker'],
    },
    annotations: { readOnlyHint: false, consequentialHint: false },
    execute: ({ ticker }) =>
      getJson('/api/watchlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticker }),
      }),
  },
];

function register() {
  const api = globalThis.ProfullstackWebMCP;
  if (api?.supported) api.registerTools(tools);
}

// The embed may finish before or after this module runs.
if (globalThis.ProfullstackWebMCP?.unregisterAll) register();
else document.addEventListener('webmcp:ready', register, { once: true });
