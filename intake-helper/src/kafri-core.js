'use strict';
/*
 * kafri-core — KAFRI(MiPlatform) 트랜잭션 클라이언트
 *
 * 규격 근거: microbiology-report-writer/docs/kafri-api.md
 *  - 조회는 GET 쿼리스트링, 저장은 POST 본문 (저장은 아직 미구현)
 *  - 응답은 text/xml. 행 태그는 <record>, 컬럼은 태그명이 곧 컬럼명
 *  - 공백은 &#32; 로 이스케이프되어 온다
 *
 * 이 파일은 UI를 모른다. server.js 도 MCP 서버도 이것을 그대로 쓴다.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

const DEFAULT_BASE = 'https://kafri.kfia.or.kr:8444/kfia';
/*
 * 첨부 다운로드만 트랜잭션 서버가 아니라 GBL_BASEURL 쪽이다.
 * 단순 GET 으로 받아진다 — 문서에 있던 "CyHttpFile 청크 규약" 은 필요 없었다(2026-08-17 실측).
 *   gstr = KAFRI_DATA/KBRE005T_FILE/<file_path><file_new_name>
 */
const DOWNLOAD_BASE = 'http://203.227.160.77:8081/kfia';
const FILE_TABLE = 'KBRE005T_FILE';
/* 페이지를 무한정 긁지 않는다. 20 x 1000 = 2만행이면 화면이 감당 못 한다. */
const PAGE_LIMIT = 20;
/*
 * 남은 쪽을 몇 개씩 동시에 받을지. 상한이 20쪽이라 다 던지면 Tomcat 6 에 19개가 한꺼번에 간다.
 * 4 는 실측한 값이다 — 더 올려도 되는지는 재보지 않았다.
 */
const PAGE_CONC = 4;

/*
 * 분야 2택 → 서버 파라미터.
 * sChkMI 는 "미생물 포함" 이 아니라 "미생물만" 이다. 진짜 전부는 sChkAll 이다.
 *
 * 나머지 조합(micro=0·all=0)은 "미생물 외 전부" 인데, 부산지원은 그게 이화학뿐이라
 * '이화학' 으로 부를 수 있었지만 본원은 다른 분야도 섞인다. 이름을 붙일 수 없는 묶음이라 쓰지 않는다.
 */
function fieldParams(field) {
  if (field === 'all') return { micro: false, all: true };
  return { micro: true, all: false };
}

// ── XML 유틸 ──────────────────────────────────────────────

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescapeXml(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#[xX]?[0-9a-fA-F]+|[A-Za-z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const hex = e[1] === 'x' || e[1] === 'X';
      const cp = parseInt(hex ? e.slice(2) : e.slice(1), hex ? 16 : 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return e in NAMED ? NAMED[e] : m;
  });
}

/* 본문 인코딩은 선언을 따른다. Node 는 full-ICU 라 euc-kr 도 TextDecoder 로 읽힌다. */
function decodeBody(buf) {
  const head = buf.slice(0, 200).toString('latin1');
  const m = head.match(/encoding\s*=\s*["']([\w-]+)["']/i);
  const label = (m ? m[1] : 'utf-8').toLowerCase();
  try {
    return new TextDecoder(label).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/*
 * <root><params><param id=..>..</param></params>
 *       <dataset id=..><colinfo .. id=".."/><record><컬럼>값</컬럼></record></dataset></root>
 * → { params: {...}, datasets: { id: { cols: [...], rows: [ {...} ] } } }
 */
function parseResponse(xml) {
  const params = {};
  const reParam = /<param\s+[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/param>/g;
  for (let m; (m = reParam.exec(xml)); ) params[m[1]] = unescapeXml(m[2]);

  const datasets = {};
  const reDs = /<dataset\s+[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/dataset>/g;
  for (let d; (d = reDs.exec(xml)); ) {
    const id = d[1];
    const body = d[2];

    // colinfo 는 encrypt="base64" 가 id 앞에 오는 경우가 있어 태그 전체에서 id 를 찾는다
    const cols = [];
    const reCol = /<colinfo\b([^>]*)\/?>/g;
    for (let c; (c = reCol.exec(body)); ) {
      const idm = c[1].match(/\bid="([^"]+)"/);
      if (idm) cols.push(idm[1]);
    }
    /* 저장할 때 colinfo 를 그대로 되돌려 보내야 서버가 받는다. 다시 만들지 않고 원문을 들고 있는다 */
    const colinfoXml = (body.match(/<colinfo\b[^>]*\/?>/g) || []).map((x) => '\n\t\t' + x).join('');

    const rows = [];
    const reRec = /<record\b[^>]*>([\s\S]*?)<\/record>/g;
    for (let r; (r = reRec.exec(body)); ) {
      // 저장 응답에는 <org_record> 가 중첩된다. 컬럼으로 세면 안 된다.
      const rec = r[1].replace(/<org_record>[\s\S]*?<\/org_record>/g, '');
      const row = {};
      const reCell = /<([A-Za-z_][\w.\-]*)\s*\/>|<([A-Za-z_][\w.\-]*)>([\s\S]*?)<\/\2>/g;
      for (let x; (x = reCell.exec(rec)); ) {
        if (x[1]) row[x[1]] = '';
        else row[x[2]] = unescapeXml(x[3]);
      }
      rows.push(row);
    }
    datasets[id] = { cols, colinfoXml, rows };
  }
  return { params, datasets };
}

// ── HTTP ──────────────────────────────────────────────────

/* raw:true 면 본문을 Buffer 그대로 준다. 첨부는 바이너리라 텍스트 디코딩을 하면 깨진다. */
function request(urlStr, { cookie, insecure, timeout = 60000, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const opt = {
      method: 'GET',
      headers: { 'User-Agent': 'kafri-wrapper', Accept: 'text/xml,*/*' },
    };
    if (cookie) opt.headers.Cookie = cookie;
    // 사내 서버 인증서가 유효하지 않을 수 있다. 기본은 검증하고, env 로만 끈다.
    if (u.protocol === 'https:' && insecure) opt.rejectUnauthorized = false;

    const req = mod.request(u, opt, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          setCookie: res.headers['set-cookie'] || [],
          headers: res.headers,
          body: raw ? buf : decodeBody(buf),
        });
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`timeout ${timeout}ms`)));
    req.on('error', reject);
    req.end();
  });
}

/*
 * 저장은 POST 본문 하나에 전부 담는다. 조회처럼 쿼리스트링으로 보내면 실패한다.
 * 본문 규칙이 까다롭다 — CRLF, 빈 줄 없음, 끝 개행 없음. 하나만 틀려도 서버가 거부한다.
 */
function post(urlStr, body, { cookie, insecure, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const buf = Buffer.from(body, 'utf8');
    const opt = {
      method: 'POST',
      headers: {
        /* 저장은 검증된 구현(MRW)과 같은 헤더를 쓴다. 여기서 다르게 굴 이유가 없다 */
        'User-Agent': 'MiPlatform 3.2;win32',
        Accept: '*/*',
        'Content-Type': 'text/xml;charset=utf-8',
        'Content-Length': buf.length,
      },
    };
    if (cookie) opt.headers.Cookie = cookie;
    if (u.protocol === 'https:' && insecure) opt.rejectUnauthorized = false;
    const req = mod.request(u, opt, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: decodeBody(Buffer.concat(cs)) }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`timeout ${timeout}ms`)));
    req.on('error', reject);
    req.end(buf);
  });
}

/* 조회로 받은 값을 그대로 되돌려 보낼 수 있게 맞춘다 (MRW kafriApiClient 에서 검증된 규칙) */
const DECIMAL_COLUMNS = new Set(['pub_dic_seq', 'rank', 'basi_val1', 'basi_val2', 'insp_amt']);
const BLOB_COLUMNS = ['file_content', 'file_content2', 'file_content3',
  'file_content4', 'file_content5', 'file_content6'];
/*
 * 조회 응답의 colinfo 에는 BLOB 6개가 없다(71개). 첨부를 보낼 때는 77개여야 한다 —
 * 빠지면 서버가 Index: -1, Size: 77 로 거부한다. encrypt 가 id 앞에 오는 것도 원본 그대로다.
 */
const BLOB_COLINFO = BLOB_COLUMNS
  .map((id) => `\t\t<colinfo encrypt="base64" id="${id}" size="256" summ="default" type="BLOB"/>`)
  .join('\n');

function normalizeValue(column, value) {
  let v = value == null ? '' : String(value);
  if (DECIMAL_COLUMNS.has(column) && /^-?\d+\.0$/.test(v)) v = v.slice(0, -2);
  if (v === '' && /^file_seq\d?$/.test(column)) v = '0';
  if (v === '' && (column === 'file_yn1' || column === 'file_yn2')) v = 'N';
  return v;
}

function escapeXml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/*
 * 레코드 하나를 XML 로. 컬럼 순서는 대소문자 무시 정렬이어야 한다 —
 * 그냥 sort() 하면 대문자 컬럼(R)이 맨 앞으로 가서 서버가 거부한다.
 */
function serializeRecord(values, { indent = '\t\t', attrs = '', orgValues = null } = {}) {
  const inner = `${indent}\t`;
  const byLower = (a, b) => a.toLowerCase().localeCompare(b.toLowerCase(), 'en');
  const lines = [`${indent}<record${attrs ? ` ${attrs}` : ''}>`];
  for (const name of Object.keys(values).sort(byLower)) {
    /* 빈 BLOB 은 자기닫힘 태그여야 한다. 빠뜨리면 Index: -1 로 거부된다 */
    if (BLOB_COLUMNS.includes(name) && values[name] === '') lines.push(`${inner}<${name}/>`);
    else lines.push(`${inner}<${name}>${values[name]}</${name}>`);
  }
  if (orgValues) {
    lines.push(`${inner}<org_record>`);
    for (const name of Object.keys(orgValues).sort(byLower)) {
      lines.push(`${inner}\t<${name}>${orgValues[name]}</${name}>`);
    }
    lines.push(`${inner}</org_record>`);
  }
  lines.push(`${indent}</record>`);
  return lines.join('\n');
}

/* CRLF · 빈 줄 없음 · 끝 개행 없음 */
function toWire(text) {
  return text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '').join('\r\n');
}

function qs(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v == null ? '' : v)}`)
    .join('&');
}

// ── 클라이언트 ────────────────────────────────────────────

class KafriClient {
  constructor({ employeeNo, baseUrl = DEFAULT_BASE, downloadBase = DOWNLOAD_BASE, insecure = false } = {}) {
    if (!employeeNo) throw new Error('사번이 없습니다. 로그인 화면에서 사번을 입력하세요.');
    this.employeeNo = String(employeeNo);
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.downloadBase = downloadBase.replace(/\/+$/, '');
    this.insecure = insecure;
    this.session = null; // { cookie, saupCd, userId, deptCd }
  }

  get servlet() {
    return `${this.baseUrl}/MainServlet`;
  }

  /* ID 만으로 로그인한다. 비밀번호는 없다(빈 값). */
  async login() {
    const url = `${this.servlet}?${qs({
      pgm: 'kafri.c.common.ab.ComLoginSLO',
      action: 'Login',
      edtID: this.employeeNo,
      edtPW: '',
      UserIP: '127.0.0.100',
    })}`;
    const res = await request(url, { insecure: this.insecure });
    if (res.status !== 200) throw new Error(`로그인 실패 HTTP ${res.status}`);

    const jar = res.setCookie
      .map((c) => c.split(';')[0])
      .filter((c) => c.startsWith('JSESSIONID='));
    const { params, datasets } = parseResponse(res.body);
    const cookie = jar[0] || (params.JSESSIONID ? `JSESSIONID=${params.JSESSIONID}` : null);
    if (!cookie) throw new Error('로그인 응답에 JSESSIONID 가 없습니다. 사번을 확인하세요.');

    /* 코드보다 이름이 쓸모 있다 — 화면에 '사업장 03' 대신 '부산지원' 을 띄운다. */
    this.session = {
      cookie,
      saupCd: params.GBL_SAUPCD || '03',
      userId: params.GBL_USERID || this.employeeNo,
      deptCd: params.GBL_DEPTCD || '',
      deptNm: params.GBL_DEPTNM || '',
      userNm: params.GBL_USERNM || '',
      menuCount: datasets.dsMenuList ? datasets.dsMenuList.rows.length : 0,
    };
    return this.session;
  }

  async ensureSession() {
    if (!this.session) await this.login();
    return this.session;
  }

  /* 조회 트랜잭션. 세션이 끊겼으면 한 번만 재로그인하고 재시도한다. */
  async search(params, { retry = true } = {}) {
    const s = await this.ensureSession();
    /*
     * GBL_DEPTCD·GBL_USERID 는 원본 앱이 조회·저장 가릴 것 없이 늘 함께 보낸다(2026-08-17 캡처).
     * 우리는 저장에만 넣고 조회에서 빠뜨리고 있었다 — 담당자 필터(sUSER_ID)가 0건이던
     * 1순위 용의자다. 한 곳에서 붙여 모든 조회가 같이 고쳐지게 한다.
     */
    const url = `${this.servlet}?${qs({
      sSAUP_CD: s.saupCd,
      GBL_DEPTCD: s.deptCd || '',
      GBL_USERID: s.userId,
      ...params,
    })}`;
    const res = await request(url, { cookie: s.cookie, insecure: this.insecure });
    const parsed = parseResponse(res.body);

    const dead =
      res.status === 200 &&
      Object.keys(parsed.datasets).length === 0 &&
      Object.keys(parsed.params).some((k) => /error|login/i.test(k));
    if (dead && retry) {
      this.session = null;
      return this.search(params, { retry: false });
    }
    if (res.status !== 200) throw new Error(`조회 실패 HTTP ${res.status}`);

    const err = Object.entries(parsed.params).find(([k]) => /^Error/i.test(k));
    if (err && err[1]) throw new Error(`서버 오류: ${err[0]}=${err[1]}`);
    return parsed;
  }

  /* 담당자별 접수현황 (CHEC0010). 반환은 항목 단위 행이다. */
  async listReceipts(o = {}) {
    const {
      from, to,
      userId = '',            // 담당자 사번
      field = '',              // 'micro' | 'all'
      includeUnpaid = true,   // 수납미완료 포함
      detail = false,         // 세부검사항목
      pageCount = 1000,
      endFrom = '', endTo = '',   // 완료일자
      custName = '',              // 업체명
      sampName = '',              // 시료명
      itemName = '',              // 검사항목명
      askCd = '',                 // 의뢰구분
      busiCd = '',                // 업무분야
      /*
       * 처리구분. 원본 앱은 빈값을 안 보낸다 — 늘 'Y' 아니면 'N' 이다(2026-08-17 캡처).
       * 나머지가 완전히 같은 두 요청에서 N→0건, Y→132건이었다.
       * 우리는 빈값으로도 행이 오므로 기본값은 그대로 둔다. 뜻을 모른 채 바꾸면 행이 조용히 사라진다.
       */
      endGb = '',
      recp1 = '', recp2 = '', recp3 = '',  // 접수구분 1~3
      returnChk = '',             // 반환시료여부
      pubDicCd = '',              // 공전규격
    } = o;
    if (!from || !to) throw new Error('접수일자 from/to 가 필요합니다 (YYYYMMDD).');
    const fp = fieldParams(field);

    /*
     * sPAGE_COUNT 는 상한이다. 넘치면 조용히 잘린다 — 현황 화면에서 지연 건이 사라진다.
     * 응답 첫 행의 MAX_PAGE 를 보고 남은 페이지를 이어 받는다.
     */
    const fetchPage = (page) => this.search({
      pgm: 'kafri.u.chec.ab.CHEC0010',
      action: 'SEARCH',
      sUSER_ID: userId,
      sRecp_dt_from: from,
      sRecp_dt_to: to,
      sChkMI: fp.micro ? 1 : 0,
      sChkSuNab: includeUnpaid ? 1 : 0,
      sChkAll: fp.all ? 1 : 0,
      sChkDetail: detail ? 1 : 0,
      sPAGE: page,
      sPAGE_COUNT: pageCount,
      sCboASK_CD: askCd,
      sCboBUSI_CD: busiCd,
      sCboEnd: endGb,
      sCboRecp_cd1: recp1,
      sCboRecp_cd2: recp2,
      sCboRecp_cd3: recp3,
      sCboReturn_Chk: returnChk,
      sCust_nm_kor: custName,
      sInsp_end_dt_from: endFrom,
      sInsp_end_dt_to: endTo,
      sPub_dic_cd: pubDicCd,
      sSamp_nm_kor: sampName,
      sTxtINSPNMacc: itemName,
    });

    const first = await fetchPage(1);
    const ds = first.datasets.dsGridList || { cols: [], rows: [] };
    const maxPage = Number((ds.rows[0] || {}).MAX_PAGE || 1) || 1;

    /*
     * 남은 쪽은 묶어서 동시에 받는다. 직렬이면 쪽마다 왕복이 그대로 쌓인다.
     * 90일 5쪽 실측(2026-08-17): 직렬 2447ms → 동시4 661ms (3.7배).
     * 상세(CHEC0020)와 다르다 — 그쪽은 동시 8을 걸면 서버가 직렬화해서 68건에 21초가 걸린다.
     */
    const last = Math.min(maxPage, PAGE_LIMIT);
    for (let p = 2; p <= last; p += PAGE_CONC) {
      const batch = [];
      for (let k = p; k <= Math.min(p + PAGE_CONC - 1, last); k++) batch.push(fetchPage(k));
      /* 순서를 지켜 이어붙인다 — 행 순서가 화면 정렬(접수순)의 기준이다 */
      for (const more of await Promise.all(batch)) {
        const d2 = more.datasets.dsGridList;
        if (d2 && d2.rows.length) ds.rows.push(...d2.rows);
      }
    }
    ds.pages = maxPage;
    ds.truncated = maxPage > PAGE_LIMIT;
    return ds;
  }

  /*
   * 민원접수 현황 (ACCE0020).
   *
   * 파라미터는 원본 앱 캡처 그대로다(2026-08-17). 추측으로는 못 맞췄던 자리다 —
   * 날짜 조건 6가지를 넣어보고 전부 0행이었다. **모듈마다 표기 규칙이 다르다**:
   * 검사관리는 `sRecp_dt_from`(소문자), 민원접수는 `sRECP_DT_STR`(대문자).
   * 클래스에 `.ab.` 가 없는 것도 검사관리와 다르다.
   *
   * 응답은 둘이 온다 — `dsResultList1`(57컬럼)이 본 데이터고 `...Copy` 는 45컬럼 사본이다.
   */
  async listComplaints({ from, to, inspNo = '', custName = '', sampName = '' } = {}) {
    if (!from || !to) throw new Error('접수일자 from/to 가 필요합니다 (YYYYMMDD).');
    const { datasets } = await this.search({
      pgm: 'kafri.u.acce.ACCE0020',
      action: 'SEARCH00',
      sRECP_DT_STR: from,
      sRECP_DT_END: to,
      sTabGubun: '0',
      sINSP_NO: inspNo,
      sASK_CUST_NM_KOR: custName,
      sSAMP_NM_KOR: sampName,
      sASK_CD: '',
      sBILL_CUST_NM: '',
      sBUSI_CD: '',
      sINSP_END_DT_STR: '',
      sINSP_END_DT_END: '',
      sINSP_END_YN: '',
      sQUT_ST_CD: '',
      sRECP_CD: '',
    });
    return datasets.dsResultList1 || { cols: [], rows: [] };
  }

  /* 시료번호별 실험결과 (CHEC0020). 파라미터명 sInsp_no 는 조회 전용 표기다. */
  async getSample(inspNo) {
    if (!inspNo) throw new Error('시료번호가 필요합니다.');
    const s = await this.ensureSession();
    const { datasets } = await this.search({
      pgm: 'kafri.u.chec.ab.CHEC0020',
      action: 'SEARCH',
      sInsp_no: String(inspNo),
      sUSER_ID: s.userId,
    });
    return {
      inspNo: String(inspNo),
      header: (datasets.dsSearch01 && datasets.dsSearch01.rows[0]) || null,
      items: (datasets.dsInspList && datasets.dsInspList.rows) || [],
      remarks: (datasets.dsRmkList && datasets.dsRmkList.rows) || [],
    };
  }

  /*
   * 기초코드 전수 (BASE0080/SEARCH00).
   * 그룹 82개 · 코드 853개가 한 번에 온다. 단위·판정 같은 표를 우리가 적어둘 이유가 없다 —
   * 적어두면 KAFRI 에서 코드가 늘 때 조용히 뒤처진다(실제로 미생물단위 6개 중 3개만 갖고 있었다).
   *   109 검체단위 · 114 검출단위 · 119 미생물단위 · 120 문자판정기준 · 320 규격단위
   */
  async getCodes() {
    const s = await this.ensureSession();
    const { datasets } = await this.search({
      pgm: 'kafri.u.base.BASE0080',
      action: 'SEARCH00',
      sSAUP_CD: s.saupCd,
    });
    const groups = {};
    for (const r of (datasets.dsResultList1 && datasets.dsResultList1.rows) || []) {
      groups[String(r.D_CODE).trim()] = { name: String(r.D_NAME || '').trim(), codes: {} };
    }
    for (const r of (datasets.dsResultList2 && datasets.dsResultList2.rows) || []) {
      const g = String(r.D_CODE).trim();
      const c = String(r.S_CODE).trim();
      const nm = String(r.S_NAME || '').trim();
      if (!g || !c || !nm) continue;
      if (!groups[g]) groups[g] = { name: '', codes: {} };
      groups[g].codes[c] = nm;
    }
    return groups;
  }

  /* 저장에 쓸 원본 dataset 을 그대로 돌려준다 — colinfo 원문과 컬럼 순서가 필요하다 */
  async getSampleRaw(inspNo) {
    const s = await this.ensureSession();
    return this.search({
      pgm: 'kafri.u.chec.ab.CHEC0020',
      action: 'SEARCH',
      sInsp_no: String(inspNo),
      sUSER_ID: s.userId,
    });
  }

  /*
   * 검사결과 저장 (CHEC0020/SAVE).
   * changes = [{ insp_cd, values: { det_value, letr_value, rmk, ... } }]
   *
   * 저장 직전에 다시 조회해서 org_record 를 만든다 — 낙관적 잠금이라
   * 그 사이 남이 고쳤으면 서버가 거부한다. 오래된 값으로 덮어쓰는 사고를 막는 장치다.
   */
  async saveResults(inspNo, changes) {
    if (!inspNo) throw new Error('시료번호가 필요합니다.');
    if (!changes || !changes.length) throw new Error('바꿀 값이 없습니다.');
    const s = await this.ensureSession();
    const no = String(inspNo).replace(/-/g, '');
    const before = await this.getSampleRaw(no);
    const insp = before.datasets.dsInspList;
    if (!insp) throw new Error('상세를 못 받았습니다(dsInspList 없음).');

    const byCode = new Map(insp.rows.map((r) => [String(r.insp_cd), r]));
    const recs = [];
    for (const ch of changes) {
      const cur = byCode.get(String(ch.insp_cd));
      if (!cur) throw new Error(`항목을 찾을 수 없습니다: ${ch.insp_cd}`);
      const org = {}, next = {};
      for (const col of insp.cols) {
        const v = escapeXml(normalizeValue(col, cur[col]));
        org[col] = v; next[col] = v;
      }
      for (const [col, val] of Object.entries(ch.values || {})) {
        if (!insp.cols.includes(col)) throw new Error(`없는 컬럼입니다: ${col}`);
        next[col] = escapeXml(normalizeValue(col, val));
      }
      recs.push(serializeRecord(next, { attrs: 'type="update"', orgValues: org }));
    }

    const rmk = before.datasets.dsRmkList;
    const s01 = before.datasets.dsSearch01;
    const head = (s01 && s01.rows[0]) || {};
    /*
     * 파라미터 구성·순서는 검증된 구현(MRW kafriApiClient)을 그대로 따른다.
     * JSESSIONID·Path·Secure 를 빼거나 순서를 바꾸면 서버가 errorCode=-1 로 거부한다.
     */
    const params = {
      action: 'SAVE',
      GBL_DEPTCD: s.deptCd || '',
      GBL_USERID: s.userId,
      JSESSIONID: String(s.cookie || '').replace(/^JSESSIONID=/, ''),
      Path: '/kfia',
      pgm: 'kafri.u.chec.ab.CHEC0020',
      Secure: '',
      sSAUP_CD: s.saupCd,
      sUSER_ID: s.userId,
      sINSP_NO: no,
      sRECP_NO: head.recp_no || '',
    };
    const body = toWire([
      '<?xml version="1.0" encoding="utf-8"?>',
      '<root>',
      '\t<params>',
      ...Object.entries(params).map(([k, v]) => `\t\t<param id="${k}" type="STRING">${escapeXml(v)}</param>`),
      '\t</params>',
      `\t<dataset id="dsInspList">${insp.colinfoXml}`,
      ...recs,
      '\t</dataset>',
      '\t<dataset id="dsLastGb">',
      '\t\t<colinfo id="last_gb" size="256" summ="default" type="STRING"/>',
      '\t\t<record>',
      '\t\t\t<last_gb></last_gb>',
      '\t\t</record>',
      '\t</dataset>',
      `\t<dataset id="dsRmkList">${rmk ? rmk.colinfoXml : ''}`,
      '\t</dataset>',
      `\t<dataset id="dsSearch01">${s01 ? s01.colinfoXml : ''}`,
      '\t</dataset>',
      '</root>',
    ].join('\n'));

    const res = await post(this.servlet, body, { cookie: s.cookie, insecure: this.insecure });
    if (res.status !== 200) throw new Error(`저장 실패 HTTP ${res.status}`);
    const parsed = parseResponse(res.body);
    /* errorCode 가 0 이 아니면 실패다. 코드만 보여주면 '거부: -1' 이 되어 아무 도움이 안 된다 */
    const p = parsed.params || {};
    const code = p.errorCode ?? p.ErrorCode;
    const emsg = p.errorMsg ?? p.ErrorMsg;
    if (code !== undefined && String(code).trim() !== '0') {
      throw new Error(`KAFRI 가 저장을 거부했습니다 — ${emsg || `errorCode=${code}`}`);
    }

    return this.verifySaved(no, changes);
  }

  /*
   * 저장 후 재조회 대조. 보냈다고 들어간 게 아니다 —
   * 서버가 200 을 주고도 값을 안 바꾸는 경우가 있어 눈으로 확인하는 단계가 필요하다.
   */
  async verifySaved(inspNo, changes) {
    const after = await this.getSample(inspNo);
    const byCode = new Map(after.items.map((r) => [String(r.insp_cd), r]));
    const bad = [];
    for (const ch of changes) {
      const row = byCode.get(String(ch.insp_cd)) || {};
      for (const [col, want] of Object.entries(ch.values || {})) {
        const got = String(row[col] ?? '').trim();
        if (got !== String(want ?? '').trim()) bad.push(`${ch.insp_cd}.${col}: 보낸값[${want}] 실제[${got}]`);
      }
    }
    if (bad.length) throw new Error(`저장 검증 실패 — ${bad.join(' · ')}`);
    return after;
  }

  /*
   * 첨부 올리기·지우기 (CHEC0020/SAVE_IMG). slot: 시험일지 1·3·5 / Rawdata 2·4·6.
   * SAVE 와 규격이 다르다 — dsInspList 하나만, 전 행을 평문 <record> 로 보낸다.
   * type="update" 도 <org_record> 도 없다.
   *
   * file 이 없으면 그 슬롯을 지운다(이름·내용을 빈 값으로 보낸다).
   */
  async saveAttachment(inspNo, { inspCd, slot = 1, fileName = '', buffer = null }) {
    if (!inspNo || !inspCd) throw new Error('시료번호와 검사항목이 필요합니다.');
    if (![1, 2, 3, 4, 5, 6].includes(Number(slot))) throw new Error(`슬롯이 1~6 이 아닙니다: ${slot}`);
    const s = await this.ensureSession();
    const no = String(inspNo).replace(/-/g, '');
    const before = await this.getSampleRaw(no);
    const insp = before.datasets.dsInspList;
    if (!insp) throw new Error('상세를 못 받았습니다(dsInspList 없음).');
    if (!insp.rows.some((r) => String(r.insp_cd) === String(inspCd))) {
      throw new Error(`항목을 찾을 수 없습니다: ${inspCd}`);
    }

    const suffix = String(slot) === '1' ? '' : String(slot);
    const base64 = buffer ? Buffer.from(buffer).toString('base64') : '';
    const recs = insp.rows.map((cur) => {
      const v = {};
      for (const col of insp.cols) v[col] = escapeXml(normalizeValue(col, cur[col]));
      for (const b of BLOB_COLUMNS) v[b] = '';
      if (String(cur.insp_cd) === String(inspCd)) {
        v[`file_seq${suffix}`] = buffer ? String(slot) : '0';
        v[`file_old_name${suffix}`] = escapeXml(fileName);
        /* file_path·file_new_name·file_yn 은 비워 보낸다 — 서버가 채운다 */
        v[`file_path${suffix}`] = '';
        v[`file_new_name${suffix}`] = '';
        v[Number(slot) % 2 === 1 ? 'file_yn1' : 'file_yn2'] = 'N';
        v[`file_content${suffix}`] = base64;
      }
      return serializeRecord(v);
    });

    const params = {
      action: 'SAVE_IMG',
      GBL_DEPTCD: s.deptCd || '',
      GBL_USERID: s.userId,
      JSESSIONID: String(s.cookie || '').replace(/^JSESSIONID=/, ''),
      Path: '/kfia',
      pgm: 'kafri.u.chec.ab.CHEC0020',
      Secure: '',
      sSAUP_CD: s.saupCd,
      sUSER_ID: s.userId,
    };
    const body = toWire([
      '<?xml version="1.0" encoding="utf-8"?>',
      '<root>',
      '\t<params>',
      ...Object.entries(params).map(([k, v]) => `\t\t<param id="${k}" type="STRING">${escapeXml(v)}</param>`),
      '\t</params>',
      `\t<dataset id="dsInspList">${insp.colinfoXml}\n${BLOB_COLINFO}`,
      ...recs,
      '\t</dataset>',
      '</root>',
    ].join('\n'));

    const res = await post(this.servlet, body, { cookie: s.cookie, insecure: this.insecure });
    if (res.status !== 200) throw new Error(`첨부 실패 HTTP ${res.status}`);
    const p = parseResponse(res.body).params || {};
    const code = p.errorCode ?? p.ErrorCode;
    if (code !== undefined && String(code).trim() !== '0') {
      throw new Error(`KAFRI 가 첨부를 거부했습니다 — ${p.errorMsg || p.ErrorMsg || `errorCode=${code}`}`);
    }

    /* 보냈다고 붙은 게 아니다. 다시 읽어 슬롯이 실제로 바뀌었는지 본다 */
    const after = await this.getSample(no);
    const row = after.items.find((r) => String(r.insp_cd) === String(inspCd)) || {};
    const stored = String(row[`file_new_name${suffix}`] || '').trim();
    if (buffer && !stored) throw new Error('첨부 검증 실패 — 저장된 파일명이 비어 있습니다');
    if (!buffer && stored) throw new Error('삭제 검증 실패 — 파일이 그대로 남아 있습니다');
    return after;
  }

  /* 첨부 1개를 바이트 그대로 가져온다. gstr 은 attachmentsOf 가 만들어 준다. */
  async downloadAttachment(gstr) {
    if (!gstr) throw new Error('첨부 경로가 없습니다.');
    const s = await this.ensureSession();
    const url = `${this.downloadBase}/upload/fileDownload.jsp?gstr=${gstr}`;
    const res = await request(url, { cookie: s.cookie, insecure: this.insecure, raw: true });
    if (res.status !== 200) throw new Error(`첨부 다운로드 실패 HTTP ${res.status}`);
    if (!res.body.length) throw new Error('첨부가 비어 있습니다.');
    return { buffer: res.body, contentType: res.headers['content-type'] || 'application/octet-stream' };
  }
}

/*
 * 상세(dsInspList)에서 첨부를 뽑는다. 슬롯 접미는 '' , 2..6.
 * 시험일지 1·3·5 / Rawdata 2·4·6 (kafri-api.md §4-4).
 * 순서는 항목 그리드 순 — 검토자가 결과표를 보는 순서와 같아야 대조가 된다.
 */
const SLOTS = ['', '2', '3', '4', '5', '6'];

function attachmentsOf(sample) {
  const out = [];
  (sample.items || []).forEach((it, order) => {
    for (const k of SLOTS) {
      const newName = it['file_new_name' + k];
      if (!newName) continue;
      const slot = k || '1';
      out.push({
        order,
        slot,
        journal: slot === '1' || slot === '3' || slot === '5',
        insp_cd: it.insp_cd,
        item: it.insp_kor_nm || '',
        name: newName,
        oldName: it['file_old_name' + k] || '',
        gstr: `KAFRI_DATA/${FILE_TABLE}/${it['file_path' + k] || ''}${newName}`,
        ext: (newName.match(/\.([A-Za-z0-9]+)$/) || [, ''])[1].toLowerCase(),
      });
    }
  });
  return out.sort((a, b) => a.order - b.order || a.slot.localeCompare(b.slot));
}

// ── 목록 가공 ─────────────────────────────────────────────

/*
 * KAFRI 의 "N건"은 행(=검사항목) 수다. 시료 하나가 항목 수만큼 여러 행으로 온다.
 * 화면은 시료 단위로 써야 하므로 insp_no 로 묶는다.
 */
function groupBySample(rows) {
  const map = new Map();
  for (const r of rows) {
    const no = r.insp_no;
    if (!no) continue;
    let g = map.get(no);
    if (!g) {
      g = {
        insp_no: no,
        samp_nm_kor: r.samp_nm_kor || '',
        recp_dt: r.recp_dt || '',
        recp_no: r.recp_no || '',
        insp_end_dt: r.insp_end_dt || '',
        cust_nm_kor: r.cust_nm_kor || '',
        ask_nm: r.ask_nm || '',
        busi_nm: r.busi_nm || '',
        itemCount: 0,
        persons: new Set(),
        rows: [],
      };
      map.set(no, g);
    }
    g.itemCount += 1;
    if (r.KNAME) g.persons.add(r.KNAME);
    g.rows.push(r);
  }
  return [...map.values()].map((g) => ({ ...g, persons: [...g.persons] }));
}

/* 시료번호 202611002025 → 2026-11-002025 (표시용. 전송에는 원본을 쓴다) */
function formatInspNo(no) {
  const s = String(no || '');
  return /^\d{12}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : s;
}

module.exports = {
  KafriClient,
  serializeRecord,
  toWire,
  normalizeValue,
  fieldParams,
  parseResponse,
  unescapeXml,
  groupBySample,
  formatInspNo,
  attachmentsOf,
  DEFAULT_BASE,
  DOWNLOAD_BASE,
};
