'use strict';
/*
 * 업체 정보를 과거 접수에서 가져온다 (읽기 전용).
 * ACCE0020 응답의 컬럼명을 아직 모르므로 이름 규칙으로 추정하고, 원본 컬럼을 그대로 함께 돌려줘 사람이 확인할 수 있게 한다.
 */
const norm = (s) => String(s || '').replace(/[\s()（）㈜주식회사유한]/g, '').toLowerCase();
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

const RULES = {
  custCode: /^(ask_?)?cust_?(cd|code)$|업체코드/i,
  custName: /^(ask_?)?cust_?nm(_kor)?$/i,
  rep: /(rep|ceo|daepyo|boss)[a-z_]*(nm|name)?$|^rep|대표/i,
  addr: /^(ask_?)?(cust_?)?addr/i,
  tel: /^(ask_?)?(cust_?)?tel/i,
  bizno: /(saup|biz|corp|regi?)[a-z_]*(no|num)/i,
  billName: /^bill_?cust_?nm|^bill.*nm/i,
  billCode: /^bill_?cust_?cd|^bill.*cd/i,
  dmName: /^dm.*nm/i,
  dmAddr: /^dm.*addr/i,
  date: /recp_?dt|recp_?date|접수일/i,
};

function guess(row) {
  const keys = Object.keys(row);
  const g = {};
  Object.entries(RULES).forEach(([k, re]) => {
    const key = keys.find((x) => re.test(x));
    if (key !== undefined && String(row[key]).trim() !== '') g[k] = { column: key, value: String(row[key]).trim() };
  });
  return g;
}

async function lookup(client, name, { years = 3 } = {}) {
  const to = new Date();
  const from = new Date(); from.setFullYear(from.getFullYear() - years);
  const ds = await client.listComplaints({ from: ymd(from), to: ymd(to), custName: name });
  const rows = ds.rows || [];
  const want = norm(name);
  const exact = rows.filter((r) => Object.values(guess(r)).some((x) => x.column && /cust_?nm|업체/i.test(x.column) && norm(x.value) === want));
  const pool = exact.length ? exact : rows;
  const dateKey = (r) => { const g = guess(r).date; return g ? g.value.replace(/\D/g, '') : ''; };
  const sorted = [...pool].sort((a, b) => dateKey(b).localeCompare(dateKey(a)));
  const picked = sorted[0] || null;

  // 후보 업체(코드 기준)
  const byCode = new Map();
  pool.forEach((r) => {
    const g = guess(r);
    const code = g.custCode ? g.custCode.value : '(코드 미확인)';
    const e = byCode.get(code) || { code, name: g.custName ? g.custName.value : '', count: 0, latest: '' };
    e.count += 1; e.latest = e.latest > dateKey(r) ? e.latest : dateKey(r);
    byCode.set(code, e);
  });
  return {
    total: rows.length, exact: exact.length > 0, columns: ds.cols || (rows[0] ? Object.keys(rows[0]) : []),
    candidates: [...byCode.values()].sort((a, b) => b.latest.localeCompare(a.latest)).slice(0, 8),
    picked: picked ? { guess: guess(picked), row: picked } : null,
  };
}

async function duplicates(client, o, { days = 30 } = {}) {
  const to = new Date();
  const from = new Date(); from.setDate(from.getDate() - days);
  const ds = await client.listComplaints({ from: ymd(from), to: ymd(to), custName: o.requester.name, sampName: o.sample.name });
  const rows = ds.rows || [];
  const lot = norm(o.sample.lot);
  const sameLot = lot ? rows.filter((r) => Object.values(r).some((v) => norm(v) === lot)) : [];
  return { count: rows.length, sameLot: sameLot.length, sample: rows.slice(0, 3).map((r) => guess(r)) };
}

module.exports = { lookup, duplicates, guess };
