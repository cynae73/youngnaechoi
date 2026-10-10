'use strict';
/*
 * 의뢰서(사진·PDF) → 접수 모델. Claude API 의 도구 호출(tool_use)로 정해진 구조만 받는다.
 * 키는 .env 의 ANTHROPIC_API_KEY. 코드·문서·로그에 남기지 않는다.
 */
const https = require('https');
const { URL } = require('url');
const M = require('./model');

const API_URL = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages';
const MODEL = () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

const S = { type: 'string' };
const TOOL = {
  name: 'submit_orders',
  description: '의뢰서에서 읽은 접수 목록을 제출한다. 시료 1건당 접수 1건이다.',
  input_schema: {
    type: 'object',
    properties: {
      orders: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            requestDate: { ...S, description: '의뢰일 YYYY-MM-DD' },
            receiptNoHint: { ...S, description: '의뢰서 상단 접수번호 칸(손글씨 포함)에 적힌 값. 없으면 빈 문자열' },
            requester: { type: 'object', properties: { name: S, rep: S, addr: S, tel: S, fax: S, mobile: S, email: S, contact: { ...S, description: '의뢰인(담당자) 성명' } } },
            billing: { type: 'object', properties: { name: S, bizno: S, email: S, contact: S } },
            report: { type: 'object', properties: { addr: { ...S, description: '성적서 수령주소' }, korCopies: S, engCopies: S, delivery: { ...S, description: '체크된 전달방법을 쉼표로. 예: 우편, 메일' } } },
            purpose: { ...S, description: '체크된 의뢰목적 문구 그대로' },
            storage: { ...S, description: '체크된 보관방법. 상온/냉장/냉동' },
            sample: { type: 'object', properties: { name: S, foodType: S, kind: { ...S, description: '체크된 시료구분(완제품/원료/소분제품/시제품 등)' }, amountRaw: { ...S, description: '시료량 칸 원문 그대로' }, lot: S, mfgDate: S, expDate: S } },
            items: { type: 'array', items: { type: 'object', properties: { name: { ...S, description: '시험항목 이름' }, spec: { ...S, description: '기준·규격(있으면)' }, note: S } } },
            remark: S,
            sourcePages: { ...S, description: '이 접수의 근거가 된 파일명과 쪽. 예: 본지 1쪽, 별첨 2쪽' },
            flags: {
              type: 'array',
              description: '판독이 불확실하거나 원본에 근거가 약한 필드. 추측으로 채운 값은 반드시 여기에 올린다.',
              items: { type: 'object', properties: { path: { ...S, description: '필드 경로. 예: sample.lot, requester.mobile, items.0.name' }, reason: S }, required: ['path', 'reason'] },
            },
          },
          required: ['requester', 'sample', 'items'],
        },
      },
      notes: { ...S, description: '묶음 전체에 대한 참고(별첨 누락, 양식 이상 등). 없으면 빈 문자열' },
    },
    required: ['orders'],
  },
};

const SYSTEM = `당신은 한국식품과학연구원 접수 담당자를 돕는 판독 보조입니다. 시험·검사 의뢰서(사진, 스캔, PDF)와 별첨을 읽어 연구관리시스템 민원접수 등록 값으로 바꿉니다.

양식 설명
- 의뢰인 블록(업체명, 주소, 전화, 핸드폰, 대표자, 팩스, 이메일, 의뢰인 성명), 계산서 정보 블록(업체명, 사업자번호, 이메일, 대표자, 주소, 담당자 연락처)이 있습니다. 사업자번호는 계산서 블록의 값입니다.
- 성적서수령, 의뢰목적, 성적서 부수·전달방법, 보관방법, 시료정보 표(시료명, 식품유형/재질, 시료량, 제조번호, 제조일자, 유통기한, 시험항목)가 있습니다.
- 체크박스는 ■ 이 선택, □ 이 미선택입니다. 선택된 칸만 값으로 씁니다. 여러 개가 선택되면 모두 씁니다.
- 사진이 90도 회전되어 있을 수 있습니다. 회전을 보정해서 읽으세요.
- 상단의 빨간 손글씨 접수번호는 접수 담당이 적은 참고 번호입니다. 읽은 대로 receiptNoHint 에 쓰되 불확실하면 flags 에 올립니다.

규칙
1. 접수 단위는 시료 1건입니다. 한 의뢰서에 시료가 여러 개면 orders 를 시료 수만큼 만들고, 의뢰인·계산서·성적서 같은 공통 정보를 각 접수에 반복합니다.
2. 시험항목은 시료마다 따로 적습니다. 본지에 "별첨 참조"라고만 있으면 별첨의 목록을 사용하고, 별첨이 없으면 items 를 비우고 notes 에 "별첨 누락"이라고 씁니다.
3. 원본에 없는 값을 만들지 마세요. 읽을 수 없으면 빈 문자열로 두고 flags 에 이유를 씁니다. 글씨가 흐리거나 체크 위치가 애매하면 가장 가능성 높은 값을 쓰고 반드시 flags 에 올립니다.
4. 제조일자 등이 '-' 로 적혀 있으면 빈 문자열로 둡니다.
5. 날짜는 YYYY-MM-DD, 전화는 하이픈 포함, 사업자번호는 000-00-00000 형식으로 씁니다.
6. 시료량은 amountRaw 에 칸의 글자 그대로 씁니다. 숫자·단위 해석은 하지 마세요.
7. 이름, 번호, 주소는 글자 하나까지 정확히 옮깁니다. 비슷한 글자를 임의로 고치지 마세요.
8. 결과는 반드시 submit_orders 도구로만 제출합니다.`;

function postJson(urlStr, headers, body, timeout = 240000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : require('http');
    const buf = Buffer.from(JSON.stringify(body), 'utf8');
    const req = mod.request(u, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'content-length': buf.length } }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(cs).toString('utf8') }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error('AI 응답 시간이 초과되었습니다.')));
    req.on('error', reject);
    req.end(buf);
  });
}

/* files: [{name, mediaType, data(base64)}] — 한 의뢰 묶음(본지+별첨) */
async function extractBundle(files) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw Object.assign(new Error('ANTHROPIC_API_KEY 가 설정되어 있지 않습니다. .env 파일에 넣거나 엑셀 불러오기를 사용하세요.'), { code: 'NO_KEY' });
  if (!files || !files.length) throw new Error('파일이 없습니다.');

  const content = [];
  files.forEach((f, i) => {
    content.push({ type: 'text', text: `파일 ${i + 1}: ${f.name}` });
    if (f.mediaType === 'application/pdf') content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data } });
    else content.push({ type: 'image', source: { type: 'base64', media_type: f.mediaType || 'image/jpeg', data: f.data } });
  });
  content.push({ type: 'text', text: '위 파일들은 한 건의 의뢰 묶음입니다(본지와 별첨). 시료 1건당 접수 1건으로 submit_orders 에 제출하세요.' });

  const res = await postJson(API_URL, { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, {
    model: MODEL(), max_tokens: 8000, system: SYSTEM,
    tools: [TOOL], tool_choice: { type: 'tool', name: 'submit_orders' },
    messages: [{ role: 'user', content }],
  });
  let json;
  try { json = JSON.parse(res.text); } catch { throw new Error(`AI 응답을 읽지 못했습니다 (HTTP ${res.status}).`); }
  if (res.status !== 200) {
    const msg = (json.error && json.error.message) || `HTTP ${res.status}`;
    throw new Error(`AI 호출 실패: ${msg}`);
  }
  const tu = (json.content || []).find((c) => c.type === 'tool_use' && c.name === 'submit_orders');
  if (!tu) throw new Error('AI 가 구조화된 결과를 돌려주지 않았습니다.');
  const names = files.map((f) => f.name);
  const orders = (tu.input.orders || []).map((raw) => {
    const o = M.normalize({ ...raw, source: { files: names, pages: raw.sourcePages || '', note: tu.input.notes || '' } });
    // 정규화 단계에서 시료량 추정이 생기면 이유가 붙는다. 시험항목이 없으면 별첨 누락 가능성을 알린다.
    return o;
  });
  return { orders, notes: tu.input.notes || '', usage: json.usage || null, model: json.model || MODEL() };
}

module.exports = { extractBundle };
