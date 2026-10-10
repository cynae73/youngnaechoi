(() => {
'use strict';
const M = window.IntakeModel;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* 작은 DOM 헬퍼. 사용자 값은 항상 textContent 로만 넣는다. */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([k, v]) => {
    if (v == null || v === false) return;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'disabled' || k === 'hidden' || k === 'checked' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  });
  kids.flat().forEach((c) => { if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c))); });
  return el;
}

const S = {
  stage: 'load', orders: [], sel: null, filter: 'all',
  previews: {},          // 파일 키 -> { url, type, name }
  hist: {},              // 접수ID -> 업체 조회 결과
  dup: {},               // 접수ID -> 중복 조회 결과
  state: { demo: false, hasKey: false, user: null },
  viewer: { scale: 1, rot: 0, idx: 0 },
  dry: null,
};

/* ── 통신 ─────────────────────────────────────────── */
async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch { /* 본문 없음 */ }
  if (!res.ok) { const e = new Error((data && data.error) || `요청 실패 (HTTP ${res.status})`); e.status = res.status; e.code = data && data.code; throw e; }
  return data;
}
let toastT = null;
function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg; t.classList.toggle('is-bad', !!bad); t.classList.add('is-on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('is-on'), bad ? 5200 : 2800);
}

/* ── 상태 계산 ─────────────────────────────────────── */
const LABEL = { review: '확인 필요', error: '오류', ready: '확정', pending: '미검토', done: '완료' };
const LV = { error: '오류', review: '확인 필요', warn: '주의', info: '참고' };
const cur = () => S.orders.find((o) => o.id === S.sel) || null;
function info(o) { const issues = M.validate(o); return { issues, s: M.stateOf(o, issues) }; }
function counts() {
  const c = { review: 0, error: 0, ready: 0, pending: 0, done: 0 };
  S.orders.forEach((o) => { c[info(o).s] += 1; });
  return c;
}
const pathLabel = (p) => { const f = M.FIELDS.find((x) => x.path === p); return f ? f.label : (p.startsWith('items') ? '시험항목' : p); };

/* ── 단계 전환 ─────────────────────────────────────── */
function go(stage) {
  S.stage = stage;
  $$('.stage').forEach((s) => { s.hidden = s.id !== `stage-${stage}`; });
  $$('.step').forEach((b) => { b.classList.toggle('is-on', b.dataset.stage === stage); b.toggleAttribute('aria-current', b.dataset.stage === stage); });
  if (stage === 'review') renderReview();
  if (stage === 'register') renderRegister();
  renderRail();
}
function renderRail() {
  const c = counts();
  $('#cReview').textContent = S.orders.length ? `${S.orders.length}건` : '';
  $('#cRegister').textContent = c.ready ? `${c.ready}건` : '';
  $('#btnExport').disabled = !S.orders.length;
}

/* ── 상단 상태 ─────────────────────────────────────── */
function renderChips() {
  const u = S.state.user;
  const c = $('#chipConn');
  c.textContent = u ? `${S.state.demo ? '데모 ' : ''}연결됨 ${u.userId}${u.userNm ? ' ' + u.userNm : ''}` : '서버 연결 안 됨';
  c.classList.toggle('is-on', !!u);
  const a = $('#chipAi');
  a.textContent = S.state.hasKey ? 'AI 읽기 사용 가능' : 'AI 키 없음: 엑셀만 가능';
  a.classList.toggle('is-on', S.state.hasKey);
  const n = $('#aiNote');
  n.hidden = S.state.hasKey;
  n.textContent = '이 PC에 AI 키가 설정되어 있지 않아 사진·PDF는 읽을 수 없습니다. 엑셀 불러오기를 쓰거나, 폴더의 .env 파일에 ANTHROPIC_API_KEY 를 넣고 다시 실행하세요.';
}
async function refreshState() { S.state = await api('/api/state'); renderChips(); }

/* ── 파일 준비 (브라우저에서 줄여 보낸다) ──────────── */
const b64 = (buf) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
async function prepFile(file, key) {
  const name = key || file.name;
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    if (file.size > 30 * 1024 * 1024) throw new Error(`${file.name}: PDF 가 30MB 를 넘습니다.`);
    S.previews[name] = { url: URL.createObjectURL(file), type: 'pdf', name };
    return { name, mediaType: 'application/pdf', data: b64(await file.arrayBuffer()) };
  }
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { throw new Error(`${file.name}: 이미지를 열 수 없습니다 (JPG, PNG, WEBP 만 가능).`); }
  const max = 2200, k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.88));
  S.previews[name] = { url: URL.createObjectURL(blob), type: 'img', name };
  return { name, mediaType: 'image/jpeg', data: b64(await blob.arrayBuffer()) };
}

/* ── 읽기 대기열 ───────────────────────────────────── */
const jobs = [];
let running = 0;
const isReadable = (f) => /\.(jpe?g|png|webp|gif|pdf)$/i.test(f.name) || /^image\//.test(f.type) || f.type === 'application/pdf';
const natural = (a, b) => a.localeCompare(b, 'ko', { numeric: true });

function enqueue(list) {
  if (!S.state.hasKey) { toast('AI 키가 없어 사진·PDF를 읽을 수 없습니다. 엑셀을 불러오세요.', true); return; }
  list.forEach((j) => jobs.push({ ...j, state: 'wait', msg: '', count: 0 }));
  $('#queueWrap').hidden = false;
  renderQueue(); pump();
}
function renderQueue() {
  const q = $('#queue'); q.replaceChildren();
  const label = { wait: '대기', run: '읽는 중', done: '완료', err: '실패' };
  jobs.forEach((j) => {
    const li = h('li', null,
      h('span', { class: 'q-name', title: j.label }, j.label),
      h('span', { class: j.state === 'err' ? 'bad' : j.state === 'done' ? 'ok' : '' }, label[j.state]),
      h('span', { class: 'num' }, j.state === 'done' ? `${j.count}건` : ''));
    if (j.msg) li.append(h('span', { class: 'q-err', role: 'alert' }, j.msg));
    q.append(li);
  });
  const done = jobs.filter((j) => j.state === 'done' || j.state === 'err').length;
  $('#barFill').style.width = jobs.length ? `${(done / jobs.length) * 100}%` : '0';
  $('#queueSum').textContent = `${done} / ${jobs.length}`;
}
async function pump() {
  while (running < 2) {
    const j = jobs.find((x) => x.state === 'wait');
    if (!j) break;
    j.state = 'run'; running += 1; renderQueue();
    runJob(j).finally(() => { running -= 1; renderQueue(); pump(); });
  }
}
async function runJob(j) {
  try {
    const files = [];
    for (const f of j.files) files.push(await prepFile(f.file, f.key));
    const out = await api('/api/extract', { files });
    out.orders.forEach((o) => { o.source.note = out.notes || ''; S.orders.push(o); });
    j.count = out.orders.length; j.state = 'done';
    if (!out.orders.length) { j.state = 'err'; j.msg = out.notes || '접수 정보를 찾지 못했습니다.'; }
    if (!S.sel && S.orders.length) S.sel = S.orders[0].id;
  } catch (e) { j.state = 'err'; j.msg = e.message; }
  renderRail();
  if (jobs.every((x) => x.state === 'done' || x.state === 'err')) {
    const n = S.orders.length;
    if (n) toast(`${n}건을 읽었습니다. 검토로 이동합니다.`);
    if (n) go('review');
  }
}

function handleFiles(files) {
  const list = [...files].filter(isReadable).sort((a, b) => natural(a.name, b.name));
  if (!list.length) { toast('사진(JPG·PNG·WEBP) 또는 PDF 파일을 선택하세요.', true); return; }
  const mode = $('input[name=gm]:checked').value;
  if (mode === 'bundle' && list.length > 1) enqueue([{ label: `${list[0].name} 외 ${list.length - 1}개`, files: list.map((f) => ({ file: f, key: f.name })) }]);
  else enqueue(list.map((f) => ({ label: f.name, files: [{ file: f, key: f.name }] })));
}
function handleFolder(files) {
  const all = [...files].filter(isReadable);
  if (!all.length) { toast('폴더에서 사진이나 PDF를 찾지 못했습니다.', true); return; }
  const groups = new Map();
  all.forEach((f) => {
    const parts = (f.webkitRelativePath || f.name).split('/');
    const key = parts.length >= 3 ? parts.slice(0, 2).join('/') : f.webkitRelativePath || f.name;
    (groups.get(key) || groups.set(key, []).get(key)).push(f);
  });
  const list = [...groups.entries()].sort((a, b) => natural(a[0], b[0])).map(([key, fs]) => ({
    label: fs.length > 1 ? `${key} (${fs.length}개 파일)` : key,
    files: fs.sort((a, b) => natural(a.name, b.name)).map((f) => ({ file: f, key: f.webkitRelativePath || f.name })),
  }));
  enqueue(list);
}
async function handleExcel(file) {
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const out = await api('/api/excel/import', { data: b64(buf), name: file.name });
    if (!out.orders.length) { toast('엑셀에서 접수 행을 찾지 못했습니다.', true); return; }
    out.orders.forEach((o) => S.orders.push(o));
    if (!S.sel) S.sel = out.orders[0].id;
    toast(`${out.orders.length}건을 불러왔습니다.${out.notes && out.notes[0] ? ' ' + out.notes[0] : ''}`);
    go('review');
  } catch (e) { toast(`엑셀을 불러오지 못했습니다: ${e.message}`, true); }
}

/* ── 검토: 머리·띠·목록 ───────────────────────────── */
function renderReview() {
  const c = counts();
  $('#tally').replaceChildren(
    h('span', null, '전체 ', h('b', null, S.orders.length), '건'),
    h('span', null, '확정 ', h('b', null, c.ready)),
    h('span', null, '확인 필요 ', h('b', null, c.review)),
    h('span', null, '오류 ', h('b', null, c.error)),
    h('span', null, '미검토 ', h('b', null, c.pending)));
  const rb = $('#ribbon'); rb.replaceChildren(); rb.hidden = S.orders.length < 2;
  S.orders.forEach((o, i) => {
    const s = info(o).s;
    rb.append(h('button', { type: 'button', class: 'seg-cell' + (o.id === S.sel ? ' is-sel' : ''), 'data-s': s, role: 'listitem', title: `${i + 1}. ${o.requester.name || '업체명 없음'}: ${LABEL[s]}`, 'aria-label': `${i + 1}번 ${LABEL[s]}`, onclick: () => select(o.id) }));
  });
  renderList(); renderDetail();
  $$('.f').forEach((b) => b.classList.toggle('is-on', b.dataset.f === S.filter));
}
function visible() { return S.orders.filter((o) => S.filter === 'all' || info(o).s === S.filter); }
function renderList() {
  const l = $('#list'); l.replaceChildren();
  const v = visible();
  if (!v.length) {
    l.append(h('div', { class: 'empty' }, h('h2', null, S.orders.length ? '이 조건에 맞는 건이 없습니다' : '아직 불러온 건이 없습니다'),
      h('p', null, S.orders.length ? '위의 보기를 전체로 바꿔 보세요.' : '불러오기 단계에서 의뢰서나 엑셀을 선택하세요.')));
    return;
  }
  v.forEach((o) => {
    const s = info(o).s;
    l.append(h('div', { class: 'row' + (o.id === S.sel ? ' is-sel' : ''), role: 'option', 'aria-selected': String(o.id === S.sel), tabindex: -1, 'data-id': o.id, onclick: () => select(o.id) },
      h('span', { class: 'dot', 'data-s': s }),
      h('div', { class: 'row-t' }, h('b', null, o.requester.name || '(업체명 없음)'), h('span', null, o.sample.name || '(시료명 없음)')),
      h('div', { class: 'row-s' }, LABEL[s], h('br'), `항목 ${o.items.length}`)));
  });
}
function select(id) { S.sel = id; S.viewer = { scale: 1, rot: 0, idx: 0 }; if (S.stage !== 'review') go('review'); else renderReview(); }

/* ── 검토: 상세 ───────────────────────────────────── */
function renderDetail() {
  const d = $('#detail'); d.replaceChildren();
  const o = cur();
  if (!o) { d.append(h('div', { class: 'empty' }, h('h2', null, '건을 선택하세요'), h('p', null, '왼쪽 목록에서 건을 고르면 원본과 입력값을 나란히 볼 수 있습니다.'))); return; }
  const { s } = info(o);

  d.append(h('div', { class: 'd-head' },
    h('div', { class: 'd-title' },
      h('h2', { id: 'dTitle' }, o.requester.name || '(업체명 없음)'),
      h('p', { id: 'dSub' }, h('span', { class: 'state', 'data-s': s, id: 'dState' }, LABEL[s]), o.sample.name || '(시료명 없음)'),
      h('p', null, `시험항목 ${o.items.length}건`, o.kafri && o.kafri.custCode ? `, 업체코드 ${o.kafri.custCode}` : '')),
    h('div', { class: 'd-act' },
      h('button', { type: 'button', class: 'btn', onclick: () => lookupCompany(o) }, '과거 접수에서 업체 정보 가져오기'),
      h('button', { type: 'button', class: 'btn', onclick: () => checkDup(o) }, '중복 접수 확인'),
      h('button', { type: 'button', class: 'btn btn-primary', id: 'btnConfirm', onclick: () => toggleConfirm(o) }, o.confirmed ? '확정 취소' : '이 건 확정'))));

  d.append(h('div', { id: 'histBox' }));
  if (S.hist[o.id]) renderHist(o);
  if (S.dup[o.id]) d.append(dupNote(S.dup[o.id]));

  const form = h('div', { class: 'form' });
  ['requester', 'billing', 'report', 'sample'].forEach((g) => {
    const grid = h('div', { class: 'grid' });
    M.FIELDS.filter((f) => f.group === g).forEach((f) => grid.append(fieldEl(o, f)));
    form.append(h('div', { class: 'grp' }, h('h3', null, M.GROUPS[g]), grid));
    if (g === 'sample') form.append(h('div', { class: 'grp' }, h('h3', null, '시험항목'), itemsEl(o)));
  });
  const meta = h('div', { class: 'grid' });
  M.FIELDS.filter((f) => f.group === 'meta').forEach((f) => meta.append(fieldEl(o, f)));
  form.append(h('div', { class: 'grp' }, h('h3', null, M.GROUPS.meta), meta));
  if (o.memo) form.append(h('div', { class: 'grp' }, h('h3', null, '불러온 엑셀의 메모'), h('p', { class: 'hint' }, o.memo)));
  form.append(h('div', { class: 'grp', id: 'issueBox' }));

  d.append(h('div', { class: 'pair' }, viewerEl(o), form));
  markAll(o);
}

function fieldEl(o, f) {
  const id = `f-${f.path.replace(/\./g, '-')}`;
  const wrap = h('div', { class: 'fld' + (f.wide ? ' wide' : ''), 'data-path': f.path });
  wrap.append(h('label', { for: id }, h('span', null, f.label), f.req ? h('em', null, '필수') : null));
  const val = M.getPath(o, f.path);
  const inp = h('input', { id, class: 'inp', value: val == null ? '' : val, autocomplete: 'off', placeholder: f.type === 'date' ? 'YYYY-MM-DD' : '', inputmode: f.type === 'num' || f.type === 'int' ? 'decimal' : null });
  inp.addEventListener('input', () => edit(o, f.path, inp.value));
  inp.addEventListener('blur', () => {
    let v = inp.value, n = v;
    if (f.type === 'date') n = M.normDate(v);
    else if (f.path === 'requester.mobile' || f.path === 'billing.contact') n = M.normPhone(v);
    else if (f.type === 'bizno') n = M.normBizno(v);
    if (n !== v) { inp.value = n; edit(o, f.path, n); }
  });
  wrap.append(inp, h('div', { class: 'why-box' }));
  if (f.hint) wrap.append(h('p', { class: 'hint' }, f.hint));
  return wrap;
}
function edit(o, path, v) {
  M.setPath(o, path, v);
  if (o.flags[path]) delete o.flags[path];
  if (path === 'sample.amountRaw') { /* 원문을 고쳐도 숫자는 사람이 확인하도록 그대로 둔다 */ }
  o.confirmed = false;
  afterEdit(o);
}
function itemsEl(o) {
  const t = h('table', { class: 'items' });
  const body = h('tbody');
  const draw = () => {
    body.replaceChildren();
    o.items.forEach((it, i) => {
      const mk = (k, ph) => { const inp = h('input', { class: 'inp' + (k === 'name' && !it.name ? ' is-bad' : ''), value: it[k], placeholder: ph, 'aria-label': `${i + 1}번 ${ph}` }); inp.addEventListener('input', () => { it[k] = inp.value; delete o.flags[`items.${i}.${k}`]; if (k === 'name') delete o.flags.items; o.confirmed = false; afterEdit(o); }); return inp; };
      body.append(h('tr', null, h('td', null, mk('name', '시험항목')), h('td', null, mk('spec', '기준·규격')), h('td', null, mk('note', '비고')),
        h('td', null, h('button', { type: 'button', class: 'btn btn-sm', 'aria-label': `${i + 1}번 항목 삭제`, onclick: () => { o.items.splice(i, 1); o.confirmed = false; draw(); afterEdit(o); } }, '삭제'))));
    });
  };
  draw();
  t.append(h('thead', null, h('tr', null, h('th', null, '시험항목'), h('th', null, '기준·규격'), h('th', null, '비고'), h('th'))), body);
  return h('div', null, t, h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { o.items.push({ name: '', spec: '', note: '' }); o.confirmed = false; draw(); afterEdit(o); } }, '항목 추가'),
    h('div', { class: 'fld', 'data-path': 'items', style: 'margin-top:6px' }, h('div', { class: 'why-box' })));
}

/* 칸 표시(형광펜·오류)와 오른쪽 점검 목록을 다시 그린다. 입력 중인 칸은 건드리지 않는다. */
function markAll(o) {
  const { issues, s } = info(o);
  const by = {};
  issues.forEach((i) => { const k = i.path.startsWith('items.') ? 'items' : i.path; (by[k] = by[k] || []).push(i); });
  $$('.fld[data-path]').forEach((w) => {
    const p = w.dataset.path, list = by[p] || [];
    const err = list.find((i) => i.level === 'error'), rev = list.find((i) => i.level === 'review'), warn = list.find((i) => i.level === 'warn');
    w.classList.toggle('is-err', !!err); w.classList.toggle('is-flag', !!rev && !err);
    const box = $('.why-box', w); box.replaceChildren();
    const m = err || rev || warn;
    if (m) {
      const line = h('div', { class: 'why', role: m.level === 'error' ? 'alert' : null }, h('span', null, m.msg));
      if (rev) line.append(h('button', { type: 'button', onclick: () => { Object.keys(o.flags).filter((k) => k === p || k.startsWith(p + '.')).forEach((k) => delete o.flags[k]); o.confirmed = false; afterEdit(o); } }, '맞음'));
      box.append(line);
    }
  });
  const ib = $('#issueBox');
  if (ib) {
    ib.replaceChildren(h('h3', null, '점검 결과'));
    const rank = { error: 0, review: 1, warn: 2, info: 3 };
    const ul = h('ul', { class: 'issues' });
    [...issues].sort((a, b) => rank[a.level] - rank[b.level]).forEach((i) => ul.append(h('li', { 'data-l': i.level }, h('span', { class: 'lv' }, LV[i.level]), h('span', null, `${pathLabel(i.path)}: ${i.msg}`))));
    ib.append(ul);
    const nrev = issues.filter((i) => i.level === 'review').length;
    if (nrev) ib.append(h('p', { style: 'margin-top:10px' }, h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { o.flags = {}; o.confirmed = false; afterEdit(o); } }, `확인 필요 ${nrev}건 모두 맞음`)));
    if (!issues.length) ul.append(h('li', null, h('span', { class: 'lv ok' }, '이상 없음'), h('span')));
  }
  const st = $('#dState'); if (st) { st.dataset.s = s; st.textContent = LABEL[s]; }
  const bc = $('#btnConfirm'); if (bc) { bc.textContent = o.confirmed ? '확정 취소' : '이 건 확정'; }
  const t = $('#dTitle'); if (t) t.textContent = o.requester.name || '(업체명 없음)';
}
function afterEdit(o) {
  markAll(o);
  renderRail();
  // 목록·띠·집계만 가볍게 갱신
  const c = counts();
  $('#tally').replaceChildren(
    h('span', null, '전체 ', h('b', null, S.orders.length), '건'), h('span', null, '확정 ', h('b', null, c.ready)),
    h('span', null, '확인 필요 ', h('b', null, c.review)), h('span', null, '오류 ', h('b', null, c.error)), h('span', null, '미검토 ', h('b', null, c.pending)));
  $$('.seg-cell').forEach((b, i) => { b.dataset.s = info(S.orders[i]).s; });
  const row = $(`.row[data-id="${o.id}"]`);
  if (row) { const s = info(o).s; $('.dot', row).dataset.s = s; $('.row-t b', row).textContent = o.requester.name || '(업체명 없음)'; $('.row-t span', row).textContent = o.sample.name || '(시료명 없음)'; $('.row-s', row).firstChild.textContent = LABEL[s]; }
}
function toggleConfirm(o) {
  if (o.confirmed) { o.confirmed = false; afterEdit(o); return; }
  const { issues } = info(o);
  const err = issues.filter((i) => i.level === 'error'), rev = issues.filter((i) => i.level === 'review');
  if (err.length) { toast(`오류 ${err.length}건이 있어 확정할 수 없습니다: ${err[0].msg}`, true); return; }
  if (rev.length) { toast(`확인 필요 ${rev.length}건이 남아 있습니다. 칸마다 '맞음'을 누르거나 값을 고치세요.`, true); return; }
  o.confirmed = true; afterEdit(o); toast('확정했습니다.');
  const v = visible(); const i = v.findIndex((x) => x.id === o.id);
  if (v[i + 1] && S.filter === 'all') { /* 자동 이동하지 않는다. 사용자가 대조 중일 수 있다. */ }
}

/* ── 원본 뷰어 ────────────────────────────────────── */
function previewsOf(o) {
  const list = [];
  (o.source.files || []).forEach((n) => { if (S.previews[n]) list.push(S.previews[n]); });
  if (S.previews['order:' + o.id]) list.push(...[].concat(S.previews['order:' + o.id]));
  return list;
}
function viewerEl(o) {
  const box = h('div', { class: 'viewer' });
  const list = previewsOf(o);
  if (!list.length) {
    const inp = h('input', { type: 'file', accept: 'image/*,application/pdf', hidden: true });
    inp.addEventListener('change', async () => {
      if (!inp.files[0]) return;
      try { await prepFile(inp.files[0], 'order:' + o.id); S.previews['order:' + o.id].name = inp.files[0].name; renderDetail(); } catch (e) { toast(e.message, true); }
    });
    box.append(h('div', { class: 'v-stage' }, h('div', { class: 'v-empty' }, h('p', null, o.source.files.length ? '원본 파일이 이 화면에 없습니다.' : '이 건에는 연결된 원본이 없습니다. 엑셀에서 불러온 건입니다.'),
      h('p', null, '의뢰서 사진이나 PDF를 붙이면 입력값과 나란히 보면서 대조할 수 있습니다. 파일은 이 PC 안에서만 쓰이고 서버로 보내지 않습니다.'),
      h('button', { type: 'button', class: 'btn', onclick: () => inp.click() }, '원본 붙이기'), inp)));
    return box;
  }
  const v = S.viewer; v.idx = Math.min(v.idx, list.length - 1);
  const p = list[v.idx];
  const stage = h('div', { class: 'v-stage' });
  const draw = () => {
    stage.replaceChildren();
    if (p.type === 'pdf') { stage.append(h('iframe', { src: p.url, title: `원본 ${p.name}` })); return; }
    const img = h('img', { src: p.url, alt: `의뢰서 원본 ${p.name}` });
    const apply = () => { const w = stage.clientWidth || 400; img.style.width = `${Math.round(w * v.scale)}px`; img.style.transform = v.rot ? `rotate(${v.rot}deg)` : ''; img.style.transformOrigin = 'center'; img.style.margin = v.rot % 180 ? `${Math.round(w * v.scale / 3)}px 0` : '0'; };
    img.addEventListener('load', apply); stage.append(img); stage._apply = apply;
  };
  const sel = list.length > 1 ? h('select', { 'aria-label': '원본 파일', onchange: (e) => { v.idx = Number(e.target.value); renderDetail(); } }, list.map((x, i) => h('option', { value: i, selected: i === v.idx }, x.name.split('/').pop()))) : null;
  const zoom = (d) => { v.scale = Math.max(0.5, Math.min(4, v.scale + d)); stage._apply && stage._apply(); };
  box.append(h('div', { class: 'v-bar' }, sel,
    p.type === 'img' ? [h('button', { type: 'button', class: 'btn btn-sm', onclick: () => zoom(-0.25), 'aria-label': '축소' }, '−'), h('button', { type: 'button', class: 'btn btn-sm', onclick: () => zoom(0.25), 'aria-label': '확대' }, '+'),
      h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { v.scale = 1; stage._apply && stage._apply(); } }, '맞춤'),
      h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { v.rot = (v.rot + 90) % 360; stage._apply && stage._apply(); } }, '회전')] : null,
    h('span', { class: 'sp' }), h('a', { class: 'btn btn-sm', href: p.url, target: '_blank', rel: 'noopener', style: 'display:inline-flex;align-items:center;text-decoration:none' }, '새 창')), stage);
  draw(); return box;
}

/* ── 업체 조회·중복 확인 ──────────────────────────── */
async function ensureConn(retry) {
  if (S.state.user) return true;
  S.pending = retry || null;
  openLogin();
  return false;
}
async function lookupCompany(o) {
  if (!(await ensureConn(() => lookupCompany(o)))) return;
  if (!M.str(o.requester.name)) { toast('업체명을 먼저 입력하세요.', true); return; }
  try { S.hist[o.id] = await api('/api/company', { name: o.requester.name }); renderHist(o); }
  catch (e) { toast(`업체 조회 실패: ${e.message}`, true); }
}
const nz = (s) => String(s || '').replace(/[\s\-()]/g, '').toLowerCase();
const HIST_ROWS = [['대표자', 'requester.rep', 'rep'], ['주소', 'requester.addr', 'addr'], ['전화', 'requester.tel', 'tel'], ['계산서 업체명', 'billing.name', 'billName'], ['사업자번호', 'billing.bizno', 'bizno'], ['성적서 수령주소(DM)', 'report.addr', 'dmAddr']];
function applyHist(o, items) {
  const g = (S.hist[o.id].picked || {}).guess || {};
  items.forEach(([, path, key]) => { if (g[key]) { M.setPath(o, path, g[key].value); delete o.flags[path]; } });
  if (g.custCode) o.kafri = { ...o.kafri, custCode: g.custCode.value };
  o.confirmed = false; renderDetail(); toast('과거 접수의 값을 반영했습니다.');
}
function renderHist(o) {
  const box = $('#histBox'); if (!box) return;
  box.replaceChildren();
  const r = S.hist[o.id];
  const wrap = h('div', { class: 'hist' });
  if (!r.picked) {
    wrap.append(h('div', { class: 'hist-h' }, h('h3', null, '과거 접수 조회')), h('p', { style: 'padding:12px' }, `최근 3년 접수에서 '${o.requester.name}' 과(와) 같은 이름의 업체를 찾지 못했습니다. 업체명 표기를 확인하거나, 기준정보에 등록된 업체인지 확인하세요.`));
    box.append(wrap); return;
  }
  const g = r.picked.guess;
  const fillable = [];
  const body = h('tbody');
  HIST_ROWS.forEach((row) => {
    const [label, path, key] = row; const mine = M.getPath(o, path); const hv = g[key] && g[key].value;
    let st = '과거 접수에서 찾지 못함';
    if (hv) st = !M.str(mine) ? '비어 있음' : nz(mine) === nz(hv) ? '같음' : '다름';
    if (hv && st !== '같음') fillable.push(row);
    body.append(h('tr', null, h('td', null, label), h('td', null, mine || '(없음)'),
      h('td', null, hv ? h('span', { class: st === '다름' ? 'diff' : '' }, hv) : '', hv ? h('span', { class: 'col' }, g[key].column) : ''),
      h('td', { style: 'white-space:nowrap' }, st), h('td', null, hv && st !== '같음' ? h('button', { type: 'button', class: 'btn btn-sm', onclick: () => applyHist(o, [row]) }, '사용') : '')));
  });
  const codeNote = g.custCode ? `업체코드 ${g.custCode.value}` : '업체코드를 인식하지 못했습니다';
  const multi = r.candidates.filter((c) => c.code !== '(코드 미확인)').length > 1;
  wrap.append(h('div', { class: 'hist-h' }, h('h3', null, `과거 접수 ${r.total}건 중 ${r.exact ? '이름이 같은' : '이름이 비슷한'} 최신 접수에서 가져온 값 (${codeNote})`),
    fillable.length ? h('button', { type: 'button', class: 'btn btn-sm', onclick: () => applyHist(o, fillable.filter((row) => !M.str(M.getPath(o, row[1])))) }, '빈 칸만 모두 채우기') : null));
  if (multi) wrap.append(h('p', { style: 'padding:8px 12px', class: 'hint' }, `업체코드 후보가 여러 개입니다: ${r.candidates.map((c) => `${c.code} ${c.name}`).join(', ')}. 맞는 업체인지 확인하세요.`));
  wrap.append(h('table', { class: 'cmp' }, h('thead', null, h('tr', null, h('th', null, '항목'), h('th', null, '의뢰서 값'), h('th', null, '과거 접수 값'), h('th', null, '비교'), h('th'))), body));
  wrap.append(h('details', { class: 'raw' }, h('summary', null, `서버에서 받은 컬럼 ${r.columns.length}개와 원본 행 보기`), h('pre', null, `컬럼: ${r.columns.join(', ')}\n\n${JSON.stringify(r.picked.row, null, 1)}`)));
  box.append(wrap);
}
function dupNote(r) {
  return h('p', { class: 'note', style: 'margin:0 0 14px' }, `최근 30일에 같은 업체·시료명으로 접수된 건이 ${r.count}건 있습니다${r.sameLot ? `, 그중 같은 제조번호가 ${r.sameLot}건입니다. 중복 접수일 수 있습니다` : ''}.`);
}
async function checkDup(o) {
  if (!(await ensureConn(() => checkDup(o)))) return;
  try { S.dup[o.id] = await api('/api/dup', { order: o }); renderDetail(); }
  catch (e) { toast(`중복 확인 실패: ${e.message}`, true); }
}

/* ── 등록(드라이런) ───────────────────────────────── */
function renderRegister() {
  const c = counts();
  const out = $('#regOut');
  if (S.dry) { drawDry(); return; }
  out.replaceChildren(h('p', { class: 'lead', style: 'margin:0' }, c.ready ? `확정한 건이 ${c.ready}건 있습니다. 드라이런으로 업체코드, 코드 매칭, 중복 여부를 점검합니다.` : '확정한 건이 없습니다. 검토 단계에서 건을 확정하세요.'));
  $('#btnDry').disabled = !c.ready;
}
async function runDry() {
  if (!(await ensureConn(runDry))) return;
  const ready = S.orders.filter((o) => info(o).s === 'ready');
  const out = $('#regOut'); S.dry = null;
  const btn = $('#btnDry'); btn.disabled = true;
  const rows = [];
  try {
    for (let i = 0; i < ready.length; i++) {
      out.replaceChildren(h('p', { 'aria-live': 'polite' }, `점검 중 ${i + 1} / ${ready.length}`));
      const o = ready[i];
      const comp = await api('/api/company', { name: o.requester.name });
      const codes = await api('/api/codematch', { order: o });
      const dup = await api('/api/dup', { order: o });
      const prev = await api('/api/preview', { order: o, company: comp, codes });
      rows.push({ o, comp, codes, dup, prev });
    }
    S.dry = rows;
  } catch (e) { out.replaceChildren(h('p', { class: 'bad', role: 'alert' }, `점검을 마치지 못했습니다: ${e.message}`)); btn.disabled = false; return; }
  btn.disabled = false; drawDry();
}
function drawDry() {
  const out = $('#regOut'); const rows = S.dry || [];
  const body = h('tbody'); let okN = 0;
  rows.forEach(({ o, comp, codes, dup, prev }) => {
    const code = comp.picked && comp.picked.guess.custCode;
    const miss = Object.entries(codes).filter(([, v]) => v.status === 'miss' || v.status === 'nogroup').map(([k]) => ({ purpose: '의뢰목적', storage: '보관방법', delivery: '통보방법' }[k]));
    const issues = [];
    if (!comp.picked) issues.push('과거 접수에서 업체를 찾지 못함'); else if (!code) issues.push('업체코드 미인식');
    if (miss.length) issues.push(`코드 확인 필요: ${miss.join(', ')}`);
    if (dup.sameLot) issues.push(`같은 제조번호 접수 ${dup.sameLot}건`);
    const pass = !issues.length; if (pass) okN += 1;
    body.append(h('tr', null,
      h('td', null, h('b', null, o.requester.name), h('br'), o.sample.name),
      h('td', null, code ? code.value : h('span', { class: 'bad' }, '없음')),
      h('td', null, ['purpose', 'storage', 'delivery'].map((k) => { const v = codes[k]; return h('div', null, { purpose: '의뢰목적', storage: '보관방법', delivery: '통보방법' }[k], ' ', v.status === 'ok' ? h('span', { class: 'ok' }, `${v.code}`) : v.status === 'empty' ? '(없음)' : h('span', { class: 'warnx' }, v.status === 'nogroup' ? '코드그룹 없음' : '미매칭')); })),
      h('td', { class: 'num' }, `${dup.count}건`),
      h('td', { class: 'num' }, prev.unresolved.length),
      h('td', null, pass ? h('span', { class: 'ok' }, '점검 통과') : h('span', { class: 'warnx' }, '보완 필요'), issues.map((t) => h('div', { class: 'hint' }, t))),
      h('td', null, h('button', { type: 'button', class: 'btn btn-sm', onclick: () => showPreview(o, prev) }, '전송 값 보기'))));
  });
  out.replaceChildren(
    h('p', { style: 'margin-bottom:10px' }, h('b', null, `${rows.length}건 중 ${okN}건 점검 통과`), '. 시험항목 코드와 검사금액은 저장 규격을 확보한 뒤 서버에서 받아옵니다.'),
    h('table', { class: 'rep' }, h('thead', null, h('tr', null, h('th', null, '건'), h('th', null, '업체코드'), h('th', null, '코드 매칭'), h('th', { class: 'num' }, '최근 30일 같은 업체·시료'), h('th', { class: 'num' }, '미해결 칸'), h('th', null, '판정'), h('th'))), body));
}
function showPreview(o, prev) {
  const bySec = new Map();
  prev.rows.forEach((r) => (bySec.get(r.section) || bySec.set(r.section, []).get(r.section)).push(r));
  const st = { ok: '', empty: '비어 있음', todo: '조회 필요' };
  const root = h('div', null, h('h2', null, `${o.requester.name} / ${o.sample.name}`), h('p', { class: 'dlg-p' }, '서버에 저장한다면 이 값이 들어갑니다. 지금은 저장하지 않습니다.'));
  bySec.forEach((rows, sec) => {
    root.append(h('h3', { style: 'margin:16px 0 4px;font-size:13px' }, sec),
      h('table', { class: 'cmp pv' }, h('tbody', null, rows.map((r) => h('tr', null, h('td', { style: 'width:34%' }, r.label), h('td', null, r.value || ''), h('td', { class: 'hint' }, r.source), h('td', null, r.state === 'todo' ? h('span', { class: 'warnx' }, st.todo) : r.state === 'empty' ? h('span', { class: 'hint' }, st.empty) : ''))))));
  });
  $('#infoBody').replaceChildren(root); $('#dlgInfo').showModal();
}

/* ── 연결·기초코드 ────────────────────────────────── */
function openLogin() { $('#loginErr').textContent = ''; $('#dlgLogin').showModal(); setTimeout(() => $('#inEmp').focus(), 30); }
async function doLogin(e) {
  e.preventDefault();
  const btn = $('#loginGo'); btn.disabled = true; $('#loginErr').textContent = '';
  try { const r = await api('/api/login', { employeeNo: $('#inEmp').value }); S.state.user = r.user; renderChips(); $('#dlgLogin').close(); $('#inEmp').value = ''; toast('연결했습니다.'); const pend = S.pending; S.pending = null; if (pend) pend(); }
  catch (er) { $('#loginErr').textContent = er.message; }
  btn.disabled = false;
}
async function showCodes() {
  if (!(await ensureConn(showCodes))) return;
  try {
    const { groups } = await api('/api/codegroups');
    const q = h('input', { class: 'inp', placeholder: '그룹 이름이나 코드 검색', 'aria-label': '기초코드 검색' });
    const body = h('tbody');
    const draw = () => { body.replaceChildren(); groups.filter((g) => !q.value || (g.name + g.id + g.sample.join(' ')).includes(q.value)).forEach((g) => body.append(h('tr', null, h('td', null, g.id), h('td', null, g.name), h('td', { class: 'num' }, g.count), h('td', { class: 'hint' }, g.sample.join(' / '))))); };
    q.addEventListener('input', draw); draw();
    $('#infoBody').replaceChildren(h('h2', null, `기초코드 그룹 ${groups.length}개`), h('p', { class: 'dlg-p' }, '의뢰목적, 보관방법, 통보방법은 이 표에서 이름으로 찾아 매칭합니다.'), q, h('table', { class: 'cmp', style: 'margin-top:10px' }, h('thead', null, h('tr', null, h('th', null, '그룹'), h('th', null, '이름'), h('th', { class: 'num' }, '코드 수'), h('th', null, '예시'))), body));
    $('#dlgInfo').showModal();
  } catch (e) { toast(`기초코드를 불러오지 못했습니다: ${e.message}`, true); }
}
function showConnected() {
  const u = S.state.user;
  $('#infoBody').replaceChildren(h('h2', null, '연결됨'), h('p', { class: 'dlg-p' }, `${S.state.demo ? '데모 모드입니다. 실제 서버에는 접속하지 않습니다. ' : ''}사번 ${u.userId}${u.userNm ? ' ' + u.userNm : ''}${u.deptNm ? ' (' + u.deptNm + ')' : ''}`),
    h('button', { type: 'button', class: 'btn', onclick: async () => { await api('/api/logout', {}); S.state.user = null; S.hist = {}; renderChips(); $('#dlgInfo').close(); toast('연결을 해제했습니다.'); } }, '연결 해제'));
  $('#dlgInfo').showModal();
}

/* ── 엑셀 저장 ────────────────────────────────────── */
async function exportXlsx() {
  try {
    const res = await fetch('/api/excel/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orders: S.orders }) });
    if (!res.ok) throw new Error((await res.json()).error);
    const blob = await res.blob(); const a = h('a', { href: URL.createObjectURL(blob), download: `접수목록_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.xlsx` });
    document.body.append(a); a.click(); a.remove(); toast('엑셀로 저장했습니다. 확인 필요 칸은 노란색으로 표시됩니다.');
  } catch (e) { toast(`엑셀 저장 실패: ${e.message}`, true); }
}

/* ── 연결선 ──────────────────────────────────────── */
function wire() {
  $$('.step').forEach((b) => b.addEventListener('click', () => go(b.dataset.stage)));
  $('#btnFiles').onclick = () => $('#inFiles').click();
  $('#btnFolder').onclick = () => $('#inFolder').click();
  $('#btnExcel').onclick = () => $('#inExcel').click();
  $('#inFiles').onchange = (e) => { handleFiles(e.target.files); e.target.value = ''; };
  $('#inFolder').onchange = (e) => { handleFolder(e.target.files); e.target.value = ''; };
  $('#inExcel').onchange = (e) => { if (e.target.files[0]) handleExcel(e.target.files[0]); e.target.value = ''; };
  const dz = $('#dropZone');
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('is-drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('is-drag'); }));
  dz.addEventListener('drop', (e) => { const fs = [...e.dataTransfer.files]; if (fs.some((f) => /\.xlsx$/i.test(f.name))) handleExcel(fs.find((f) => /\.xlsx$/i.test(f.name))); else handleFiles(fs); });
  $('#filters').addEventListener('click', (e) => { const b = e.target.closest('.f'); if (b) { S.filter = b.dataset.f; renderReview(); } });
  $('#btnAdd').onclick = () => { const o = M.blank(); o.source.note = '직접 입력'; S.orders.push(o); S.sel = o.id; S.filter = 'all'; go('review'); };
  $('#btnDelete').onclick = () => { const i = S.orders.findIndex((o) => o.id === S.sel); if (i < 0) return; S.orders.splice(i, 1); S.sel = (S.orders[i] || S.orders[i - 1] || {}).id || null; renderReview(); renderRail(); toast('삭제했습니다.'); };
  $('#btnExport').onclick = exportXlsx;
  $('#btnCodes').onclick = showCodes;
  $('#btnDry').onclick = runDry;
  $('#chipConn').onclick = () => (S.state.user ? showConnected() : openLogin());
  $('#formLogin').addEventListener('submit', doLogin);
  $('#loginCancel').onclick = () => $('#dlgLogin').close();
  $('#infoClose').onclick = () => $('#dlgInfo').close();
  $('#list').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const v = visible(); const i = v.findIndex((o) => o.id === S.sel); const n = v[i + (e.key === 'ArrowDown' ? 1 : -1)];
    if (n) { e.preventDefault(); select(n.id); }
  });
  $('#list').tabIndex = 0;
  window.addEventListener('beforeunload', (e) => { if (S.orders.length) { e.preventDefault(); e.returnValue = ''; } });
}

wire();
refreshState().catch(() => toast('프로그램 본체와 연결되지 않았습니다. 검은 창이 열려 있는지 확인하세요.', true)).finally(() => go('load'));
})();
