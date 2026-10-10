'use strict';
/*
 * 민원접수 등록.
 *
 * ■ 이 파일의 execute() 는 아직 서버에 저장하지 않는다.
 *   민원접수 등록 화면의 '저장' 요청 규격(프로그램ID, dataset/colinfo, 컬럼)이 캡처되지 않았다.
 *   규격을 확보하면 execute() 만 채우면 된다. 화면·검증·미리보기는 그대로 쓴다.
 *
 * buildPreview() 는 "서버로 보낼 값"을 사람이 읽는 형태로 보여 준다.
 */
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function buildPreview(o, ctx = {}) {
  const { company, codes, user } = ctx;
  const g = (company && company.picked && company.picked.guess) || {};
  const rows = [];
  const add = (section, label, value, source, state) => rows.push({ section, label, value: value == null ? '' : String(value), source, state: state || (value ? 'ok' : 'empty') });

  add('기본', '접수구분', '일반 검사', '기본값');
  add('기본', '의뢰구분', '식품', '기본값');
  add('기본', '접수자', user ? `${user.userId} ${user.userNm || ''}`.trim() : '', '로그인 사번');
  add('기본', '접수일자', today(), '오늘');
  add('기본', '접수번호', '(서버가 부여)', '서버');

  const code = g.custCode ? g.custCode.value : '';
  add('의뢰업체', '업체코드', code, code ? '과거 접수' : '미해결', code ? 'ok' : 'todo');
  add('의뢰업체', '업체명', o.requester.name, '의뢰서');
  add('의뢰업체', '대표자', o.requester.rep || (g.rep && g.rep.value), o.requester.rep ? '의뢰서' : '과거 접수');
  add('의뢰업체', '주소', o.requester.addr || (g.addr && g.addr.value), o.requester.addr ? '의뢰서' : '과거 접수');
  add('의뢰업체', '의뢰인명', o.requester.contact, '의뢰서');
  add('의뢰업체', '전화번호', o.requester.tel, '의뢰서');
  add('의뢰업체', '휴대폰번호', o.requester.mobile, '의뢰서');
  add('의뢰업체', '담당자 E-mail', o.requester.email, '의뢰서');

  add('계산서·성적서', '계산서 업체', o.billing.name || (g.billName && g.billName.value) || '(의뢰업체와 동일)', o.billing.name ? '의뢰서' : '과거 접수');
  add('계산서·성적서', '사업자번호', o.billing.bizno || (g.bizno && g.bizno.value), o.billing.bizno ? '의뢰서' : '과거 접수');
  add('계산서·성적서', '계산서 E-mail', o.billing.email, '의뢰서');
  add('계산서·성적서', 'DM 주소(성적서 수령)', o.report.addr || (g.dmAddr && g.dmAddr.value), o.report.addr ? '의뢰서' : '과거 접수');
  const cm = (k, label, text) => {
    const c = codes && codes[k];
    if (c && c.status === 'ok') add('계산서·성적서', label, `${c.name} (코드 ${c.code})`, '기초코드');
    else add('계산서·성적서', label, text, c ? '코드 확인 필요' : '의뢰서', text ? 'todo' : 'empty');
  };
  cm('purpose', '의뢰목적', o.purpose);
  cm('storage', '보관방법', o.storage);
  cm('delivery', '통보방법', o.report.delivery);
  add('계산서·성적서', '한글 / 영문 부수', `${o.report.korCopies || 0} / ${o.report.engCopies || 0}`, '의뢰서');

  add('시료', '한글시료명', o.sample.name, '의뢰서');
  add('시료', '식품유형', o.sample.foodType, '의뢰서 → 코드 조회 필요', 'todo');
  add('시료', '시료량', o.sample.amount ? `${o.sample.amount} ${o.sample.unit}` : '', '의뢰서');
  add('시료', '제조번호', o.sample.lot, '의뢰서');
  add('시료', '제조일자', o.sample.mfgDate, '의뢰서');
  add('시료', '유통기한', o.sample.expDate, '의뢰서');
  add('시료', '비고', o.remark, '의뢰서');
  o.items.forEach((it, i) => add('검사항목', `${i + 1}. ${it.name}`, it.spec ? `규격: ${it.spec}` : '', '의뢰서 → 항목코드·금액 조회 필요', 'todo'));

  return {
    rows,
    unresolved: rows.filter((r) => r.state === 'todo').map((r) => r.label),
    canRegister: false,
    why: '저장 요청 규격이 아직 캡처되지 않아 서버에 저장하지 않습니다 (드라이런).',
  };
}

async function execute() {
  const err = new Error('등록 모듈이 아직 연결되지 않았습니다. 민원접수 등록 화면의 저장 요청 규격을 캡처한 뒤 src/register.js 의 execute() 를 채우세요.');
  err.code = 'NOT_IMPLEMENTED';
  throw err;
}

module.exports = { buildPreview, execute };
