'use strict';
/* node test/run.js — 외부 도구 없이 변환 경로(B 고정 양식, A 양식 엑셀)와 서버 경로를 점검한다 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const fixed = require('../src/fixed');
const X = require('../src/excel');

const FX = path.join(__dirname, 'fixtures');
let pass = 0;
const t = async (name, fn) => {
  try { await fn(); pass += 1; console.log('  ok   ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n       ')); process.exitCode = 1; }
};

function checkStandard(out) {
  assert.strictEqual(out.orders.length, 2, '시료 2건 → 접수 2건');
  const [a, b] = out.orders;
  assert.strictEqual(a.requester.name, '광동헬스바이오(주) 2공장');
  assert.strictEqual(a.requester.rep, '홍길동', '의뢰인 쪽 대표자');
  assert.strictEqual(a.requester.addr, '경기도 평택시 포승읍 1');
  assert.strictEqual(a.requester.tel, '031-111-2222');
  assert.strictEqual(a.requester.mobile, '010-1234-5678');
  assert.strictEqual(a.requester.contact, '김담당');
  assert.strictEqual(a.billing.name, '광동제약(주)', '계산서 쪽 업체명');
  assert.strictEqual(a.billing.bizno, '123-81-12342');
  assert.strictEqual(a.billing.contact, '010-2222-3333', '계산서 담당자 연락처(의뢰인 전화와 섞이지 않음)');
  assert.strictEqual(a.report.addr, '경기도 평택시 포승읍 1 품질팀');
  assert.strictEqual(a.report.korCopies, '1');
  assert.strictEqual(a.report.delivery, '우편, 팩스', '체크된 전달방법만');
  assert.strictEqual(a.purpose, '품질관리', '체크된 의뢰목적만');
  assert.strictEqual(a.storage, '냉장');
  assert.strictEqual(a.sample.name, '올리브유 캡슐');
  assert.strictEqual(a.sample.lot, 'L2610A');
  assert.strictEqual(a.sample.mfgDate, '', "제조일자 '-' 는 공란");
  assert.strictEqual(a.sample.expDate, '2028-10-01');
  assert.ok(a.flags['sample.amount'], '복잡한 포장 표기는 추정 표시');
  assert.deepStrictEqual(a.items.map((i) => i.name), ['벤조피렌']);
  assert.strictEqual(b.sample.name, '오메가3 연질캡슐');
  assert.strictEqual(b.sample.lot, '', '빈 제조번호 칸이 옆 칸 값을 끌어오지 않음');
  assert.strictEqual(b.sample.mfgDate, '2026-09-01');
  assert.strictEqual(b.sample.expDate, '2028-09-01');
  assert.strictEqual(b.requester.name, a.requester.name, '공통 정보는 건마다 반복');
  assert.ok(!Object.keys(a.flags).some((k) => k.startsWith('billing') || k.startsWith('requester')), '구역을 정확히 읽은 값은 노란 칸이 아님');
  assert.ok(out.notes.includes('항목을 읽었습니다'));
}

(async () => {
  console.log('B. 고정 양식 규칙 변환');
  await t('docx (좌우 구역 · 시료 2건)', async () => {
    const out = await fixed.convert(fs.readFileSync(path.join(FX, '표준양식.docx')), '표준양식.docx');
    checkStandard(out);
    assert.deepStrictEqual(out.orders[1].items.map((i) => i.name), ['납', '카드뮴'], '한 칸의 여러 줄 → 시험항목 여러 개');
  });
  await t('hwpx', async () => {
    const out = await fixed.convert(fs.readFileSync(path.join(FX, '표준양식.hwpx')), '표준양식.hwpx');
    checkStandard(out);
  });
  await t('글자가 있는 PDF (빈 칸은 가로 위치로 맞춤)', async () => {
    const out = await fixed.convert(fs.readFileSync(path.join(FX, '표준양식.pdf')), '표준양식.pdf');
    assert.strictEqual(out.orders.length, 2);
    assert.strictEqual(out.orders[0].billing.name, '광동제약(주)');
    assert.strictEqual(out.orders[0].billing.contact, '010-2222-3333');
    assert.strictEqual(out.orders[1].sample.lot, '');
    assert.strictEqual(out.orders[1].sample.expDate, '2028-09-01');
    assert.strictEqual(out.orders[0].purpose, '품질관리');
  });
  await t('Word 체크박스(☒/☐)와 병합 셀', async () => {
    const tc = (txt, span) => `<w:tc><w:tcPr>${span ? `<w:gridSpan w:val="${span}"/>` : ''}</w:tcPr><w:p><w:r><w:t>${txt}</w:t></w:r></w:p></w:tc>`;
    const tr = (...c) => `<w:tr>${c.join('')}</w:tr>`;
    const xml = `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>
      <w:tbl>${tr(tc('업체명'), tc('테스트(주)', 3))}${tr(tc('핸드폰'), tc('010-9999-8888'), tc('이메일'), tc('a@b.co'))}
      ${tr(tc('의뢰목적'), tc('☐ 연구개발'), tc('☒ 품질관리'))}${tr(tc('시료명'), tc('치즈'))}${tr(tc('시험항목'), tc('대장균군'))}</w:tbl></w:body></w:document>`;
    const z = new JSZip(); z.file('word/document.xml', xml);
    const out = await fixed.convert(await z.generateAsync({ type: 'nodebuffer' }), 'x.docx');
    const o = out.orders[0];
    assert.strictEqual(o.purpose, '품질관리');
    assert.strictEqual(o.requester.name, '테스트(주)');
    assert.strictEqual(o.requester.mobile, '010-9999-8888');
    assert.strictEqual(o.sample.name, '치즈');
    assert.deepStrictEqual(o.items.map((i) => i.name), ['대장균군']);
  });
  await t('양식이 다르면 추측하지 않고 NO_MATCH', async () => {
    const z = new JSZip(); z.file('word/document.xml', '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>회의록 오늘 안건은 점심 메뉴</w:t></w:r></w:p></w:body></w:document>');
    await assert.rejects(fixed.convert(await z.generateAsync({ type: 'nodebuffer' }), 'm.docx'), (e) => e.code === 'NO_MATCH');
  });
  await t('글자 없는 PDF 는 NO_TEXT', async () => {
    const pdf = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R/Size 4>>\n%%EOF';
    await assert.rejects(fixed.convert(Buffer.from(pdf), 's.pdf'), (e) => ['NO_TEXT', 'BAD_FILE'].includes(e.code));
  });
  await t('.hwp / .doc 는 변환 안내', async () => {
    await assert.rejects(fixed.convert(Buffer.from('x'), 'a.hwp'), (e) => /hwpx/.test(e.message));
  });

  console.log('A. Claude 앱 변환용 양식 엑셀');
  await t('빈 양식: 접수·시험항목·작성예시·안내 시트, 불러오면 0건', async () => {
    const buf = await X.exportTemplate();
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
    assert.deepStrictEqual(wb.worksheets.map((w) => w.name), ['접수', '시험항목', '작성예시', '안내']);
    assert.strictEqual(wb.getWorksheet('접수').getRow(1).getCell(1).value, '접수ID');
    const r = await X.importWorkbook(buf);
    assert.strictEqual(r.orders.length, 0);
  });
  await t('Claude 가 채운 엑셀(열 제목으로 적은 사유 · 노란 칸 · 노란 칸 누락)', async () => {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await X.exportTemplate());
    wb.creator = 'openpyxl'; // 앱이 아닌 도구가 저장한 파일
    const ws = wb.getWorksheet('접수');
    const head = ws.getRow(1).values; // 1-based
    const col = (n) => head.indexOf(n);
    const row = ws.getRow(2);
    const set = (n, v) => { row.getCell(col(n)).value = v; };
    set('접수ID', 'A01'); set('업체명', '테스트식품(주)'); set('핸드폰', '01012345678'); set('의뢰목적', '품질관리');
    set('시료명', '들기름'); set('식품유형', '식용유지'); set('시료량(원문)', '100 g'); set('제조번호(Lot)', 'L77');
    row.getCell(col('제조번호(Lot)')).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
    set('확인필요 항목', '제조번호(Lot): 손글씨가 흐림\n시료구분: 체크 위치 애매 (노란 칸 누락)\n시험항목: 별첨과 다름');
    wb.getWorksheet('시험항목').addRow(['A01', '벤조피렌', '', '']);
    const r = await X.importWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
    assert.strictEqual(r.orders.length, 1);
    const o = r.orders[0];
    assert.strictEqual(o.requester.mobile, '010-1234-5678');
    assert.deepStrictEqual(o.items.map((i) => i.name), ['벤조피렌']);
    assert.strictEqual(o.flags['sample.lot'], '손글씨가 흐림');
    assert.ok(o.flags['sample.kind'], '노란 칸이 없어도 적힌 확인 사유는 버리지 않음');
    assert.ok(o.flags.items);
  });
  await t('이 도우미가 저장한 엑셀은 노란 칸을 지우면 확인된 것으로 본다(기존 동작 유지)', async () => {
    const R = require('../src/model');
    const o = R.normalize({ id: 'Z1', requester: { name: '가나다', mobile: '010-1111-2222' }, purpose: 'x', sample: { name: 's', foodType: 'f', amountRaw: '1 g' }, items: [{ name: 'i' }], flags: { 'sample.lot': '흐림' } });
    o.flags = { 'sample.lot': '흐림' };
    const buf = await X.exportOrders([o]);
    let r = await X.importWorkbook(buf);
    assert.ok(r.orders[0].flags['sample.lot']);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
    const ws = wb.getWorksheet('접수'); const c = ws.getRow(1).values.indexOf('제조번호(Lot)');
    ws.getRow(2).getCell(c).fill = { type: 'pattern', pattern: 'none' };
    r = await X.importWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
    assert.ok(!r.orders[0].flags['sample.lot']);
  });

  console.log('서버 경로');
  const PORT = 18791;
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, PORT: String(PORT), KAFRI_DEMO: '1', ANTHROPIC_API_KEY: '' }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/state`); break; } catch { await new Promise((r) => setTimeout(r, 150)); } }
    const base = `http://127.0.0.1:${PORT}`;
    await t('POST /api/fixed (docx) → 2건 + 원본 글자 미리보기', async () => {
      const res = await fetch(base + '/api/fixed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'a.docx', data: fs.readFileSync(path.join(FX, '표준양식.docx')).toString('base64') }) });
      const j = await res.json();
      assert.strictEqual(res.status, 200); assert.strictEqual(j.orders.length, 2); assert.ok(j.preview.includes('업체명'));
    });
    await t('POST /api/fixed 실패는 코드와 인식 진단을 돌려준다', async () => {
      const z = new JSZip(); z.file('word/document.xml', '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>다른 문서</w:t></w:r></w:p></w:body></w:document>');
      const res = await fetch(base + '/api/fixed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'z.docx', data: (await z.generateAsync({ type: 'nodebuffer' })).toString('base64') }) });
      const j = await res.json();
      assert.strictEqual(res.status, 422); assert.strictEqual(j.code, 'NO_MATCH'); assert.ok(j.report);
    });
    await t('GET /api/template 은 엑셀, GET /api/claude-prompt 는 열 이름이 들어간 요청문', async () => {
      const r1 = await fetch(base + '/api/template');
      assert.strictEqual(r1.status, 200); assert.match(r1.headers.get('content-type'), /spreadsheetml/);
      const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await r1.arrayBuffer())); assert.ok(wb.getWorksheet('접수'));
      const j = await (await fetch(base + '/api/claude-prompt')).json();
      assert.ok(j.text.includes('접수ID | 원본파일') && !j.text.includes('{{COLUMNS}}'));
    });
    await t('다른 사이트에서 오는 요청은 거부', async () => {
      const res = await fetch(base + '/api/template', { headers: { Origin: 'http://evil.example' } });
      assert.strictEqual(res.status, 403);
    });

  await t('사용 안내서(guide.html)는 열린다(내 PC 모드)', async () => {
    const g = await fetch(`http://127.0.0.1:${PORT}/guide.html`);
    assert.strictEqual(g.status, 200); assert.ok((await g.text()).includes('접수 도우미 사용 안내'));
  });
  } finally { srv.kill(); }


  console.log('공유 서버 모드');
  const http = require('http');
  const cp = require('child_process');
  const os = require('os');
  const LOG = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-log-'));
  const start = async (port, env) => {
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, ANTHROPIC_API_KEY: '', KAFRI_DEMO: '1', LOG_DIR: LOG, ...env, PORT: String(port) }, stdio: 'ignore' });
    for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${port}/healthz`); return p; } catch { await new Promise((r) => setTimeout(r, 150)); } }
    return p;
  };
  const call = (port, method, p, { host, cookie, body, origin } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = { Host: host || 'intake.test', ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) };
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      const cs = []; res.on('data', (c) => cs.push(c));
      res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(cs).toString()); } catch { /* 본문 없음 */ } resolve({ status: res.statusCode, json: j, cookie: (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; '), headers: res.headers }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  const SP = 18793;
  const docx = fs.readFileSync(path.join(FX, '표준양식.docx')).toString('base64');
  const PW = 'test-password-1234';

  await t('공유 주소로 열면서 접속 비밀번호가 없으면 시작하지 않는다', async () => {
    const r = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, HOST: '0.0.0.0', PORT: '18794', ACCESS_PASSWORD: '', PUBLIC_URL: 'http://intake.test', LOG_DIR: LOG }, encoding: 'utf8', timeout: 8000 });
    assert.strictEqual(r.status, 1); assert.match(r.stderr, /ACCESS_PASSWORD/);
  });
  await t('프록시 뒤(TRUST_PROXY, 127.0.0.1)여도 비밀번호 없이는 시작하지 않는다', async () => {
    const r = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, HOST: '127.0.0.1', TRUST_PROXY: '1', PORT: '18794', ACCESS_PASSWORD: '', PUBLIC_URL: 'https://intake.test', LOG_DIR: LOG }, encoding: 'utf8', timeout: 8000 });
    assert.strictEqual(r.status, 1);
  });

  const sp = await start(SP, { HOST: '127.0.0.1', SHARED: '1', ACCESS_PASSWORD: PW, PUBLIC_URL: 'http://intake.test', ALLOWED_EMPLOYEES: '100123,100456' });
  try {
    await t('허용하지 않은 주소(Host)·다른 사이트(Origin) 요청은 거부, /healthz 는 허용', async () => {
      assert.strictEqual((await call(SP, 'GET', '/api/state', { host: 'evil.test' })).status, 403);
      assert.strictEqual((await call(SP, 'GET', '/api/state', { origin: 'http://evil.test' })).status, 403);
      assert.strictEqual((await call(SP, 'GET', '/healthz', { host: 'anything' })).status, 200);
    });
    let A;
    await t('비밀번호 전에는 상태만 보이고 변환·조회는 401', async () => {
      const s = await call(SP, 'GET', '/api/state');
      assert.strictEqual(s.json.accessRequired, true); assert.strictEqual(s.json.accessOk, false); assert.ok(s.cookie.startsWith('sid='));
      A = s.cookie;
      const f = await call(SP, 'POST', '/api/fixed', { cookie: A, body: { name: 'a.docx', data: docx } });
      assert.strictEqual(f.status, 401); assert.strictEqual(f.json.code, 'ACCESS');
      assert.strictEqual((await call(SP, 'GET', '/api/template', { cookie: A })).status, 401);
      assert.strictEqual((await call(SP, 'POST', '/api/excel/export', { cookie: A, body: { orders: [] } })).status, 401);
    });
    await t('틀린 비밀번호는 거부, 맞으면 변환 가능 + 쿠키는 HttpOnly·SameSite=Strict', async () => {
      assert.strictEqual((await call(SP, 'POST', '/api/access', { cookie: A, body: { password: 'nope' } })).status, 401);
      const ok = await call(SP, 'POST', '/api/access', { cookie: A, body: { password: PW } });
      assert.strictEqual(ok.status, 200);
      assert.strictEqual((await call(SP, 'POST', '/api/fixed', { cookie: A, body: { name: 'a.docx', data: docx } })).json.orders.length, 2);
      const raw = await new Promise((res) => http.get({ host: '127.0.0.1', port: SP, path: '/api/state', headers: { Host: 'intake.test' } }, (r) => res(r.headers['set-cookie'][0])));
      assert.match(raw, /HttpOnly/); assert.match(raw, /SameSite=Strict/);
    });
    await t('허용 목록에 없는 사번은 연결 거부, 있는 사번은 연결', async () => {
      assert.strictEqual((await call(SP, 'POST', '/api/login', { cookie: A, body: { employeeNo: '999999' } })).status, 403);
      const l = await call(SP, 'POST', '/api/login', { cookie: A, body: { employeeNo: '100123' } });
      assert.strictEqual(l.status, 200); assert.strictEqual(l.json.user.userId, '100123');
    });
    await t('사용자마다 세션이 분리된다 (B 는 A 의 사번 연결을 쓸 수 없다)', async () => {
      const B = (await call(SP, 'GET', '/api/state')).cookie;
      await call(SP, 'POST', '/api/access', { cookie: B, body: { password: PW } });
      const st = await call(SP, 'GET', '/api/state', { cookie: B });
      assert.strictEqual(st.json.user, null);
      assert.strictEqual((await call(SP, 'POST', '/api/company', { cookie: B, body: { name: '아무개' } })).status, 401);
      await call(SP, 'POST', '/api/login', { cookie: B, body: { employeeNo: '100456' } });
      assert.strictEqual((await call(SP, 'GET', '/api/state', { cookie: A })).json.user.userId, '100123');
      assert.strictEqual((await call(SP, 'GET', '/api/state', { cookie: B })).json.user.userId, '100456');
    });
    await t('접속 종료하면 같은 쿠키로 다시 들어갈 수 없다', async () => {
      assert.strictEqual((await call(SP, 'POST', '/api/signout', { cookie: A, body: {} })).status, 200);
      const f = await call(SP, 'POST', '/api/fixed', { cookie: A, body: { name: 'a.docx', data: docx } });
      assert.strictEqual(f.status, 401);
    });
    await t('비밀번호를 5번 틀리면 잠긴다 (맞는 비밀번호도 잠금 중에는 거부)', async () => {
      const C2 = (await call(SP, 'GET', '/api/state')).cookie;
      let last;
      for (let i = 0; i < 5; i++) last = await call(SP, 'POST', '/api/access', { cookie: C2, body: { password: 'bad' + i } });
      const locked = await call(SP, 'POST', '/api/access', { cookie: C2, body: { password: PW } });
      assert.strictEqual(locked.status, 429);
    });
    await t('접속 기록에 사번·동작은 남고 비밀번호·파일 이름은 남지 않는다', async () => {
      await new Promise((r) => setTimeout(r, 300));
      const txt = fs.readdirSync(LOG).filter((f) => f.startsWith('audit-')).map((f) => fs.readFileSync(path.join(LOG, f), 'utf8')).join('');
      assert.match(txt, /"event":"login"/); assert.match(txt, /"emp":"100123"/); assert.match(txt, /"event":"access_fail"/); assert.match(txt, /"event":"convert"/);
      assert.ok(!txt.includes(PW) && !txt.includes('bad0') && !txt.includes('a.docx') && !txt.includes('광동'));
    });
  } finally { sp.kill(); }

  const ip = await start(18795, { HOST: '127.0.0.1', SHARED: '1', ACCESS_PASSWORD: PW, PUBLIC_URL: 'http://intake.test', ALLOWED_IPS: '10.9.9.0/24' });
  try {
    await t('허용 IP 밖에서는 접속 자체를 거부한다', async () => {
      assert.strictEqual((await call(18795, 'GET', '/api/state')).status, 403);
      assert.strictEqual((await call(18795, 'GET', '/index.html')).status, 403);
    });
  } finally { ip.kill(); }
  const ip2 = await start(18796, { HOST: '127.0.0.1', SHARED: '1', ACCESS_PASSWORD: PW, PUBLIC_URL: 'http://intake.test', ALLOWED_IPS: '127.0.0.0/8' });
  try {
    await t('허용 IP 대역 안에서는 접속된다 (CIDR)', async () => { assert.strictEqual((await call(18796, 'GET', '/api/state')).status, 200); });
  } finally { ip2.kill(); fs.rmSync(LOG, { recursive: true, force: true }); }


  console.log(`\n${pass}개 통과${process.exitCode ? ', 실패 있음' : ''}`);
})();
