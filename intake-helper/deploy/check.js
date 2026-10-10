'use strict';
/* node deploy/check.js [--url http://127.0.0.1:8791] — 설치·설정 점검. 오류가 있으면 종료 코드 1 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const cfg = require('../src/config');

cfg.loadEnv(path.join(__dirname, '..', '.env'));
const C = cfg.build();
let bad = 0;
const ok = (m) => console.log('  [정상] ' + m);
const warn = (m) => console.log('  [주의] ' + m);
const err = (m) => { bad += 1; console.log('  [오류] ' + m); };

(async () => {
  console.log('\n접수 도우미 점검');
  const major = Number(process.versions.node.split('.')[0]);
  (major >= 18 ? ok : err)(`Node.js ${process.versions.node}${major >= 18 ? '' : ' (18 이상 필요)'}`);
  try { ['exceljs', 'jszip', 'pdfjs-dist/package.json'].forEach((m) => require.resolve(m)); ok('필요한 라이브러리가 설치되어 있습니다'); } catch (e) { err('라이브러리가 없습니다. npm ci 를 실행하세요 (' + e.message.split('\n')[0] + ')'); }
  if (!fs.existsSync(path.join(__dirname, '..', '.env'))) warn('.env 파일이 없습니다(.env.server.example 을 복사하세요)');

  C.errors.forEach(err);
  C.warnings.forEach(warn);
  if (!C.errors.length) ok(`설정: ${C.shared ? '공유 서버' : '내 PC 전용'} · ${C.host}:${C.port}${C.publicUrl ? ' · ' + C.publicUrl : ''}`);
  if (C.shared && C.password && C.password.length < 12) warn('접속 비밀번호가 12자 미만입니다. 더 길게 쓰는 것을 권장합니다');
  if (C.shared && !C.demo) { /* 아래에서 KAFRI 확인 */ }

  try { fs.mkdirSync(C.logDir, { recursive: true }); fs.accessSync(C.logDir, fs.constants.W_OK); ok(`기록 폴더 쓰기 가능: ${C.logDir}`); } catch { err(`기록 폴더에 쓸 수 없습니다: ${C.logDir}`); }
  try { fs.readdirSync(path.join(__dirname, '..', 'rules')).some((f) => f.endsWith('.json')) ? ok('양식 규칙(rules/*.json)이 있습니다') : warn('rules/ 에 양식 규칙이 없어 고정 양식 변환을 쓸 수 없습니다'); } catch { warn('rules/ 폴더가 없습니다'); }

  if (!C.demo) {
    const base = process.env.KAFRI_BASE_URL || require('../src/kafri-core').DEFAULT_BASE;
    try {
      const u = new URL(base);
      const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
      await new Promise((res, rej) => {
        const s = net.connect({ host: u.hostname, port, timeout: 5000 }, () => { s.destroy(); res(); });
        s.on('timeout', () => { s.destroy(); rej(new Error('시간 초과')); });
        s.on('error', rej);
      });
      ok(`연구관리시스템에 연결할 수 있습니다 (${u.hostname}:${port})`);
    } catch (e) { warn(`연구관리시스템(${base})에 연결되지 않습니다: ${e.message}. 사내망에서 실행하는지, 방화벽을 확인하세요`); }
  }

  const i = process.argv.indexOf('--url');
  if (i > 0) {
    const url = process.argv[i + 1].replace(/\/+$/, '') + '/healthz';
    try { const r = await fetch(url); const j = await r.json(); j.ok ? ok(`서버가 응답합니다 (${url})`) : err('서버 응답이 이상합니다'); }
    catch (e) { err(`서버가 응답하지 않습니다 (${url}): ${e.message}. 서비스가 시작되었는지 확인하세요`); }
  }
  console.log(bad ? `\n오류 ${bad}건. 위 내용을 고친 뒤 다시 점검하세요.\n` : '\n점검을 마쳤습니다.\n');
  process.exit(bad ? 1 : 0);
})();
