'use strict';
/*
 * 실행 설정. .env(또는 환경 변수)에서 읽는다.
 *  - HOST 가 127.0.0.1 이면 "내 PC 전용" (기존 방식, 접속 비밀번호 없음)
 *  - 그 밖의 주소(0.0.0.0 등)면 "공유 서버" 로 보고, 접속 비밀번호(ACCESS_PASSWORD) 없이는 시작하지 않는다.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((l) => {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
}

const list = (v) => String(v || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const isLoopback = (h) => /^(127\.|localhost$|::1$|\[::1\]$)/i.test(h);

function build(env = process.env) {
  const host = (env.HOST || '127.0.0.1').trim();
  const port = num(env.PORT, 8791);
  // 프록시(nginx 등) 뒤에 두거나 SHARED=1 이면, 서버가 127.0.0.1 에 묶여 있어도 공유 서버로 본다(접속 비밀번호 필수).
  const shared = !isLoopback(host) || env.SHARED === '1' || env.TRUST_PROXY === '1';
  const tls = !!(env.TLS_CERT && env.TLS_KEY);
  const publicUrl = (env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  const hosts = new Set();
  if (!shared) { hosts.add(`127.0.0.1:${port}`); hosts.add(`localhost:${port}`); }
  if (publicUrl) { try { hosts.add(new URL(publicUrl).host.toLowerCase()); } catch { /* 아래에서 오류로 보고 */ } }
  list(env.ALLOWED_HOSTS).forEach((h) => hosts.add(h.toLowerCase()));

  const c = {
    root: ROOT, host, port, shared, tls, publicUrl,
    hosts,
    password: env.ACCESS_PASSWORD || '',
    sessionHours: num(env.SESSION_HOURS, 8),
    maxSessions: num(env.MAX_SESSIONS, 200),
    maxBodyMb: num(env.MAX_UPLOAD_MB, shared ? 60 : 120),
    allowedIps: list(env.ALLOWED_IPS),
    allowedEmployees: list(env.ALLOWED_EMPLOYEES),
    trustProxy: env.TRUST_PROXY === '1',
    secureCookie: tls || /^https:/i.test(publicUrl) || env.TRUST_PROXY === '1',
    logDir: path.resolve(ROOT, env.LOG_DIR || 'logs'),
    tlsCert: env.TLS_CERT || '', tlsKey: env.TLS_KEY || '',
    demo: env.KAFRI_DEMO === '1',
  };

  const errors = [];
  const warnings = [];
  if (shared) {
    if (!c.password) errors.push('공유 서버로 열려면 ACCESS_PASSWORD(접속 비밀번호)를 .env 에 설정해야 합니다.');
    else if (c.password.length < 8) errors.push('ACCESS_PASSWORD 는 8자 이상이어야 합니다.');
    if (!c.hosts.size) errors.push('PUBLIC_URL(예: https://intake.example.go.kr) 또는 ALLOWED_HOSTS 를 설정해야 합니다.');
    if (!tls && !c.secureCookie) warnings.push('HTTPS 가 아닙니다. 사번·의뢰서가 평문으로 오갑니다. TLS_CERT/TLS_KEY 를 설정하거나 HTTPS 프록시(nginx 등) 뒤에 두세요.');
    if (!c.allowedIps.length) warnings.push('ALLOWED_IPS 가 비어 있어 같은 망의 모든 PC 가 접속을 시도할 수 있습니다.');
    if (!c.allowedEmployees.length) warnings.push('ALLOWED_EMPLOYEES 가 비어 있어 어떤 사번으로든 연결할 수 있습니다.');
  }
  if (publicUrl && !/^https?:\/\/[^/]+$/i.test(publicUrl)) errors.push('PUBLIC_URL 은 http(s)://주소[:포트] 형식이어야 합니다(경로 없이).');
  if ((env.TLS_CERT && !env.TLS_KEY) || (!env.TLS_CERT && env.TLS_KEY)) errors.push('TLS_CERT 와 TLS_KEY 는 함께 설정해야 합니다.');
  if (tls) {
    [['TLS_CERT', c.tlsCert], ['TLS_KEY', c.tlsKey]].forEach(([k, f]) => { if (!fs.existsSync(path.resolve(ROOT, f))) errors.push(`${k} 파일을 찾을 수 없습니다: ${f}`); });
  }
  c.errors = errors; c.warnings = warnings;
  return c;
}

module.exports = { loadEnv, build, isLoopback, list };
