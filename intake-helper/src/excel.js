'use strict';
const ExcelJS = require('exceljs');
const M = require('./model');

const YELLOW = 'FFFFE45C';

/* 노란 계열 채움인지 (FFF2CC 같은 연노랑 포함) */
function isYellowFill(cell) {
  const f = cell.fill;
  if (!f || f.type !== 'pattern' || !f.fgColor || !f.fgColor.argb) return false;
  const hex = f.fgColor.argb.slice(-6);
  const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
  return r >= 235 && g >= 190 && b <= 215 && r - b >= 40;
}

function cellText(c) {
  const v = c.value;
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.text) return String(v.text);
    if (v.result != null) return String(v.result);
  }
  return String(v);
}

/* ── 새 양식 열 순서 ── */
const COLS = [
  ['접수ID', (o) => o.id],
  ['원본파일', (o) => (o.source.files || []).join(', ') + (o.source.pages ? ` (${o.source.pages})` : '')],
  ['의뢰일', (o) => o.requestDate, 'requestDate'],
  ['업체명', (o) => o.requester.name, 'requester.name'],
  ['대표자', (o) => o.requester.rep, 'requester.rep'],
  ['주소', (o) => o.requester.addr, 'requester.addr'],
  ['전화', (o) => o.requester.tel, 'requester.tel'],
  ['팩스', (o) => o.requester.fax, 'requester.fax'],
  ['핸드폰', (o) => o.requester.mobile, 'requester.mobile'],
  ['이메일', (o) => o.requester.email, 'requester.email'],
  ['의뢰인(담당)', (o) => o.requester.contact, 'requester.contact'],
  ['계산서 업체명', (o) => o.billing.name, 'billing.name'],
  ['사업자번호', (o) => o.billing.bizno, 'billing.bizno'],
  ['계산서 이메일', (o) => o.billing.email, 'billing.email'],
  ['계산서 담당자 연락처', (o) => o.billing.contact, 'billing.contact'],
  ['성적서 수령주소', (o) => o.report.addr, 'report.addr'],
  ['성적서 국문부수', (o) => o.report.korCopies, 'report.korCopies'],
  ['성적서 영문부수', (o) => o.report.engCopies, 'report.engCopies'],
  ['성적서 전달방법', (o) => o.report.delivery, 'report.delivery'],
  ['의뢰목적', (o) => o.purpose, 'purpose'],
  ['보관방법', (o) => o.storage, 'storage'],
  ['시료명', (o) => o.sample.name, 'sample.name'],
  ['식품유형', (o) => o.sample.foodType, 'sample.foodType'],
  ['시료구분', (o) => o.sample.kind, 'sample.kind'],
  ['시료량(원문)', (o) => o.sample.amountRaw, 'sample.amountRaw'],
  ['시료량', (o) => o.sample.amount, 'sample.amount'],
  ['시료단위', (o) => o.sample.unit, 'sample.unit'],
  ['제조번호(Lot)', (o) => o.sample.lot, 'sample.lot'],
  ['제조일자', (o) => o.sample.mfgDate, 'sample.mfgDate'],
  ['유통기한', (o) => o.sample.expDate, 'sample.expDate'],
  ['접수번호(의뢰서 표기)', (o) => o.receiptNoHint, 'receiptNoHint'],
  ['비고', (o) => o.remark, 'remark'],
  ['확인필요 항목', (o) => Object.entries(o.flags).map(([p, r]) => `${p}: ${r}`).join('\n')],
];
const HEADER_PATH = Object.fromEntries(COLS.filter((c) => c[2]).map((c) => [c[0], c[2]]));

async function exportOrders(orders) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '접수 도우미';
  wb.created = new Date();

  const head = (ws) => {
    const r = ws.getRow(1);
    r.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17212B' } };
    r.alignment = { vertical: 'middle' };
    r.height = 22;
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };

  const ws = wb.addWorksheet('접수');
  ws.addRow(COLS.map((c) => c[0]));
  head(ws);
  orders.forEach((o) => {
    const row = ws.addRow(COLS.map((c) => c[1](o) || ''));
    COLS.forEach((c, i) => {
      if (c[2] && o.flags && o.flags[c[2]]) row.getCell(i + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } };
    });
    row.alignment = { vertical: 'top', wrapText: true };
  });
  COLS.forEach((c, i) => { ws.getColumn(i + 1).width = Math.max(10, Math.min(36, c[0].length * 2 + 4)); });
  ws.getColumn(6).width = 34; ws.getColumn(16).width = 34; ws.getColumn(22).width = 34; ws.getColumn(COLS.length).width = 40;

  const wi = wb.addWorksheet('시험항목');
  wi.addRow(['접수ID', '시험항목', '기준', '비고']);
  head(wi);
  orders.forEach((o) => o.items.forEach((it) => wi.addRow([o.id, it.name, it.spec, it.note])));
  [14, 30, 28, 30].forEach((w, i) => { wi.getColumn(i + 1).width = w; });

  const wv = wb.addWorksheet('검증');
  wv.addRow(['접수ID', '수준', '항목', '내용']);
  head(wv);
  const lv = { error: '오류', review: '확인 필요', warn: '주의', info: '참고' };
  orders.forEach((o) => M.validate(o).forEach((i) => wv.addRow([o.id, lv[i.level] || i.level, i.path, i.msg])));
  [14, 12, 24, 70].forEach((w, i) => { wv.getColumn(i + 1).width = w; });

  const wg = wb.addWorksheet('안내');
  [
    ['항목', '내용'],
    ['접수 시트', '한 행이 접수 1건(시료 1건)입니다. 한 의뢰서에 시료가 여러 개면 의뢰서 공통 정보를 반복해서 행을 나눕니다.'],
    ['시험항목 시트', '접수ID로 접수 시트와 연결합니다. 한 접수의 시험항목마다 한 행입니다.'],
    ['노란 칸', '의뢰서 판독이 불확실해 사람이 확인해야 하는 칸입니다. 확인한 뒤 노란 채움을 지우고 접수 도우미에서 불러오면 확정 상태로 보입니다.'],
    ['검증 시트', '프로그램이 찾은 오류와 확인 사항입니다. 수정하지 않아도 되는 참고용 시트입니다.'],
    ['접수번호', '접수번호는 서버가 부여합니다. 의뢰서에 적힌 번호는 참고용으로만 보관합니다.'],
  ].forEach((r, i) => { const row = wg.addRow(r); if (i === 0) row.font = { bold: true }; });
  wg.getColumn(1).width = 16; wg.getColumn(2).width = 100;

  return wb.xlsx.writeBuffer();
}

async function importWorkbook(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const main = wb.getWorksheet('접수') || wb.getWorksheet('의뢰서목록') || wb.worksheets[0];
  if (!main) throw new Error('엑셀에 시트가 없습니다.');
  const itemsSheet = wb.getWorksheet('시험항목');

  const headers = [];
  main.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { headers[i] = cellText(c).trim(); });

  const itemsById = {};
  if (itemsSheet) {
    itemsSheet.eachRow((row, n) => {
      if (n === 1) return;
      const id = cellText(row.getCell(1)).trim();
      if (!id) return;
      (itemsById[id] = itemsById[id] || []).push({ name: cellText(row.getCell(2)).trim(), spec: cellText(row.getCell(3)).trim(), note: cellText(row.getCell(4)).trim() });
    });
  }

  const orders = [];
  const notes = [];
  main.eachRow((row, n) => {
    if (n === 1) return;
    const raw = {}; // path -> text
    const flagged = new Set();
    let itemName = '', itemSpec = '';
    headers.forEach((h, i) => {
      if (!h) return;
      const cell = row.getCell(i);
      const text = cellText(cell).trim();
      if (h === '시험항목') { itemName = text; if (isYellowFill(cell)) flagged.add('items'); return; }
      if (h === '기준') { itemSpec = text; return; }
      const path = M.LEGACY[h];
      if (!path) return;
      raw[path] = text;
      const fp = HEADER_PATH[h] || (path === 'report.copiesRaw' ? 'report.korCopies' : path);
      if (isYellowFill(cell) && path !== 'memo' && path !== 'id') flagged.add(fp);
    });
    if (!Object.values(raw).some(Boolean) && !itemName) return; // 빈 행

    const src = { requester: {}, billing: {}, report: {}, sample: {}, flags: {} };
    let fileName = '';
    Object.entries(raw).forEach(([p, v]) => {
      if (p === 'source.file') { fileName = v; return; }
      if (p === 'flagsText') return;
      M.setPath(src, p, v);
    });
    src.source = { files: fileName ? [fileName] : [], pages: '', note: '' };
    const id = src.id;
    let items = id && itemsById[id] ? itemsById[id] : M.splitItems(itemName, itemSpec);
    src.items = items;

    // 유통기한·제조일자의 '-' 는 normalize 에서 빈 값으로 바뀐다
    const o = M.normalize(src);

    // 접수번호 "(확인필요)" 꼬리표 제거, 판독 불확실이면 표시
    if (/확인\s*필요|불확실/.test(o.receiptNoHint)) {
      o.receiptNoHint = o.receiptNoHint.replace(/\(?\s*확인\s*필요\s*\)?/g, '').trim();
      o.flags.receiptNoHint = '손글씨 판독이 불확실합니다';
    }
    // 옛 양식의 비고(판독 메모)는 접수 비고로 쓰지 않고 메모로만 둔다
    if (o.memo) {
      const map = { '접수번호': 'receiptNoHint', '전달방법': 'report.delivery', '시료구분': 'sample.kind' };
      Object.entries(map).forEach(([k, p]) => { if (o.memo.includes(k) && /불확실|확인/.test(o.memo)) o.flags[p] = o.flags[p] || '판독이 불확실합니다. 원본과 대조하세요'; });
    }
    const reasons = {};
    if (raw.flagsText) raw.flagsText.split(/\r?\n/).forEach((l) => { const m = l.match(/^([\w.]+):\s*(.*)$/); if (m) reasons[m[1]] = m[2]; });
    flagged.forEach((p) => { if (!o.flags[p] || reasons[p]) o.flags[p] = reasons[p] || o.flags[p] || '엑셀에서 노란 칸으로 표시되어 있습니다'; });
    // 새 양식에서 노란 채움을 지웠다면 사람이 확인한 것으로 본다 (시료량 추정 표시는 유지)
    if (raw.flagsText !== undefined && id) {
      Object.keys(o.flags).forEach((p) => { if (!flagged.has(p) && p !== 'sample.amount') delete o.flags[p]; });
    }
    orders.push(o);
  });
  if (wb.getWorksheet('작성안내')) notes.push('옛 양식(의뢰서목록)을 새 양식으로 변환했습니다.');
  return { orders, notes, sheet: main.name };
}

module.exports = { exportOrders, importWorkbook };
