import { isAuthed, json } from "../../_lib/auth.js";

// 선택한 사진·영상을 다른 앨범으로 옮깁니다 (로그인 필요). body: { ids: [...], album_id: "대상 앨범" }
// 보낸 순서 그대로 대상 앨범의 맨 뒤에 붙습니다. 저장 공간의 파일은 그대로 두고 소속만 바꿉니다.
export async function onRequestPost({ request, env }) {
  if (!(await isAuthed(request, env))) return json({ error: "로그인이 필요해요." }, 401);
  let body = {};
  try { body = await request.json(); } catch {}
  const ids = [...new Set(Array.isArray(body.ids) ? body.ids.map(String) : [])];
  const target = String(body.album_id ?? "");
  if (!ids.length) return json({ error: "옮길 항목을 골라 주세요." }, 400);
  if (ids.length > 200) return json({ error: "한 번에 200개까지 옮길 수 있어요." }, 400);

  const album = await env.DB.prepare("SELECT id FROM albums WHERE id = ?").bind(target).first();
  if (!album) return json({ error: "옮길 앨범을 찾을 수 없어요." }, 404);

  const marks = ids.map(() => "?").join(",");
  const found = new Set((await env.DB.prepare(`SELECT id FROM items WHERE id IN (${marks})`).bind(...ids).all()).results.map(r => r.id));
  const moving = ids.filter(id => found.has(id));
  if (!moving.length) return json({ moved: 0 });

  const now = Date.now();
  try {
    await env.DB.batch(moving.map((id, i) =>
      env.DB.prepare("UPDATE items SET album_id = ?, sort_order = ? WHERE id = ?").bind(target, now + i, id)));
  } catch {
    // D1 업데이트 전의 옛 구조
    await env.DB.batch(moving.map(id => env.DB.prepare("UPDATE items SET album_id = ? WHERE id = ?").bind(target, id)));
  }
  return json({ moved: moving.length });
}
