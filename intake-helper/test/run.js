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
  } finally { srv.kill(); }

  console.log(`\n${pass}개 통과${process.exitCode ? ', 실패 있음' : ''}`);
})();
