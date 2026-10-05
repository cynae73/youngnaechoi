import { isAuthed, json } from "../../_lib/auth.js";

// 사진·영상 설명 수정 (로그인 필요). body: { title: "설명" }  비우면 설명이 지워집니다.
export async function onRequestPatch({ request, env, params }) {
  if (!(await isAuthed(request, env))) return json({ error: "로그인이 필요해요." }, 401);
  let body = {};
  try { body = await request.json(); } catch {}
  const title = String(body.title ?? "").trim().slice(0, 100);
  const res = await env.DB.prepare("UPDATE items SET title = ? WHERE id = ?").bind(title, String(params.id)).run();
  if (!res.meta?.changes) return json({ error: "사진을 찾을 수 없어요." }, 404);
  return json({ title });
}
