'use strict';
/*
 * 접수 모델 — 서버와 브라우저가 같이 쓴다 (UMD).
 * 접수 1건 = 시료 1건. 의뢰서 공통 정보는 건마다 반복한다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IntakeModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  let seq = 0;
  const newId = () => 'R' + Date.now().toString(36).slice(-4).toUpperCase() + String(++seq).padStart(3, '0');

  /* 화면 묶음 → 필드 정의. 폼 렌더·엑셀·검증이 이 표 하나를 본다. */
  const FIELDS = [
    { path: 'requestDate', label: '의뢰일', group: 'meta', type: 'date' },
    { path: 'requester.name', label: '의뢰업체명', group: 'requester', req: true },
    { path: 'requester.rep', label: '대표자', group: 'requester' },
    { path: 'requester.addr', label: '주소', group: 'requester', wide: true },
    { path: 'requester.tel', label: '전화', group: 'requester', type: 'tel' },
    { path: 'requester.fax', label: '팩스', group: 'requester', type: 'tel' },
    { path: 'requester.mobile', label: '휴대폰', group: 'requester', type: 'tel', req: true },
    { path: 'requester.email', label: '이메일(담당자)', group: 'requester' },
    { path: 'requester.contact', label: '의뢰인(담당)', group: 'requester' },
    { path: 'billing.name', label: '계산서 업체명', group: 'billing', hint: '비워 두면 의뢰업체와 같은 곳' },
    { path: 'billing.bizno', label: '사업자번호', group: 'billing', type: 'bizno' },
    { path: 'billing.email', label: '계산서 이메일', group: 'billing' },
    { path: 'billing.contact', label: '계산서 담당자 연락처', group: 'billing', type: 'tel' },
    { path: 'report.addr', label: '성적서 수령주소', group: 'report', wide: true },
    { path: 'report.korCopies', label: '국문 부수', group: 'report', type: 'int' },
    { path: 'report.engCopies', label: '영문 부수', group: 'report', type: 'int' },
    { path: 'report.delivery', label: '성적서 전달방법', group: 'report', hint: '우편, 메일 등 (쉼표로 구분)' },
    { path: 'purpose', label: '의뢰목적', group: 'report', req: true },
    { path: 'storage', label: '보관방법', group: 'report' },
    { path: 'sample.name', label: '시료명', group: 'sample', req: true, wide: true },
    { path: 'sample.foodType', label: '식품유형', group: 'sample', req: true },
    { path: 'sample.kind', label: '시료구분', group: 'sample', hint: '완제품 · 원료 · 소분제품 등' },
    { path: 'sample.amountRaw', label: '시료량(의뢰서 표기)', group: 'sample', wide: true },
    { path: 'sample.amount', label: '시료량', group: 'sample', type: 'num', req: true },
    { path: 'sample.unit', label: '단위', group: 'sample' },
    { path: 'sample.lot', label: '제조번호(Lot)', group: 'sample' },
    { path: 'sample.mfgDate', label: '제조일자', group: 'sample', type: 'date' },
    { path: 'sample.expDate', label: '유통기한', group: 'sample', type: 'date' },
    { path: 'receiptNoHint', label: '접수번호(의뢰서 표기)', group: 'meta', hint: '참고용. 접수번호는 서버가 부여합니다' },
    { path: 'remark', label: '비고', group: 'meta', wide: true },
  ];
  const GROUPS = {
    requester: '의뢰업체와 의뢰인', billing: '계산서', report: '성적서와 의뢰목적',
    sample: '시료', meta: '기타',
  };

  function blank() {
    return {
      id: newId(),
      source: { files: [], pages: '', note: '' },
      confirmed: false,
      requestDate: '',
      requester: { name: '', rep: '', addr: '', tel: '', fax: '', mobile: '', email: '', contact: '' },
      billing: { name: '', bizno: '', email: '', contact: '' },
      report: { addr: '', korCopies: '', engCopies: '', delivery: '' },
      purpose: '', storage: '',
      sample: { name: '', foodType: '', kind: '', amountRaw: '', amount: '', unit: '', lot: '', mfgDate: '', expDate: '' },
      items: [],
      receiptNoHint: '', remark: '', memo: '',
      flags: {},
      kafri: {},
    };
  }

  function getPath(o, p) { return p.split('.').reduce((a, k) => (a == null ? a : a[k]), o); }
  function setPath(o, p, v) {
    const ks = p.split('.');
    let a = o;
    for (let i = 0; i < ks.length - 1; i++) { if (a[ks[i]] == null) a[ks[i]] = {}; a = a[ks[i]]; }
    a[ks[ks.length - 1]] = v;
  }

  const str = (v) => (v == null ? '' : String(v).trim());
  /* '-', '—', 'N/A' 같은 "없음" 표기는 빈 값으로 */
  const none = (v) => (/^[-–—ㅡ\s]*$|^n\/?a$|^없음$/i.test(str(v)) ? '' : str(v));

  function normDate(v) {
    const s = none(v);
    if (!s) return '';
    const m = s.match(/(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;
    return s; // 해석 못 하면 그대로 두고 검증에서 알린다
  }
  function normBizno(v) {
    const d = str(v).replace(/\D/g, '');
    return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : str(v);
  }
  function normPhone(v) {
    const s = none(v);
    const d = s.replace(/\D/g, '');
    if (/^010\d{8}$/.test(d)) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
    if (/^010\d{7}$/.test(d)) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
    return s;
  }

  /* 시료량: "100 g" 은 그대로, "500mg*10SC*6PTP/30g, *7case" 같은 포장 표기는 추정하고 표시한다 */
  function parseAmount(raw) {
    const s = str(raw);
    if (!s) return { amount: '', unit: '', guessed: false };
    const simple = s.match(/^(\d+(?:[.,]\d+)?)\s*(kg|g|mg|ml|l|㎏|㎎|㎖)$/i);
    if (simple) return { amount: simple[1].replace(',', '.'), unit: simple[2].toLowerCase(), guessed: false };
    const all = [...s.matchAll(/(\d+(?:[.,]\d+)?)\s*(kg|g|mg|ml|l|㎏|㎎|㎖)(?![a-z])/gi)];
    if (!all.length) return { amount: '', unit: '', guessed: true };
    const slash = s.lastIndexOf('/');
    const afterSlash = slash >= 0 ? all.filter((m) => m.index > slash) : [];
    const pick = (afterSlash.length ? afterSlash : all).slice(-1)[0];
    return { amount: pick[1].replace(',', '.'), unit: pick[2].toLowerCase(), guessed: all.length > 1 || slash >= 0 };
  }

  function copies(raw, kind) {
    const m = str(raw).match(new RegExp(kind + '[^\\d]*(\\d+)'));
    return m ? m[1] : '';
  }

  /* 느슨한 입력(엑셀·AI 응답)을 모델로 */
  function normalize(src) {
    const o = blank();
    const s = src || {};
    const take = (dst, from, keys) => keys.forEach((k) => { if (from && from[k] != null) dst[k] = str(from[k]); });
    o.id = str(s.id) || o.id;
    take(o.requester, s.requester, Object.keys(o.requester));
    take(o.billing, s.billing, Object.keys(o.billing));
    take(o.report, s.report, ['addr', 'korCopies', 'engCopies']);
    o.report.delivery = Array.isArray(s.report && s.report.delivery)
      ? s.report.delivery.join(', ') : str(s.report && s.report.delivery);
    take(o.sample, s.sample, Object.keys(o.sample));
    ['requestDate', 'purpose', 'storage', 'receiptNoHint', 'remark', 'memo'].forEach((k) => { o[k] = str(s[k]); });
    o.source = { files: (s.source && s.source.files) || [], pages: str(s.source && s.source.pages), note: str(s.source && s.source.note) };
    o.requestDate = normDate(o.requestDate);
    o.sample.mfgDate = normDate(o.sample.mfgDate);
    o.sample.expDate = normDate(o.sample.expDate);
    o.billing.bizno = normBizno(o.billing.bizno);
    ['tel', 'fax', 'mobile'].forEach((k) => { o.requester[k] = k === 'mobile' ? normPhone(o.requester[k]) : none(o.requester[k]); });
    o.billing.contact = normPhone(o.billing.contact);
    o.sample.lot = none(o.sample.lot);
    if (o.sample.amountRaw && !o.sample.amount) {
      const a = parseAmount(o.sample.amountRaw);
      o.sample.amount = a.amount; o.sample.unit = a.unit;
      if (a.guessed) o.flags['sample.amount'] = o.flags['sample.amount'] || '포장 표기에서 추정한 값입니다. 의뢰서와 대조하세요';
    }
    if (!o.report.korCopies && s.report && s.report.copiesRaw) o.report.korCopies = copies(s.report.copiesRaw, '국문');
    if (!o.report.engCopies && s.report && s.report.copiesRaw) o.report.engCopies = copies(s.report.copiesRaw, '영문');
    o.items = (s.items || []).map((it) => ({ name: str(it.name), spec: str(it.spec), note: str(it.note) })).filter((it) => it.name || it.spec);
    // flags: { path: reason } 또는 [{path, reason}]
    const fl = s.flags || {};
    if (Array.isArray(fl)) fl.forEach((f) => { if (f && f.path) o.flags[f.path] = str(f.reason) || '확인이 필요합니다'; });
    else Object.entries(fl).forEach(([k, v]) => { o.flags[k] = str(v) || '확인이 필요합니다'; });
    o.confirmed = false;
    o.kafri = s.kafri || {};
    return o;
  }

  function biznoOk(v) {
    const d = str(v).replace(/\D/g, '');
    if (d.length !== 10) return false;
    const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += Number(d[i]) * w[i];
    sum += Math.floor((Number(d[8]) * 5) / 10);
    return (10 - (sum % 10)) % 10 === Number(d[9]);
  }

  /* level: error(등록 불가) · warn(확인 권장) · info */
  function validate(o) {
    const out = [];
    const add = (path, level, msg) => out.push({ path, level, msg });
    FIELDS.filter((f) => f.req).forEach((f) => {
      if (!str(getPath(o, f.path))) add(f.path, 'error', `${f.label}이(가) 비어 있습니다`);
    });
    if (!o.items.length) add('items', 'error', '시험항목이 없습니다');
    o.items.forEach((it, i) => { if (!it.name) add(`items.${i}.name`, 'error', `${i + 1}번째 시험항목 이름이 비어 있습니다`); });
    FIELDS.filter((f) => f.type === 'date').forEach((f) => {
      const v = str(getPath(o, f.path));
      if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) add(f.path, 'warn', `${f.label}을(를) 날짜로 읽지 못했습니다: ${v}`);
    });
    if (str(o.billing.bizno) && !biznoOk(o.billing.bizno)) add('billing.bizno', 'warn', '사업자번호 검증 숫자가 맞지 않습니다. 오타일 수 있습니다');
    if (str(o.requester.mobile) && !/^01\d-\d{3,4}-\d{4}$/.test(o.requester.mobile)) add('requester.mobile', 'warn', '휴대폰 형식이 010-0000-0000 과 다릅니다');
    if (o.sample.amount && isNaN(Number(o.sample.amount))) add('sample.amount', 'error', '시료량은 숫자여야 합니다');
    ['sample.lot', 'sample.mfgDate', 'sample.expDate'].forEach((p) => {
      if (!str(getPath(o, p))) add(p, 'info', `${FIELDS.find((f) => f.path === p).label}이(가) 비어 있습니다. 기존 접수 예시에서는 비어 있어도 저장되었습니다`);
    });
    Object.entries(o.flags).forEach(([p, reason]) => add(p, 'review', reason));
    return out;
  }

  /* 화면 상태: 오류 > 확인필요 > 확정 > 미검토 */
  function stateOf(o, issues) {
    const is = issues || validate(o);
    if (o.done) return 'done';
    if (is.some((i) => i.level === 'error')) return 'error';
    if (is.some((i) => i.level === 'review')) return 'review';
    return o.confirmed ? 'ready' : 'pending';
  }

  /* ── 예전 엑셀(의뢰서목록 1행=1의뢰서) → 모델 ── */
  const LEGACY = {
    '접수번호': 'receiptNoHint', '의뢰일': 'requestDate', '업체명': 'requester.name', '대표자': 'requester.rep',
    '주소': 'requester.addr', '전화': 'requester.tel', '팩스': 'requester.fax', '핸드폰': 'requester.mobile',
    '이메일': 'requester.email', '의뢰인(담당)': 'requester.contact', '사업자번호': 'billing.bizno',
    '계산서 이메일': 'billing.email', '계산서 담당자 연락처': 'billing.contact', '성적서 수령주소': 'report.addr',
    '성적서 부수': 'report.copiesRaw', '성적서 전달방법': 'report.delivery', '의뢰목적': 'purpose', '보관방법': 'storage',
    '시료명': 'sample.name', '식품유형': 'sample.foodType', '시료량(포장단위)': 'sample.amountRaw', '제조번호(Lot)': 'sample.lot',
    '제조일자': 'sample.mfgDate', '유통기한': 'sample.expDate', '시료구분': 'sample.kind', '비고': 'memo',
    // 새 양식 전용
    '접수ID': 'id', '원본파일': 'source.file', '계산서 업체명': 'billing.name', '계산서 사업자번호': 'billing.bizno',
    '성적서 국문부수': 'report.korCopies', '성적서 영문부수': 'report.engCopies', '시료량(원문)': 'sample.amountRaw',
    '시료량': 'sample.amount', '시료단위': 'sample.unit', '접수번호(의뢰서 표기)': 'receiptNoHint', '확인필요 항목': 'flagsText',
  };

  function splitItems(nameCell, specCell) {
    const names = str(nameCell).split(/\r?\n|;|,|\//).map((s) => s.trim()).filter(Boolean);
    const specs = str(specCell).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!names.length) return [];
    return names.map((n, i) => ({ name: n.replace(/^\d+[.)]\s*/, ''), spec: names.length === specs.length ? specs[i] : (names.length === 1 ? str(specCell) : ''), note: '' }));
  }

  return { FIELDS, GROUPS, LEGACY, blank, normalize, validate, stateOf, getPath, setPath, parseAmount, biznoOk, normDate, normBizno, normPhone, splitItems, str, none };
});
