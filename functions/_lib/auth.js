// 가족 비밀번호 로그인. 성공하면 서명된 쿠키를 발급하고, 업로드·삭제 때 이 쿠키를 확인합니다.
const COOKIE = "fa_session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30일
const enc = new TextEncoder();

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return [...sig].map(b => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function checkPassword(env, input) {
  if (!env.UPLOAD_PASSWORD || !env.SESSION_SECRET) return false;
  // 같은 길이로 맞춘 해시끼리 비교해 길이로 추측하지 못하게 합니다.
  const [a, b] = await Promise.all([hmac("pw", String(input)), hmac("pw", env.UPLOAD_PASSWORD)]);
  return safeEqual(a, b);
}

export async function makeCookie(env, url) {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
  const sig = await hmac(env.SESSION_SECRET, String(exp));
  const secure = new URL(url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${exp}.${sig}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE}${secure}`;
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export async function isAuthed(request, env) {
  if (!env.SESSION_SECRET) return false;
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=(\\d+)\\.([0-9a-f]+)`));
  if (!m) return false;
  if (Number(m[1]) < Date.now() / 1000) return false;
  return safeEqual(m[2], await hmac(env.SESSION_SECRET, m[1]));
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}
