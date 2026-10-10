'use strict';
/*
 * 감사 기록. 누가(사번) 언제 어디서(IP) 무엇을 했는지만 남긴다.
 * 의뢰서 내용, 업체명, 파일 이름, 비밀번호, API 키는 남기지 않는다.
 */
const fs = require('fs');
const path = require('path');

function create(dir, enabled = true) {
  let ok = enabled;
  if (ok) { try { fs.mkdirSync(dir, { recursive: true }); } catch { ok = false; } }
  return function log(event, info = {}) {
    if (!ok) return;
    const d = new Date();
    const line = JSON.stringify({ t: d.toISOString(), event, ...info }) + '\n';
    const file = path.join(dir, `audit-${d.toISOString().slice(0, 7)}.log`);
    fs.appendFile(file, line, () => { /* 기록 실패가 업무를 막지 않게 한다 */ });
  };
}

module.exports = { create };
