'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const cfg = require('./config');
cfg.loadEnv(path.join(__dirname, '..', '.env'));
const C = cfg.build();
if (C.errors.length) {
  console.error('\n  설정 오류로 시작하지 않습니다:');
  C.errors.forEach((e) => console.error('   - ' + e));
  console.error('  .env 를 고친 뒤 다시 실행하세요. (.env.server.example 참고)\n');
  process.exit(1);
}

const { KafriClient } = require('./kafri-core');
const { DemoClient } = require('./demo');
const M = require('./model');
const X = require('./excel');
const { extractBundle } = require('./extract');
const fixed = require('./fixed');
const company = require('./company');
const codes = require('./codes');
const reg = require('./register');
const audit = require('./audit').create(C.logDir, C.shared);
const pkg = require('../package.json');

const PORT = C.port;
const PUB = path.join(__dirname, '..', 'public');
const DEMO = C.demo;
const MAX_BODY = C.maxBodyMb * 1024 * 1024;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };

/* ── 응답 ─────────────────────────────────────────── */
function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const sec = {
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  };
  if (C.secureCookie) sec['Strict-Transport-Security'] = 'max-age=31536000';
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-store', ...sec, ...extra });
  res.end(data);
}
const fail = (res, status, message, extra = {}) => send(res, status, { error: message, ...extra });
const httpErr = (status, message, code) => Object.assign(new Error(message), { status, code });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const cl = Number(req.headers['content-length'] || 0);
    if (cl > MAX_BODY) { req.resume(); return reject(httpErr(413, `요청이 너무 큽니다(최대 ${C.maxBodyMb}MB).`)); }
    const cs = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(httpErr(413, `요청이 너무 큽니다(최대 ${C.maxBodyMb}MB).`)); req.destroy(); } else cs.push(c); });
    req.on('end', () => { try { resolve(cs.length ? JSON.parse(Buffer.concat(cs).toString('utf8')) : {}); } catch { reject(httpErr(400, '요청 형식이 올바르지 않습니다.')); } });
    req.on('error', reject);
  });
}

/* ── 접속 제한: 주소(Host/Origin), IP ─────────────── */
const hostOk = (req) => {
  const h = String(req.headers.host || '').toLowerCase();
  if (!C.hosts.has(h)) return false;
  const o = req.headers.origin;
  if (o) { try { if (!C.hosts.has(new URL(o).host.toLowerCase())) return false; } catch { return false; } }
  return true;
};
function clientIp(req) {
  let ip = req.socket.remoteAddress || '';
  if (C.trustProxy && req.headers['x-forwarded-for']) ip = String(req.headers['x-forwarded-for']).split(',').pop().trim();
  return ip.replace(/^::ffff:/, '');
}
const ip4 = (s) => { const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s); return m ? (((+m[1] << 24) >>> 0) + (+m[2] << 16) + (+m[3] << 8) + +m[4]) >>> 0 : null; };
function ipAllowed(ip) {
  if (!C.allowedIps.length) return true;
  const v = ip4(ip);
  if (v == null) return ip === '::1' && C.allowedIps.includes('::1');
  return C.allowedIps.some((r) => {
    const [base, bits] = r.split('/');
    const b = ip4(base);
    if (b == null) return false;
    const n = bits === undefined ? 32 : Number(bits);
    const mask = n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0;
    return (v & mask) >>> 0 === (b & mask) >>> 0;
  });
}

/* ── 세션: 사용자마다 따로 (사번 연결, 코드표 캐시) ──── */
const sessions = new Map();
const IDLE_MS = C.sessionHours * 3600 * 1000;
function parseCookies(req) {
  const o = {};
  String(req.headers.cookie || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  return o;
}
function getSession(req, res) {
  const sid = parseCookies(req).sid;
  let s = sid && sessions.get(sid);
  const now = Date.now();
  if (s && now - s.last > IDLE_MS) { sessions.delete(sid); s = null; }
  if (!s) {
    if (sessions.size >= C.maxSessions) {
      const oldest = [...sessions.values()].sort((a, b) => a.last - b.last)[0];
      if (oldest) sessions.delete(oldest.id);
    }
    s = { id: crypto.randomBytes(32).toString('hex'), created: now, last: now, accessOk: !C.shared, client: null, codeCache: null };
    sessions.set(s.id, s);
    res.setHeader('Set-Cookie', `sid=${s.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(IDLE_MS / 1000)}${C.secureCookie ? '; Secure' : ''}`);
  }
  s.last = now;
  s.ip = clientIp(req);
  return s;
}
setInterval(() => { const t = Date.now(); sessions.forEach((s, k) => { if (t - s.last > IDLE_MS) sessions.delete(k); }); }, 10 * 60 * 1000).unref();

/* ── 접속 비밀번호: 무차별 대입 방지 ─────────────── */
const fails = new Map();
const LOCK_AFTER = 5, LOCK_MS = 10 * 60 * 1000;
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest();
const passwordOk = (given) => crypto.timingSafeEqual(hash(given), hash(C.password));

const userOf = (s) => (s.client && s.client.session ? { userId: s.client.session.userId, userNm: s.client.session.userNm || '', deptNm: s.client.session.deptNm || '' } : null);
function needClient(s) {
  if (!s.client || !s.client.session) throw httpErr(401, '먼저 사번으로 연결하세요.');
}
async function getCodes(s) {
  if (!s.codeCache) s.codeCache = await s.client.getCodes();
  return s.codeCache;
}

/* ── API ─────────────────────────────────────────── */
const OPEN = new Set(['GET /api/state', 'POST /api/access']);
const routes = {
  'GET /api/state': async ({ sess }) => ({
    version: pkg.version, demo: DEMO, hasKey: !!process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
    shared: C.shared, accessRequired: C.shared, accessOk: sess.accessOk,
    user: sess.accessOk ? userOf(sess) : null,
  }),

  'POST /api/access': async ({ body, sess, ip }) => {
    if (!C.shared) return { ok: true };
    const f = fails.get(ip);
    if (f && f.until > Date.now()) throw httpErr(429, `비밀번호를 여러 번 틀렸습니다. ${Math.ceil((f.until - Date.now()) / 60000)}분 뒤에 다시 시도하세요.`);
    if (!passwordOk(body.password || '')) {
      const n = ((f && f.n) || 0) + 1;
      fails.set(ip, { n, until: n >= LOCK_AFTER ? Date.now() + LOCK_MS : 0 });
      audit('access_fail', { ip, n });
      throw httpErr(401, '접속 비밀번호가 맞지 않습니다.', 'ACCESS');
    }
    fails.delete(ip);
    sess.accessOk = true;
    audit('access_ok', { ip });
    return { ok: true };
  },
  'POST /api/signout': async ({ sess, ip }) => {
    audit('signout', { ip, emp: sess.client && sess.client.session ? sess.client.session.userId : undefined });
    sessions.delete(sess.id);
    return { ok: true };
  },

  'POST /api/login': async ({ body, sess, ip }) => {
    const no = String(body.employeeNo || '').trim();
    if (!/^\d{4,10}$/.test(no)) throw httpErr(400, '사번은 숫자로 입력하세요.');
    if (C.allowedEmployees.length && !C.allowedEmployees.includes(no)) {
      audit('login_denied', { ip, emp: no });
      throw httpErr(403, '이 서버를 사용할 수 있는 사번이 아닙니다. 관리자에게 문의하세요.');
    }
    const client = DEMO ? new DemoClient({ employeeNo: no }) : new KafriClient({ employeeNo: no, baseUrl: process.env.KAFRI_BASE_URL || undefined, insecure: process.env.KAFRI_INSECURE_TLS === '1' });
    try { await Promise.race([client.login(), new Promise((_, rej) => setTimeout(() => rej(new Error('15초 안에 응답이 없습니다. 사내망 연결을 확인하세요.')), 15000))]); }
    catch (e) { audit('login_fail', { ip, emp: no }); throw httpErr(502, `연구관리시스템에 연결하지 못했습니다: ${e.message}`); }
    sess.client = client; sess.codeCache = null;
    audit('login', { ip, emp: no });
    return { user: userOf(sess) };
  },
  'POST /api/logout': async ({ sess, ip }) => { audit('logout', { ip, emp: sess.client && sess.client.session ? sess.client.session.userId : undefined }); sess.client = null; sess.codeCache = null; return { ok: true }; },

  'POST /api/extract': async ({ body, sess, ip }) => { const out = await extractBundle(body.files); audit('convert', { ip, how: 'ai', emp: empOf(sess), files: (body.files || []).length, orders: out.orders.length }); return out; },

  // B. 고정 양식 문서(docx · hwpx · 글자 있는 PDF) 규칙 변환 — API 키 불필요
  'POST /api/fixed': async ({ body, sess, ip }) => {
    if (!body.data) throw httpErr(400, '파일이 비어 있습니다.');
    const ext = (path.extname(String(body.name || '')).slice(1) || '').toLowerCase();
    try {
      const out = await fixed.convert(Buffer.from(body.data, 'base64'), String(body.name || ''));
      audit('convert', { ip, how: 'rule', emp: empOf(sess), ext, orders: out.orders.length });
      return out;
    } catch (e) { audit('convert_fail', { ip, how: 'rule', emp: empOf(sess), ext, code: e.code }); throw Object.assign(e, { status: e.status || 422 }); }
  },

  // A. Claude 앱에 붙여 넣을 요청문 (양식 열 이름을 채워 돌려준다)
  'GET /api/claude-prompt': async () => ({
    text: fs.readFileSync(path.join(__dirname, 'prompts', 'claude-app.md'), 'utf8').replace('{{COLUMNS}}', X.COL_HEADERS.join(' | ')),
    template: '접수양식_빈칸.xlsx',
  }),

  'POST /api/excel/import': async ({ body, sess, ip }) => { const out = await X.importWorkbook(Buffer.from(body.data || '', 'base64')); audit('excel_import', { ip, emp: empOf(sess), orders: out.orders.length }); return out; },

  'POST /api/company': async ({ body, sess }) => {
    needClient(sess);
    if (!M.str(body.name)) throw httpErr(400, '업체명이 비어 있습니다.');
    return company.lookup(sess.client, body.name, { years: Number(body.years) || 3 });
  },
  'POST /api/dup': async ({ body, sess }) => { needClient(sess); return company.duplicates(sess.client, M.normalize(body.order)); },
  'POST /api/codematch': async ({ body, sess }) => { needClient(sess); return codes.matchOrder(await getCodes(sess), M.normalize(body.order)); },
  'GET /api/codegroups': async ({ sess }) => {
    needClient(sess);
    const g = await getCodes(sess);
    return { groups: Object.entries(g).map(([id, v]) => ({ id, name: v.name, count: Object.keys(v.codes).length, sample: Object.entries(v.codes).slice(0, 6).map(([c, n]) => `${c} ${n}`) })) };
  },
  'POST /api/preview': async ({ body, sess }) => {
    const o = M.normalize(body.order);
    return reg.buildPreview(o, { company: body.company, codes: body.codes, user: sess.client && sess.client.session });
  },
  'POST /api/register': async ({ body, sess, ip }) => {
    // 드라이런 전용. 서버에 저장하지 않는다.
    const out = [];
    for (const raw of body.orders || []) {
      try { await reg.execute(M.normalize(raw), { client: sess.client }); out.push({ id: raw.id, ok: true }); }
      catch (e) { out.push({ id: raw.id, ok: false, code: e.code || 'ERROR', message: e.message }); }
    }
    audit('register_dry', { ip, emp: empOf(sess), n: out.length });
    return { results: out };
  },
};
const empOf = (s) => (s.client && s.client.session ? s.client.session.userId : undefined);

/* ── 서버 ────────────────────────────────────────── */
async function handler(req, res) {
  try {
    if (req.url === '/healthz') return send(res, 200, { ok: true }); // 모니터링용. 아무 정보도 주지 않는다
    const ip = clientIp(req);
    if (!ipAllowed(ip)) { audit('ip_denied', { ip }); return fail(res, 403, '이 주소에서는 접속할 수 없습니다.'); }
    if (!hostOk(req)) return fail(res, 403, '허용되지 않은 요청입니다.');
    const u = new URL(req.url, `http://${req.headers.host}`);

    if (u.pathname.startsWith('/api/')) {
      const sess = getSession(req, res);
      const key = `${req.method} ${u.pathname}`;
      const known = routes[key] || (key === 'POST /api/excel/export' || key === 'GET /api/template');
      if (!known) return fail(res, 404, '찾을 수 없습니다.');
      if (!OPEN.has(key) && !sess.accessOk) return fail(res, 401, '접속 비밀번호를 먼저 입력하세요.', { code: 'ACCESS' });

      if (key === 'POST /api/excel/export') {
        const body = await readBody(req);
        const orders = (body.orders || []).map((o) => { const n = M.normalize(o); n.id = o.id || n.id; n.flags = o.flags || n.flags; return n; });
        const buf = await X.exportOrders(orders);
        audit('excel_export', { ip, emp: empOf(sess), orders: orders.length });
        const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
        return send(res, 200, Buffer.from(buf), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`접수목록_${stamp}.xlsx`)}` });
      }
      if (key === 'GET /api/template') {
        const buf = await X.exportTemplate();
        return send(res, 200, Buffer.from(buf), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('접수양식_빈칸.xlsx')}` });
      }
      const body = req.method === 'POST' ? await readBody(req) : {};
      let out;
      try { out = await routes[key]({ body, sess, ip, req, query: u.searchParams }); }
      catch (e) { return fail(res, e.status || (e.code === 'NO_KEY' ? 400 : 500), e.message, { ...(e.code ? { code: e.code } : {}), ...(e.report ? { report: e.report } : {}) }); }
      if (key === 'POST /api/signout') res.setHeader('Set-Cookie', `sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${C.secureCookie ? '; Secure' : ''}`);
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
    return fail(res, e.status || 500, e.message);
  }
}

const server = C.tls
  ? https.createServer({ cert: fs.readFileSync(path.resolve(C.root, C.tlsCert)), key: fs.readFileSync(path.resolve(C.root, C.tlsKey)) }, handler)
  : http.createServer(handler);
server.requestTimeout = 5 * 60 * 1000;

if (require.main === module) {
  server.listen(PORT, C.host, () => {
    const scheme = C.tls ? 'https' : 'http';
    console.log('');
    console.log(`  접수 도우미 ${pkg.version} (테스트 버전 · 드라이런)${C.shared ? ' · 공유 서버 모드' : ''}`);
    console.log(`  주소      ${C.publicUrl || `${scheme}://${C.host === '0.0.0.0' ? '서버주소' : C.host}:${PORT}`}`);
    console.log(`  서버      ${DEMO ? '데모 모드 (KAFRI 에 접속하지 않음)' : (process.env.KAFRI_BASE_URL || require('./kafri-core').DEFAULT_BASE)}`);
    console.log(`  AI 추출   ${process.env.ANTHROPIC_API_KEY ? '사용 가능' : '키 없음 (고정 양식 변환 · Claude 앱 변환 · 엑셀 불러오기 사용 가능)'}`);
    if (C.shared) {
      console.log(`  접속 제한 비밀번호 설정됨 · IP ${C.allowedIps.length ? C.allowedIps.join(', ') : '제한 없음'} · 사번 ${C.allowedEmployees.length ? C.allowedEmployees.length + '명만 허용' : '제한 없음'}`);
      console.log(`  기록      ${C.logDir}`);
      C.warnings.forEach((w) => console.log('  주의: ' + w));
    }
    console.log('  이 창을 닫으면 프로그램이 종료됩니다.');
    console.log('');
  });
  ['SIGINT', 'SIGTERM'].forEach((sig) => process.on(sig, () => { audit('stop', {}); server.close(); setTimeout(() => process.exit(0), 300).unref(); }));
  audit('start', { version: pkg.version, shared: C.shared, tls: C.tls });
}
module.exports = { server, C };
