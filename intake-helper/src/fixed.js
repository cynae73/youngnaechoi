'use strict';
/*
 * B. 고정 양식 규칙 변환 — API 키 없이 docx · hwpx · 글자가 살아 있는 PDF 를 접수 모델로 바꾼다.
 *
 *  1) 문서를 "행(row) = 셀 글자들의 배열" 목록으로 펴고 (docx/hwpx 는 표·문단, PDF 는 글자 위치로 복원)
 *  2) rules/*.json 의 양식 규칙(라벨 사전)으로 "라벨 → 옆 칸 값" 을 찾아 접수 모델로 옮긴다.
 *
 * 규칙 파일만 고치면 다른 양식도 처리할 수 있다. 어디까지 읽었는지는 진단(report)으로 돌려준다.
 * 못 찾은 값은 추측하지 않고 비워 두며, 순서로만 판단한 값은 노란 칸(확인 필요)으로 표시한다.
 */
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const M = require('./model');

const RULES_DIR = path.join(__dirname, '..', 'rules');

/* ── 아주 작은 XML 파서 (docx · hwpx 용) ─────────────── */
function parseXml(xml) {
  const root = { name: '#root', attrs: {}, kids: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  const unesc = (s) => s.replace(/&(lt|gt|amp|quot|apos|#x[0-9a-fA-F]+|#\d+);/g, (_, e) => {
    if (e === 'lt') return '<'; if (e === 'gt') return '>'; if (e === 'amp') return '&'; if (e === 'quot') return '"'; if (e === 'apos') return "'";
    return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
  while ((m = re.exec(xml))) {
    if (m[1] !== undefined) { stack[stack.length - 1].kids.push({ text: m[1] }); continue; }
    if (m[6] !== undefined) { if (stack.length > 1) stack[stack.length - 1].kids.push({ text: unesc(m[6]) }); continue; }
    if (m[3] === undefined) continue;
    const name = m[3].replace(/^.*:/, '');
    if (m[2]) { if (stack.length > 1) stack.pop(); continue; }
    const attrs = {};
    (m[4] || '').replace(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (_, k, a, b) => { attrs[k.replace(/^.*:/, '')] = unesc(a !== undefined ? a : b); return ''; });
    const node = { name, attrs, kids: [] };
    stack[stack.length - 1].kids.push(node);
    if (!m[5]) stack.push(node);
  }
  return root;
}

const WING = { F0FE: '☑', F0FD: '☒', F078: '☒', F0A8: '☐', F06F: '☐' };

/* 문단 글자. 중첩 표는 따로 처리하므로 여기서는 건너뛴다. */
function paraText(node) {
  let s = '';
  (function walk(n) {
    if (n.text !== undefined) { s += n.text; return; }
    if (n.name === 'tbl' || n.name === 'Fallback') return;
    if (n.name === 'tab') { s += ' '; return; }
    if (n.name === 'br' || n.name === 'lineBreak') { s += '\n'; return; }
    if (n.name === 'sym' && n.attrs.char) { s += WING[n.attrs.char.toUpperCase()] || ''; return; }
    if (n.name === 'instrText' || n.name === 'delText') return;
    n.kids.forEach(walk);
  })(node);
  return s;
}

/* 문서 전체를 행 목록으로. 표 밖 문단은 한 칸짜리 행. */
function rowsFromXml(root) {
  const rows = [];
  const tableRows = (tbl) => {
    const out = [];
    (function findRows(n) {
      n.kids.forEach((k) => {
        if (k.name === 'tr') out.push(k);
        else if (k.name && k.name !== 'tc' && k.name !== 'tbl') findRows(k);
      });
    })(tbl);
    return out;
  };
  const cellParas = (tc, nested) => {
    const lines = [];
    (function walk(n) {
      n.kids.forEach((k) => {
        if (k.text !== undefined) return;
        if (k.name === 'Fallback') return;
        if (k.name === 'p') {
          const t = paraText(k).trim();
          if (t) lines.push(t);
          // 문단 안에 표가 들어 있는 경우(한글)와 중첩 표
          (function inner(x) { x.kids.forEach((y) => { if (y.name === 'tbl') nested.push(y); else if (y.name) inner(y); }); })(k);
        } else if (k.name === 'tbl') nested.push(k);
        else walk(k);
      });
    })(tc);
    return lines.join('\n');
  };
  const spanOf = (tc) => {
    let span = 1;
    (function f(n) {
      n.kids.forEach((k) => {
        if (!k.name) return;
        if (k.name === 'gridSpan' && k.attrs.val) span = Math.max(1, parseInt(k.attrs.val, 10) || 1);
        else if (k.name === 'cellSpan' && k.attrs.colSpan) span = Math.max(1, parseInt(k.attrs.colSpan, 10) || 1);
        else if (k.name !== 'p' && k.name !== 'subList' && k.name !== 'tbl') f(k);
      });
    })(tc);
    return span;
  };
  const doTable = (tbl) => {
    tableRows(tbl).forEach((tr) => {
      const cells = [];
      const nested = [];
      tr.kids.forEach((tc) => {
        if (tc.name !== 'tc') return;
        cells.push(cellParas(tc, nested));
        for (let i = 1; i < spanOf(tc); i++) cells.push('');
      });
      if (cells.some(Boolean)) rows.push(cells);
      nested.forEach(doTable);
    });
  };
  (function walk(n) {
    n.kids.forEach((k) => {
      if (!k.name) return;
      if (k.name === 'Fallback') return;
      if (k.name === 'tbl') { doTable(k); return; }
      if (k.name === 'p') {
        const t = paraText(k).trim();
        const tbls = [];
        (function inner(x) { x.kids.forEach((y) => { if (y.name === 'tbl') tbls.push(y); else if (y.name) inner(y); }); })(k);
        if (t) rows.push([t]);
        tbls.forEach(doTable);
        return;
      }
      walk(k);
    });
  })(root);
  return rows;
}

async function readZipDoc(buf, kind) {
  let zip;
  try { zip = await JSZip.loadAsync(buf); } catch { throw Object.assign(new Error('문서 파일을 열 수 없습니다. 손상되었거나 암호가 걸려 있을 수 있습니다.'), { code: 'BAD_FILE' }); }
  if (kind === 'docx') {
    const f = zip.file('word/document.xml');
    if (!f) throw Object.assign(new Error('docx 형식이 아닙니다.'), { code: 'BAD_FILE' });
    return rowsFromXml(parseXml(await f.async('string')));
  }
  const names = Object.keys(zip.files).filter((n) => /^Contents\/section\d+\.xml$/i.test(n)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  if (!names.length) {
    if (zip.file('Contents/content.hpf') === null && !Object.keys(zip.files).some((n) => /\.xml$/i.test(n))) throw Object.assign(new Error('hwpx 형식이 아닙니다.'), { code: 'BAD_FILE' });
    throw Object.assign(new Error('hwpx 안에서 본문을 찾지 못했습니다.'), { code: 'BAD_FILE' });
  }
  let rows = [];
  for (const n of names) rows = rows.concat(rowsFromXml(parseXml(await zip.file(n).async('string'))));
  return rows;
}

/* ── PDF (글자 층이 있는 것만) ─────────────────────── */
let pdfjs = null;
async function readPdf(buf) {
  if (!pdfjs) {
    // 화면 그리기용 부품이 없다는 경고를 막는다(글자만 읽으므로 필요 없음)
    if (typeof globalThis.DOMMatrix === 'undefined') globalThis.DOMMatrix = class DOMMatrix {};
    if (typeof globalThis.Path2D === 'undefined') globalThis.Path2D = class Path2D {};
    pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  }
  const cMapUrl = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'cmaps') + path.sep;
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(buf), cMapUrl, cMapPacked: true, useSystemFonts: false, verbosity: 0, isEvalSupported: false }).promise;
  } catch (e) {
    throw Object.assign(new Error(`PDF 를 열 수 없습니다: ${e.message}`), { code: 'BAD_FILE' });
  }
  const rows = [];
  let chars = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent({ disableCombineTextItems: true });
    const items = tc.items.filter((i) => i.str && i.str.trim() !== '' || (i.str === ' ')).map((i) => ({ s: i.str, x: i.transform[4], y: i.transform[5], w: i.width, h: Math.abs(i.height) || Math.abs(i.transform[3]) || 10 }));
    chars += items.reduce((a, i) => a + i.s.trim().length, 0);
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    items.forEach((it) => {
      const ln = lines.find((l) => Math.abs(l.y - it.y) <= Math.max(2, it.h * 0.45));
      if (ln) ln.items.push(it); else lines.push({ y: it.y, items: [it] });
    });
    lines.sort((a, b) => b.y - a.y).forEach((ln) => {
      ln.items.sort((a, b) => a.x - b.x);
      const cells = [];
      const xs = [];
      let curText = '', end = null, brk = false;
      ln.items.forEach((it) => {
        // 칸 사이의 넓은 공백은 pdf.js 가 폭이 큰 공백 조각으로 돌려준다
        if (!it.s.trim()) { if (it.w > Math.max(5, it.h * 0.6)) brk = true; else curText += ' '; end = it.x + it.w; return; }
        const gap = end == null ? 0 : it.x - end;
        if (end != null && (brk || gap > Math.max(5, it.h * 0.6)) && curText.trim()) { cells.push(curText.trim()); curText = ''; }
        brk = false;
        if (!curText) xs.push(it.x);
        curText += it.s;
        end = it.x + it.w;
      });
      cells.push(curText.trim());
      const keep = cells.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
      if (keep.length) { const row = keep.map((i) => cells[i]); row.xs = keep.map((i) => xs[i]); rows.push(row); }
    });
  }
  if (chars < 30) throw Object.assign(new Error('이 PDF 에는 글자 정보가 없습니다(스캔본·사진 PDF). 이 경우는 "Claude 앱으로 변환"을 이용하세요.'), { code: 'NO_TEXT' });
  return rows;
}

/* ── 규칙 ────────────────────────────────────────────── */
function loadProfiles() {
  if (!fs.existsSync(RULES_DIR)) return [];
  return fs.readdirSync(RULES_DIR).filter((f) => /\.json$/i.test(f) && !f.startsWith('_')).sort().map((f) => {
    try { const p = JSON.parse(fs.readFileSync(path.join(RULES_DIR, f), 'utf8')); p.file = f; return p; }
    catch (e) { throw new Error(`rules/${f} 를 읽을 수 없습니다: ${e.message}`); }
  });
}

/* 라벨 비교용 정규화: 괄호 설명 제거, 공백·기호 제거, / 로 나뉜 표기는 각각 비교 */
const labelParts = (s) => String(s || '').toLowerCase().replace(/\(.*?\)|（.*?）|\[.*?\]/g, '').split(/[/·,|]/)
  .map((x) => x.replace(/[\s:：*\-_. ]/g, '')).filter(Boolean);
const MARK_ON = '■☑☒✔✓▣◼⬛●◉';
const MARK_OFF = '□☐▢◻⬜○◯';
const MARK_RE = new RegExp(`[${MARK_ON}${MARK_OFF}]`, 'g');

function parseChecks(text) {
  const t = String(text || '');
  if (!MARK_RE.test(t)) { MARK_RE.lastIndex = 0; return { marked: false, picked: [], text: t.trim() }; }
  MARK_RE.lastIndex = 0;
  const picked = [];
  const re = new RegExp(`([${MARK_ON}${MARK_OFF}])\\s*([^${MARK_ON}${MARK_OFF}]*)`, 'g');
  let m;
  while ((m = re.exec(t))) { if (MARK_ON.includes(m[1])) { const v = m[2].trim().replace(/[,，;\s]+$/, ''); if (v) picked.push(v); } }
  return { marked: true, picked, text: t.trim() };
}

function compile(profile) {
  const fields = (profile.fields || []).map((f) => ({ ...f, parts: new Set((f.labels || []).flatMap(labelParts)) }));
  const sections = (profile.sections || []).map((s) => ({ ...s, parts: new Set((s.match || []).flatMap(labelParts)) }));
  const cols = Object.entries((profile.sampleTable && profile.sampleTable.columns) || {}).map(([key, labels]) => ({ key, parts: new Set(labels.flatMap(labelParts)) }));
  const itemCols = Object.entries((profile.itemTable && profile.itemTable.columns) || {}).map(([key, labels]) => ({ key, parts: new Set(labels.flatMap(labelParts)) }));
  return { profile, fields, sections, cols, itemCols };
}
const hit = (cell, parts) => labelParts(cell).some((p) => parts.has(p));
const matchCol = (cols, cell) => (cell && cell.length <= 40 ? cols.find((c) => hit(cell, c.parts)) : null);

function isLabel(C, cell) {
  if (!cell || cell.length > 40) return false;
  return C.fields.some((f) => hit(cell, f.parts)) || C.sections.some((s) => hit(cell, s.parts))
    || C.cols.some((c) => hit(cell, c.parts));
}

const clean = (v) => String(v || '').replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim();

/* 한 문서를 한 규칙으로 읽는다 */
function applyProfile(rows, C) {
  const got = {};        // path -> value
  const flags = {};      // path -> reason
  const seen = new Set();
  let regions = [];      // [{ at: 열 위치, id }] — 구역 머리글이 놓인 열부터 오른쪽 아래로 적용
  const skipRow = new Set();
  const orders = [];

  /* 시료 표 (시료명 · 식품유형 · 시료량 … 열 제목이 있는 표) */
  let sampleRows = [];
  if (C.cols.length) {
    for (let r = 0; r < rows.length; r++) {
      const map = {};
      rows[r].forEach((cell, i) => { const c = matchCol(C.cols, cell); if (c && !(c.key in map)) map[c.key] = i; });
      const keys = Object.keys(map);
      const need = (C.profile.sampleTable && C.profile.sampleTable.minColumns) || 3;
      if (keys.length >= need && (keys.includes('sample.name') || keys.includes('items'))) {
        skipRow.add(r);
        for (let q = r + 1; q < rows.length; q++) {
          const row = rows[q];
          const first = row.find(Boolean);
          const rowHasData = row.xs ? row.some(Boolean) : Object.values(map).some((i) => clean(row[i]));
          if (!rowHasData) {
            if (first && (isLabel(C, first) || row.length === 1)) break; // 표가 끝나고 다른 항목이 시작됨
            skipRow.add(q); continue; // 빈 칸으로 남겨 둔 행
          }
          if (first && C.fields.some((f) => !f.path.startsWith('sample.') && f.path !== 'items' && hit(first, f.parts)) && !Object.values(map).some((i) => i === row.indexOf(first))) break;
          skipRow.add(q);
          const rec = {};
          if (row.xs && rows[r].xs) {
            // PDF: 빈 칸은 글자가 없어 사라지므로 열 제목의 가로 위치로 칸을 맞춘다
            const hx = Object.entries(map).map(([k, i]) => ({ k, x: rows[r].xs[i] })).sort((a, b) => a.x - b.x);
            Object.keys(map).forEach((k) => { rec[k] = ''; });
            row.forEach((cell, ci) => {
              const cand = hx.filter((h) => h.x <= row.xs[ci] + 4);
              const col = cand.length ? cand[cand.length - 1].k : hx[0].k;
              rec[col] = rec[col] ? `${rec[col]}\n${cell}` : cell;
            });
          } else Object.entries(map).forEach(([k, i]) => { rec[k] = row[i] == null ? '' : row[i]; });
          sampleRows.push(rec);
        }
        break;
      }
    }
  }

  /* 시험항목 표 (시험항목 · 기준 열 제목만 있는 표) */
  const tableItems = [];
  if (C.itemCols.length) {
    for (let r = 0; r < rows.length; r++) {
      if (skipRow.has(r)) continue;
      const map = {};
      rows[r].forEach((cell, i) => { const c = matchCol(C.itemCols, cell); if (c && !(c.key in map)) map[c.key] = i; });
      if (map.name != null && Object.keys(map).length >= 2) {
        skipRow.add(r);
        for (let q = r + 1; q < rows.length; q++) {
          const row = rows[q];
          const name = clean(row[map.name]);
          const first = row.find(Boolean);
          if (!name) { if (first && isLabel(C, first)) break; if (!first) { skipRow.add(q); continue; } break; }
          if (isLabel(C, first) && first === row[0] && row.filter(Boolean).length <= 2 && !map.spec) break;
          skipRow.add(q);
          tableItems.push({ name, spec: clean(row[map.spec]), note: clean(row[map.note]) });
        }
        break;
      }
    }
  }

  /* 라벨 → 값 */
  rows.forEach((row, r) => {
    if (skipRow.has(r)) return;
    const posOf = (i) => (row.xs ? row.xs[i] : i);
    const secAt = (i) => {
      const oneLine = clean(row[i]);
      if (!oneLine) return null;
      const sec = C.sections.find((s) => oneLine.length <= 20 && hit(oneLine, s.parts));
      if (!sec) return null;
      const nextVal = row.slice(i + 1).find(Boolean);
      const asField = C.fields.some((f) => oneLine.length <= 40 && hit(oneLine, f.parts));
      return !asField || !nextVal || isLabel(C, nextVal) ? sec : null;
    };
    const heads = row.map((_, i) => ({ i, sec: secAt(i) })).filter((x) => x.sec);
    if (heads.length) {
      const first = Math.min(...heads.map((x) => posOf(x.i)));
      regions = regions.filter((g) => g.at < first - 0.5);
      heads.forEach((x) => regions.push({ at: posOf(x.i), id: x.sec.id }));
    }
    const sectionAt = (i) => {
      const p = posOf(i);
      const g = regions.filter((x) => x.at <= p + 0.5).sort((a, b) => b.at - a.at)[0];
      return g ? g.id : null;
    };
    for (let i = 0; i < row.length; i++) {
      const cell = row[i];
      if (!cell) continue;
      const oneLine = clean(cell);
      if (!oneLine) continue;
      if (heads.some((x) => x.i === i)) continue;
      const section = sectionAt(i);
      const asField = C.fields.filter((f) => oneLine.length <= 40 && hit(oneLine, f.parts));

      let cands = asField;
      let inline = '';
      if (!cands.length) {
        // "라벨: 값" 이 한 칸에 있는 경우 (여러 줄이면 줄마다)
        const lines = String(cell).split('\n');
        let used = false;
        lines.forEach((ln) => {
          const m = ln.match(/^\s*([^:：]{1,24})[:：]\s*(.+)$/);
          if (!m) return;
          const cs = C.fields.filter((f) => hit(m[1], f.parts));
          if (cs.length) { used = true; place(cs, m[2], ln, section); }
        });
        if (used) continue;
        // "의뢰목적 ■ 품질관리 □ 연구" 처럼 라벨 뒤에 바로 이어지는 경우
        const mm = oneLine.match(/^(.{2,12}?)\s+([■□☑☒✔✓▣☐].*)$/);
        if (mm) { const cs = C.fields.filter((f) => f.type === 'check' && hit(mm[1], f.parts)); if (cs.length) { place(cs, mm[2], oneLine, section); continue; } }
        continue;
      }

      // 라벨 칸: 오른쪽 칸들에서 값 찾기
      const check = asField.every((f) => f.type === 'check');
      let val = '';
      let j = i + 1;
      if (check) {
        const parts = [];
        for (; j < row.length; j++) { if (row[j] && isLabel(C, row[j]) && !/[■□☑☒✔✓▣☐]/.test(row[j])) break; if (row[j]) parts.push(row[j]); }
        val = parts.join(' ');
        i = j - 1;
      } else {
        for (; j < row.length; j++) { if (row[j] && clean(row[j])) break; }
        if (j < row.length && !isLabel(C, row[j])) { val = row[j]; i = j; }
        else if (j < row.length) { i = j - 1; }
      }
      place(cands, val, oneLine, section);
    }

    function place(cands, rawVal, labelText, section) {
      // 같은 라벨이 여러 구역에 있으면 지금 구역을 우선, 구역을 모르면 먼저 나온 순서
      let pick = cands.find((c) => c.section === section && !seen.has(c.path));
      let byOrder = false;
      if (!pick) {
        pick = cands.find((c) => !c.section && !seen.has(c.path));
        if (!pick) { pick = cands.find((c) => !seen.has(c.path)); byOrder = !!(pick && pick.section && cands.length > 1); }
      }
      if (!pick) return;
      seen.add(pick.path);
      const text = pick.type === 'items' ? String(rawVal || '').trim() : clean(rawVal);
      if (!text) { if (pick.path[0] !== '_') got[pick.path] = ''; return; }
      let v = text;
      if (pick.type === 'check') {
        const c = parseChecks(text);
        if (c.marked) {
          v = c.picked.join(', ');
          if (!c.picked.length) flags[pick.path] = '선택(■)된 칸을 찾지 못했습니다. 원본을 확인하세요';
          else if (c.picked.length > 1 && !pick.multi) flags[pick.path] = `여러 칸이 선택되어 있습니다: ${v}`;
        } else v = c.text;
      }
      got[pick.path] = v;
      if (byOrder) flags[pick.path] = '양식의 구역(의뢰인·계산서 등)을 확인하지 못해 나온 순서로 판단했습니다. 원본과 대조하세요';
    }
  });

  /* 접수 만들기 */
  const common = {};
  Object.entries(got).forEach(([p, v]) => { if (p[0] !== '_') M.setPath(common, p, v); });
  const itemsFrom = (nameCell, specCell) => M.splitItems(nameCell, specCell);

  const build = (rec) => {
    const src = JSON.parse(JSON.stringify(common));
    src.requester = src.requester || {}; src.billing = src.billing || {}; src.report = src.report || {}; src.sample = src.sample || {};
    let items = [];
    if (rec) {
      Object.entries(rec).forEach(([k, v]) => {
        if (k === 'items' || k === 'spec') return;
        const t = clean(v);
        if (t) M.setPath(src, k, t);
      });
      items = itemsFrom(rec.items, rec.spec);
    }
    if (!items.length && typeof common.items === 'string') items = itemsFrom(common.items, '');
    if (!items.length && tableItems.length) items = tableItems;
    src.items = items;
    src.flags = { ...flags };
    return src;
  };
  if (sampleRows.length) sampleRows.forEach((rec) => orders.push(build(rec)));
  else if (Object.keys(got).length) orders.push(build(null));

  const matched = Object.entries(got).filter(([p, v]) => p[0] !== '_' && v).map(([p]) => p);
  const wanted = C.fields.filter((f) => f.path[0] !== '_').map((f) => f.path);
  const missing = [...new Set(wanted)].filter((p) => !matched.includes(p) && p !== 'items' && !(p.startsWith('sample.') && sampleRows.length));
  return { orders, matched, missing, sampleRows: sampleRows.length, tableItems: tableItems.length };
}

const pathName = (p) => { const f = M.FIELDS.find((x) => x.path === p); return f ? f.label : p; };

/* 문서(바이트)를 접수 목록으로 */
async function convert(buf, fileName) {
  const ext = (path.extname(fileName || '').slice(1) || '').toLowerCase();
  let rows;
  if (ext === 'docx') rows = await readZipDoc(buf, 'docx');
  else if (ext === 'hwpx') rows = await readZipDoc(buf, 'hwpx');
  else if (ext === 'pdf') rows = await readPdf(buf);
  else if (ext === 'hwp' || ext === 'doc') throw Object.assign(new Error(`.${ext} 는 읽을 수 없습니다. 한글/워드에서 ${ext === 'hwp' ? 'hwpx' : 'docx'} 로 다시 저장해 주세요.`), { code: 'BAD_FILE' });
  else throw Object.assign(new Error('docx, hwpx, PDF(글자 있는 것)만 읽을 수 있습니다.'), { code: 'BAD_FILE' });
  return convertRows(rows, fileName);
}

function convertRows(rows, fileName) {
  const profiles = loadProfiles();
  if (!profiles.length) throw Object.assign(new Error('rules 폴더에 양식 규칙(.json)이 없습니다.'), { code: 'NO_RULES' });
  const plain = rows.map((r) => r.join(' ')).join('\n').replace(/\s+/g, '').toLowerCase();
  let best = null;
  profiles.forEach((p) => {
    const C = compile(p);
    const res = applyProfile(rows, C);
    const sig = (p.signature || []).filter((s) => plain.includes(String(s).replace(/\s+/g, '').toLowerCase())).length;
    const score = res.matched.length + (res.orders.length ? 3 : 0) + sig * 2;
    if (!best || score > best.score) best = { p, res, score, sig };
  });
  const { p, res } = best;
  const min = p.minMatched || 4;
  const hasKey = res.matched.includes('requester.name') || res.matched.includes('sample.name') || res.sampleRows > 0;
  if (res.matched.length < min || !hasKey || !res.orders.length) {
    throw Object.assign(new Error(`고정 양식과 맞지 않습니다(인식 ${res.matched.length}개 항목). 양식이 다르거나 사진·스캔본이면 "Claude 앱으로 변환"을 이용하세요.`), { code: 'NO_MATCH', report: { profile: p.name, matched: res.matched.map(pathName), missing: res.missing.map(pathName) } });
  }
  const names = [fileName];
  const orders = res.orders.map((raw) => M.normalize({ ...raw, source: { files: names, pages: '', note: `고정 양식 규칙 변환(${p.name})` } }));
  // 정규화 뒤에도 flags 는 경로 기준으로 유지된다. 빈 칸은 검증 단계에서 오류/참고로 안내된다.
  const miss = res.missing.map(pathName);
  const notes = `양식 "${p.name}" 로 ${res.matched.length}개 항목을 읽었습니다.${miss.length ? ` 못 찾은 항목: ${miss.join(', ')}.` : ''}`;
  const preview = rows.map((r) => r.join('  |  ')).join('\n').slice(0, 30000);
  return { orders, notes, preview, report: { profile: p.name, file: p.file, matched: res.matched.map(pathName), missing: miss, orders: orders.length } };
}

module.exports = { convert, convertRows, readZipDoc, readPdf, parseChecks, loadProfiles };

/* 개발용: node src/fixed.js dump|run <파일>  — 펼친 표를 보거나 변환 결과를 확인한다 */
if (require.main === module) {
  (async () => {
    const [cmd, file] = process.argv.slice(2);
    if (!cmd || !file) { console.log('사용법: node src/fixed.js dump|run <docx|hwpx|pdf 파일>'); return; }
    const buf = fs.readFileSync(file);
    const ext = path.extname(file).slice(1).toLowerCase();
    if (cmd === 'dump') {
      const rows = ext === 'pdf' ? await readPdf(buf) : await readZipDoc(buf, ext);
      rows.forEach((r, i) => console.log(String(i).padStart(3), JSON.stringify(r)));
    } else {
      const out = await convert(buf, path.basename(file));
      console.log(out.notes);
      out.orders.forEach((o) => console.log(JSON.stringify(o, null, 1)));
    }
  })().catch((e) => { console.error('오류:', e.message, e.report ? JSON.stringify(e.report) : ''); process.exit(1); });
}
