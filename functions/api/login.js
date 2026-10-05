import { checkPassword, makeCookie, clearCookie, isAuthed, json } from "../_lib/auth.js";

// GET: 로그인 상태 확인 / POST: 로그인 / DELETE: 로그아웃
export async function onRequestGet({ request, env }) {
  return json({ authed: await isAuthed(request, env) });
}

export async function onRequestPost({ request, env }) {
  let body = {};
  try { body = await request.json(); } catch {}
  if (!(await checkPassword(env, body.password ?? ""))) {
    await new Promise(r => setTimeout(r, 800)); // 무작위 대입을 느리게 합니다.
    return json({ error: "비밀번호가 맞지 않아요." }, 401);
  }
  return json({ authed: true }, 200, { "Set-Cookie": await makeCookie(env, request.url) });
}

export async function onRequestDelete() {
  return json({ authed: false }, 200, { "Set-Cookie": clearCookie() });
}
