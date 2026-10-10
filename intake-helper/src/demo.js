'use strict';
/* KAFRI 에 접속하지 않고 화면을 시험하는 가짜 클라이언트. 값은 모두 꾸민 것이다. */
const rows = [
  { RECP_NO: '2609-0412', recp_dt: '20260918', cust_cd: '1070123', cust_nm_kor: '광동헬스바이오(주) 2공장', ceo_nm: '정화영', cust_addr: '충북 청주시 청원구 오창읍 양청송대길 38', cust_tel: '043-211-1056', saup_no: '215-81-31050', bill_cust_nm: '광동헬스바이오(주) 2공장', bill_cust_cd: '1070123', dm_addr: '충북 청주시 청원구 오창읍 양청송대길 39 품질관리팀', samp_nm_kor: '데모 시료 A' },
  { RECP_NO: '2606-0188', recp_dt: '20260611', cust_cd: '1070123', cust_nm_kor: '광동헬스바이오(주) 2공장', ceo_nm: '정화영', cust_addr: '충북 청주시 청원구 오창읍 양청송대길 38', cust_tel: '043-211-1056', saup_no: '215-81-31050', bill_cust_nm: '광동헬스바이오(주) 2공장', bill_cust_cd: '1070123', dm_addr: '충북 청주시 청원구 오창읍 양청송대길 38', samp_nm_kor: '데모 시료 B' },
  { RECP_NO: '2610-0685', recp_dt: '20261008', cust_cd: '1062019', cust_nm_kor: '(주)아워홈', ceo_nm: '김태원', cust_addr: '서울특별시 강서구 마곡중앙10로 91', cust_tel: '', saup_no: '107-81-76324', bill_cust_nm: '(주)아워홈', bill_cust_cd: '1062019', dm_addr: '서울특별시 강서구 마곡중앙10로 91 식품연구센터', samp_nm_kor: 'Gim Mix Crunch Anchovy & Sesame' },
];
const groups = {
  '201': { name: '의뢰목적', codes: { '01': '확인용(자사)', '02': '자가품질위탁검사', '03': '식품제조가공업검사', '04': '연구개발용', '05': '표시검사' } },
  '202': { name: '보관방법', codes: { '1': '실온', '2': '냉장', '3': '냉동' } },
  '203': { name: '통보방법', codes: { '1': '우편', '2': '메일', '3': '팩스', '4': '인편' } },
};

class DemoClient {
  constructor({ employeeNo }) { this.employeeNo = String(employeeNo || '0000000'); this.session = null; }
  async login() { this.session = { userId: this.employeeNo, userNm: '데모 사용자', deptNm: '데모' }; return this.session; }
  async listComplaints({ custName = '', sampName = '' } = {}) {
    const f = rows.filter((r) => (!custName || r.cust_nm_kor.replace(/\s/g, '').includes(custName.replace(/\s/g, ''))) && (!sampName || r.samp_nm_kor.includes(sampName)));
    return { cols: Object.keys(rows[0]), rows: f };
  }
  async getCodes() { return groups; }
}
module.exports = { DemoClient };
