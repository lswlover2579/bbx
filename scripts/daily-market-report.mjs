import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
const EM_QUOTE = 'https://push2.eastmoney.com';
const EM_HIS = 'https://push2his.eastmoney.com';
const EASTMONEY_UT = 'fa5fd1943c7b386f172d6893dbfba10b';
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || 'false');
const SHOW_PREVIEW = process.argv.includes('--show-preview');
const KLINE_CACHE = new Map();

function extractConstArray(name) {
  const match = HTML.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\n\\];`));
  if (!match) throw new Error(`index.html 中找不到 ${name}`);
  return match[1];
}

function extractDefaultState() {
  const match = HTML.match(/const DEFAULT_STATE\s*=\s*\{([\s\S]*?)\n\};/);
  if (!match) throw new Error('index.html 中找不到 DEFAULT_STATE');
  return match[1];
}

const defaultState = extractDefaultState();
function readStringSetting(key) {
  const match = new RegExp(`\\b${key}\\s*:\\s*"([^"]*)"`).exec(defaultState);
  if (!match) throw new Error(`无法读取默认设置 ${key}`);
  return match[1];
}
function readNumberSetting(key) {
  const match = new RegExp(`\\b${key}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`).exec(defaultState);
  if (!match) throw new Error(`无法读取默认设置 ${key}`);
  return Number(match[1]);
}

const fixedSlotsBlock = extractConstArray('FIXED_SLOTS');
const STOCKS = Array.from(
  fixedSlotsBlock.matchAll(/\{\s*code:\s*"(\d{6})"\s*,\s*name:\s*"([^"]*)"\s*\}/g),
  match => ({ code: match[1], name: match[2] })
);
if (!STOCKS.length) throw new Error('无法从 FIXED_SLOTS 读取监控名单');

const indexSecid = readStringSetting('indexSecid');
const indexName = readStringSetting('indexName');
const extraIndexBlock = extractConstArray('EXTRA_MARKET_INDICES');
const EXTRA_INDICES = Array.from(
  extraIndexBlock.matchAll(/\{\s*secid:\s*"([^"]+)"\s*,\s*name:\s*"([^"]+)"\s*\}/g),
  match => ({ secid: match[1], name: match[2] })
);
const SETTINGS = {
  mode: readStringSetting('mode'),
  timeframe: readStringSetting('timeframe'),
  threshold: readNumberSetting('threshold'),
  volMult: readNumberSetting('volMult'),
  breakPct: readNumberSetting('breakPct')
};
const INDICES = [{ secid: indexSecid, name: indexName }, ...EXTRA_INDICES];
const ASSETS = [
  ...INDICES.map(item => ({ ...item, kind: '指数', code: item.secid.split('.')[1] })),
  ...STOCKS.map(item => ({
    ...item,
    kind: '自选',
    secid: toSecid(item.code)
  }))
];

function toSecid(code) {
  const isShanghai = /^(60|68|11|50|51|58|90)/.test(String(code));
  return `${isShanghai ? '1.' : '0.'}${code}`;
}

function chinaDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const part = type => parts.find(item => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getJson(url, attempts = 3) {
  let lastStatus = 'network error';
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AShareMonitor/1.0)',
          'Referer': 'https://quote.eastmoney.com/'
        },
        signal: AbortSignal.timeout(15000),
        cache: 'no-store'
      });
      if (!response.ok) {
        lastStatus = `HTTP ${response.status}`;
        throw new Error(lastStatus);
      }
      const data = await response.json();
      if (!data || !data.data) {
        lastStatus = 'empty response';
        throw new Error(lastStatus);
      }
      return data;
    } catch (error) {
      if (error?.message?.startsWith('HTTP ')) lastStatus = error.message;
      else lastStatus = error?.cause?.code || error?.name || 'network error';
      if (i + 1 < attempts) await sleep(500 * (i + 1));
    }
  }
  throw new Error(`行情源请求失败（${lastStatus}）`);
}

function buildUrl(host, path, params) {
  const url = new URL(path, host);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.toString();
}

async function fetchKline(secid, klt = 101, lmt = 300) {
  const url = buildUrl(EM_HIS, '/api/qt/stock/kline/get', {
    secid,
    ut: EASTMONEY_UT,
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56,f57',
    klt,
    fqt: 1,
    end: '20500101',
    lmt
  });
  const json = await getJson(url);
  const lines = json?.data?.klines;
  if (!Array.isArray(lines) || !lines.length) throw new Error('K线数据不可用');
  return lines.map(line => {
    const fields = line.split(',');
    return {
      date: fields[0],
      open: Number(fields[1]),
      close: Number(fields[2]),
      volume: Number(fields[5]),
      amount: Number(fields[6])
    };
  }).filter(item => Number.isFinite(item.close) && item.close > 0);
}

function fetchKlineCached(secid, klt = 101, lmt = 300) {
  const key = `${secid}|${klt}|${lmt}`;
  if (!KLINE_CACHE.has(key)) KLINE_CACHE.set(key, fetchKline(secid, klt, lmt));
  return KLINE_CACHE.get(key);
}

function parseNumber(value) {
  if (value === '-' || value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function quoteRows(json) {
  const diff = json?.data?.diff || [];
  return Array.isArray(diff) ? diff : Object.values(diff);
}

async function fetchQuotes(secids) {
  const url = buildUrl(EM_QUOTE, '/api/qt/ulist.np/get', {
    fltt: 2,
    invt: 2,
    secids: secids.join(','),
    fields: 'f1,f2,f3,f4,f12,f13,f14,f104,f105,f106'
  });
  const json = await getJson(url);
  const quotes = {};
  for (const item of quoteRows(json)) {
    const secid = `${item.f13}.${item.f12}`;
    quotes[secid] = {
      secid,
      code: String(item.f12),
      name: String(item.f14 || ''),
      price: parseNumber(item.f2),
      pct: parseNumber(item.f3)
    };
  }
  return quotes;
}

async function fetchMarket() {
  const secids = ['1.000001', '0.399001', '0.899050'];
  const url = buildUrl(EM_QUOTE, '/api/qt/ulist.np/get', {
    fltt: 2,
    invt: 2,
    secids: secids.join(','),
    fields: 'f2,f3,f4,f6,f12,f13,f14,f104,f105,f106'
  });
  const json = await getJson(url);
  let up = 0, down = 0, flat = 0, amount = 0, validMarkets = 0;
  for (const item of quoteRows(json)) {
    const u = parseNumber(item.f104);
    const d = parseNumber(item.f105);
    const f = parseNumber(item.f106);
    const a = parseNumber(item.f6);
    if (u !== null && d !== null) {
      up += u;
      down += d;
      flat += f || 0;
      validMarkets++;
    }
    if (a !== null) amount += a;
  }
  if (!validMarkets) throw new Error('全市场涨跌家数不可用');
  return { up, down, flat, total: up + down + flat, amount };
}

const BBI_PERIODS = [3, 6, 12, 24];
function calcBBI(kline, index) {
  let sum = 0;
  for (const period of BBI_PERIODS) {
    if (index - period + 1 < 0) return null;
    let subtotal = 0;
    for (let i = index - period + 1; i <= index; i++) subtotal += kline[i].close;
    sum += subtotal / period;
  }
  return sum / BBI_PERIODS.length;
}

// Mirrors the page's current-bar BBI/MA20 checks; only a full current-bar trigger is reported.
function analyzeCurrentBar(kline, options) {
  const n = kline.length;
  if (n < 30) return { error: 'K线不足（需≥30根）' };

  const bbi = Array.from({ length: n }, (_, i) => calcBBI(kline, i));
  const ma20 = Array(n).fill(null);
  for (let i = 19; i < n; i++) {
    let sum = 0;
    for (let j = i - 19; j <= i; j++) sum += kline[j].close;
    ma20[i] = sum / 20;
  }
  if (!bbi[n - 1]) return { error: '红队计算失败' };
  if (!ma20[n - 1]) return { error: 'K线不足（蓝队需≥20根）' };

  function volumeRatioAt(i) {
    let sum = 0, count = 0;
    for (let j = Math.max(0, i - 5); j < i; j++) {
      sum += kline[j].volume;
      count++;
    }
    const average = count ? sum / count : 0;
    return average > 0 ? kline[i].volume / average : null;
  }

  function belowCountBefore(i) {
    let count = 0;
    for (let j = i - 1; j >= 0; j--) {
      if (bbi[j] === null) break;
      if (kline[j].close < bbi[j]) count++;
      else break;
    }
    return count;
  }

  const i = n - 1;
  const checks = [];
  const close = kline[i].close;
  const previousClose = kline[i - 1].close;
  const currentBbi = bbi[i];
  const currentMa20 = ma20[i];
  const volumeRatio = volumeRatioAt(i);
  const deviationPct = (close / currentBbi - 1) * 100;
  const skipVolume = options.timeframe === 'month';

  if (options.mode === 'revert') {
    checks.push(
      belowCountBefore(i) >= options.threshold,
      close > currentBbi,
      bbi[i - 1] !== null && previousClose <= bbi[i - 1]
    );
  } else {
    checks.push(currentBbi >= currentMa20);
    if (!skipVolume) checks.push(volumeRatio !== null && volumeRatio >= options.volMult);
    checks.push(close > previousClose, deviationPct >= options.breakPct);
  }

  return {
    date: kline[i].date,
    close,
    dailyPct: previousClose > 0 ? (close / previousClose - 1) * 100 : null,
    bbi: currentBbi,
    deviationPct,
    volumeRatio,
    triggered: checks.length > 0 && checks.every(Boolean)
  };
}

function buildAmountVolume(shanghai, shenzhen) {
  const amounts = new Map();
  for (const item of [...shanghai, ...shenzhen]) {
    if (Number.isFinite(item.amount) && item.amount > 0) {
      amounts.set(item.date, (amounts.get(item.date) || 0) + item.amount);
    }
  }
  const dates = [...amounts.keys()].sort();
  if (dates.length < 7) return null;
  const values = dates.map(date => amounts.get(date));
  const today = values.at(-1);
  const previous = values.at(-2);
  const average = values.slice(-6, -1).reduce((sum, value) => sum + value, 0) / 5;
  if (!average || !Number.isFinite(average)) return null;
  const ratio = today / average;
  const ratioPrevious = previous > 0 ? today / previous : null;
  const changePreviousPct = ratioPrevious === null ? null : (ratioPrevious - 1) * 100;
  const label = ratio >= 1.2 ? '放量' : (ratio <= 0.8 ? '缩量' : '平量');
  return { today, previous, average, ratio, changePreviousPct, label };
}

function formatAmount(value) {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1e12) return `${(value / 1e12).toFixed(2)}万亿`;
  if (value >= 1e8) return `${(value / 1e8).toFixed(0)}亿`;
  return `${(value / 1e4).toFixed(0)}万`;
}

function formatPct(value) {
  if (!Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function formatSignal(item, quote) {
  const name = quote?.name || item.name || item.code;
  const id = item.code || item.secid.split('.')[1];
  const pct = quote?.pct ?? item.signal.dailyPct;
  return `• ${name}（${id}） 收盘 ${item.signal.close.toFixed(2)}，当日 ${formatPct(pct)}，偏离红队 ${formatPct(item.signal.deviationPct)}`;
}

function buildReport(reportDate, results, quotes, market, amountVolume) {
  const triggeredIndices = results.filter(item => item.kind === '指数' && item.signal?.triggered);
  const triggeredStocks = results.filter(item => item.kind === '自选' && item.signal?.triggered);
  const dataErrors = results.filter(item => item.error);
  const strength = market.up > market.down
    ? '偏强（上涨家数占优）'
    : market.down > market.up
      ? '偏弱（下跌家数占优）'
      : '涨跌均衡';

  const timeframeLabel = { day: '日线', week: '周线', month: '月线' }[SETTINGS.timeframe] || '日线';
  const ruleText = SETTINGS.mode === 'revert'
    ? `${timeframeLabel}深跌反转（红队下方≥${SETTINGS.threshold}根）`
    : `${timeframeLabel}趋势突破（量比≥${SETTINGS.volMult}×，偏离红队≥${SETTINGS.breakPct}%）`;
  const lines = [
    `📊 A股收盘监控｜${reportDate}`,
    `规则：${ruleText}`,
    '',
    '🎯 今日触发',
    `指数：${triggeredIndices.length ? `${triggeredIndices.length} 个` : '无'}`,
    ...triggeredIndices.map(item => formatSignal(item, quotes[item.secid])),
    `自选：${triggeredStocks.length ? `${triggeredStocks.length} 只` : '无'}`,
    ...triggeredStocks.map(item => formatSignal(item, quotes[item.secid])),
    '',
    `🌡️ 大盘强弱：${strength}`,
    `全市场：涨 ${market.up} 家｜平 ${market.flat} 家｜跌 ${market.down} 家`,
    `全市场成交额（沪深北）：${formatAmount(market.amount)}`
  ];

  if (amountVolume) {
    const dailyChange = amountVolume.changePreviousPct === null
      ? '较昨日 —'
      : `较昨日 ${formatPct(amountVolume.changePreviousPct)}`;
    lines.push(
      `量能（沪深合计）：${amountVolume.label}，今日/前5日均 ${amountVolume.ratio.toFixed(2)}×，${dailyChange}`
    );
  } else {
    lines.push('量能（沪深合计）：成交额比较数据暂不可用');
  }

  if (dataErrors.length) {
    lines.push('', '⚠️ 未能判定（行情缺失或K线不足）：');
    for (const item of dataErrors) {
      lines.push(`• ${item.name || item.code || item.secid}（${item.code || item.secid.split('.')[1]}）`);
    }
  }
  lines.push('', '说明：大盘强弱依据涨跌家数；量能对比采用网页当前的沪深成交额口径。');
  return lines.join('\n');
}

function chinaClock() {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(new Date());
}

async function fetchCurrentDailyIndexBars(today) {
  let bars = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    bars = await fetchKline(indexSecid, 101, 300);
    if (bars.at(-1)?.date === today) break;
    if (attempt < 3) await sleep(15000);
  }
  KLINE_CACHE.set(`${indexSecid}|101|300`, Promise.resolve(bars));
  return bars;
}

async function sendFeishu(text) {
  const webhook = process.env.FEISHU_WEBHOOK_URL;
  const signSecret = process.env.FEISHU_SIGN_SECRET;
  const body = { msg_type: 'text', content: { text } };
  if (signSecret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const stringToSign = `${timestamp}\n${signSecret}`;
    body.timestamp = timestamp;
    body.sign = createHmac('sha256', stringToSign).digest('base64');
  }
  let response;
  try {
    response = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });
  } catch {
    throw new Error('飞书推送请求失败');
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok || (result.code !== undefined && result.code !== 0)) {
    throw new Error(`飞书推送未成功（HTTP ${response.status}）`);
  }
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000)
    });
  } catch {
    throw new Error('Telegram 推送请求失败');
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok !== true) {
    throw new Error(`Telegram 推送未成功（HTTP ${response.status}）`);
  }
}

async function mapLimit(items, limit, mapper) {
  const output = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      output[index] = await mapper(items[index]);
    }
  }));
  return output;
}

async function main() {
  const today = chinaDate();
  const analysisKlt = { day: 101, week: 102, month: 103 }[SETTINGS.timeframe] || 101;
  const analysisLimit = SETTINGS.timeframe === 'day' ? 300 : 240;
  const dailyIndexBars = await fetchCurrentDailyIndexBars(today);
  const reportDate = dailyIndexBars.at(-1)?.date;

  // Weekday cron + actual latest Shanghai-index bar date prevents holiday/stale-data sends.
  if (reportDate !== today) {
    console.log(`Skipped: no current-day A-share trading bar (${today}); no notification sent.`);
    return;
  }

  const secids = [...new Set(ASSETS.map(item => item.secid))];
  const quotePromise = fetchQuotes(secids).catch(() => ({}));
  const marketPromise = fetchMarket();
  const amountPromise = Promise.all([
    fetchKlineCached('1.000001', 101, 300),
    fetchKlineCached('0.399001', 101, 300)
  ]).then(([shanghai, shenzhen]) => buildAmountVolume(shanghai, shenzhen)).catch(() => null);
  const resultsPromise = mapLimit(ASSETS, 4, async item => {
    try {
      const bars = await fetchKlineCached(item.secid, analysisKlt, analysisLimit);
      const signal = analyzeCurrentBar(bars, SETTINGS);
      if (signal.error) return { ...item, error: signal.error };
      return { ...item, signal };
    } catch (error) {
      return { ...item, error: error?.message || 'K线请求失败' };
    }
  });

  const [quotes, market, amountVolume, results] = await Promise.all([
    quotePromise, marketPromise, amountPromise, resultsPromise
  ]);
  const report = buildReport(reportDate, results, quotes, market, amountVolume);
  console.log(`Report prepared for ${reportDate}; message content and signal details are withheld from public logs.`);
  console.log(`A-share close check completed at ${chinaClock()} Asia/Shanghai.`);

  if (DRY_RUN) {
    console.log('Dry run: no messages sent. Report content is omitted from logs for repository privacy.');
    if (SHOW_PREVIEW) console.log(`\n${report}`);
    return;
  }

  const missing = ['FEISHU_WEBHOOK_URL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']
    .filter(key => !process.env[key]);
  if (missing.length) throw new Error(`缺少 GitHub Actions Secrets：${missing.join(', ')}`);

  const sendResults = await Promise.allSettled([sendFeishu(report), sendTelegram(report)]);
  const failures = sendResults
    .map((result, index) => result.status === 'rejected' ? ['飞书', 'Telegram'][index] : null)
    .filter(Boolean);
  if (failures.length) throw new Error(`消息发送失败：${failures.join('、')}`);
  console.log('Report sent to Feishu and Telegram. Message content is omitted from logs.');
}

main().catch(error => {
  console.error(`Daily market monitor failed: ${error?.message || 'unknown error'}`);
  process.exitCode = 1;
});
