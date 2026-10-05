import { isAuthed, json } from "../../../_lib/auth.js";

// 앨범 안 사진·영상의 순서를 저장합니다 (로그인 필요). body: { ids: [앞에서부터 순서대로 모든 항목 id] }
export async function onRequestPost({ request, env, params }) {
  if (!(await isAuthed(request, env))) return json({ error: "로그인이 필요해요." }, 401);
  let body = {};
  try { body = await request.json(); } catch {}
  const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];

  const current = (await env.DB.prepare("SELECT id FROM items WHERE album_id = ?").bind(String(params.id)).all()).results.map(r => r.id);
  const same = ids.length === current.length && new Set(ids).size === ids.length && ids.every(i => current.includes(i));
  if (!same) return json({ error: "앨범 내용이 바뀌었어요. 새로고침한 뒤 다시 해 주세요." }, 409);

  try {
    // 1, 2, 3 … 순서로 다시 매깁니다. 이후에 올리는 사진은 현재 시각 값이라 항상 맨 뒤에 붙습니다.
    await env.DB.batch(ids.map((id, i) => env.DB.prepare("UPDATE items SET sort_order = ? WHERE id = ?").bind(i + 1, id)));
  } catch {
    return json({ error: "순서를 저장하려면 D1 업데이트가 필요해요. (docs/SETUP.md 참고)" }, 500);
  }
  return json({ ok: true });
}
