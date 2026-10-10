'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

// ── .env (의존성 없이 최소만) ───────────────────────────────
(function loadEnv() {
  const f = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(f)) return;
  fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((l) => {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
})();

const { KafriClient } = require('./kafri-core');
const { DemoClient } = require('./demo');
const M = require('./model');
const X = require('./excel');
const { extractBundle } = require('./extract');
const company = require('./company');
const codes = require('./codes');
const reg = require('./register');
const pkg = require('../package.json');

const PORT = Number(process.env.PORT || 8791);
const PUB = path.join(__dirname, '..', 'public');
const DEMO = process.env.KAFRI_DEMO === '1';
const MAX_BODY = 120 * 1024 * 1024;

/* 사번·세션은 메모리에만 둔다 */
let client = null;
let codeCache = null;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(data);
}
const fail = (res, status, message, extra = {}) => send(res, status, { error: message, ...extra });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const cs = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new Error('요청이 너무 큽니다.')); req.destroy(); } else cs.push(c); });
    req.on('end', () => { try { resolve(cs.length ? JSON.parse(Buffer.concat(cs).toString('utf8')) : {}); } catch { reject(new Error('요청 형식이 올바르지 않습니다.')); } });
    req.on('error', reject);
  });
}

/* 이 서버는 사용자 PC 안에서만 쓴다. 다른 사이트가 이 주소로 요청을 보내는 것(DNS 리바인딩·CSRF)을 막는다. */
function hostOk(req) {
  const h = String(req.headers.host || '').toLowerCase();
  if (!(h === `127.0.0.1:${PORT}` || h === `localhost:${PORT}`)) return false;
  const o = req.headers.origin;
  if (o && !(o === `http://127.0.0.1:${PORT}` || o === `http://localhost:${PORT}`)) return false;
  return true;
}

function needClient(res) {
  if (!client || !client.session) { fail(res, 401, '먼저 사번으로 연결하세요.'); return false; }
  return true;
}

async function getCodes() {
  if (!codeCache) codeCache = await client.getCodes();
  return codeCache;
}

const routes = {
  'GET /api/state': async () => ({
    version: pkg.version, demo: DEMO, hasKey: !!process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
    user: client && client.session ? { userId: client.session.userId, userNm: client.session.userNm || '', deptNm: client.session.deptNm || '' } : null,
  }),

  'POST /api/login': async ({ body }) => {
    const no = String(body.employeeNo || '').trim();
    if (!/^\d{4,10}$/.test(no)) throw Object.assign(new Error('사번은 숫자로 입력하세요.'), { status: 400 });
    client = DEMO ? new DemoClient({ employeeNo: no }) : new KafriClient({ employeeNo: no, baseUrl: process.env.KAFRI_BASE_URL || undefined, insecure: process.env.KAFRI_INSECURE_TLS === '1' });
    codeCache = null;
    try { await Promise.race([client.login(), new Promise((_, rej) => setTimeout(() => rej(new Error('15초 안에 응답이 없습니다. 사내망 연결을 확인하세요.')), 15000))]); } catch (e) { client = null; throw Object.assign(new Error(`연구관리시스템에 연결하지 못했습니다: ${e.message}`), { status: 502 }); }
    return { user: { userId: client.session.userId, userNm: client.session.userNm || '', deptNm: client.session.deptNm || '' } };
  },
  'POST /api/logout': async () => { client = null; codeCache = null; return { ok: true }; },

  'POST /api/extract': async ({ body }) => extractBundle(body.files),

  'POST /api/excel/import': async ({ body }) => X.importWorkbook(Buffer.from(body.data || '', 'base64')),

  'POST /api/company': async ({ body, res }) => {
    if (!needClient(res)) return undefined;
    if (!M.str(body.name)) throw Object.assign(new Error('업체명이 비어 있습니다.'), { status: 400 });
    return company.lookup(client, body.name, { years: Number(body.years) || 3 });
  },
  'POST /api/dup': async ({ body, res }) => {
    if (!needClient(res)) return undefined;
    return company.duplicates(client, M.normalize(body.order));
  },
  'POST /api/codematch': async ({ body, res }) => {
    if (!needClient(res)) return undefined;
    return codes.matchOrder(await getCodes(), M.normalize(body.order));
  },
  'GET /api/codegroups': async ({ res }) => {
    if (!needClient(res)) return undefined;
    const g = await getCodes();
    return { groups: Object.entries(g).map(([id, v]) => ({ id, name: v.name, count: Object.keys(v.codes).length, sample: Object.entries(v.codes).slice(0, 6).map(([c, n]) => `${c} ${n}`) })) };
  },
  'POST /api/preview': async ({ body }) => {
    const o = M.normalize(body.order);
    return reg.buildPreview(o, { company: body.company, codes: body.codes, user: client && client.session });
  },
  'POST /api/register': async ({ body }) => {
    // 드라이런 전용. 서버에 저장하지 않는다.
    const out = [];
    for (const raw of body.orders || []) {
      try { await reg.execute(M.normalize(raw), { client }); out.push({ id: raw.id, ok: true }); }
      catch (e) { out.push({ id: raw.id, ok: false, code: e.code || 'ERROR', message: e.message }); }
    }
    return { results: out };
  },
};

const server = http.createServer(async (req, res) => {
  try {
    if (!hostOk(req)) return fail(res, 403, '허용되지 않은 요청입니다.');
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);

    if (u.pathname === '/api/excel/export' && req.method === 'POST') {
      const body = await readBody(req);
      const orders = (body.orders || []).map((o) => { const n = M.normalize(o); n.id = o.id || n.id; n.flags = o.flags || n.flags; return n; });
      const buf = await X.exportOrders(orders);
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
      return send(res, 200, Buffer.from(buf), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`접수목록_${stamp}.xlsx`)}` });
    }

    const key = `${req.method} ${u.pathname}`;
    if (routes[key]) {
      const body = req.method === 'POST' ? await readBody(req) : {};
      let out;
      try { out = await routes[key]({ body, res, query: u.searchParams }); }
      catch (e) { return fail(res, e.status || (e.code === 'NO_KEY' ? 400 : 500), e.message, e.code ? { code: e.code } : {}); }
      if (res.writableEnded || out === undefined) return undefined;
      return send(res, 200, out);
    }

    // 정적 파일. model.js 는 서버와 브라우저가 같이 쓴다.
    let rel = decodeURIComponent(u.pathname);
    if (rel === '/') rel = '/index.html';
    const file = rel === '/js/model.js' ? path.join(__dirname, 'model.js') : path.join(PUB, rel);
    const root = rel === '/js/model.js' ? __dirname : PUB;
    if (!path.resolve(file).startsWith(path.resolve(root))) return fail(res, 403, '허용되지 않은 경로입니다.');
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return fail(res, 404, '찾을 수 없습니다.');
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    return fail(res, 500, e.message);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log(`  접수 도우미 ${pkg.version} (테스트 버전 · 드라이런)`);
  console.log(`  주소      http://127.0.0.1:${PORT}`);
  console.log(`  서버      ${DEMO ? '데모 모드 (KAFRI 에 접속하지 않음)' : (process.env.KAFRI_BASE_URL || require('./kafri-core').DEFAULT_BASE)}`);
  console.log(`  AI 추출   ${process.env.ANTHROPIC_API_KEY ? '사용 가능' : '키 없음 (엑셀 불러오기만 가능)'}`);
  console.log('  이 창을 닫으면 프로그램이 종료됩니다.');
  console.log('');
});
