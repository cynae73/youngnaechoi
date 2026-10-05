import { isAuthed, json } from "../../_lib/auth.js";
import { deleteKeys } from "../../_lib/media.js";

// 선택한 사진·영상을 한꺼번에 삭제합니다 (로그인 필요). body: { ids: [...] }
// 저장 공간의 파일과 목록 기록이 모두 지워지며 되돌릴 수 없습니다.
export async function onRequestPost({ request, env }) {
  if (!(await isAuthed(request, env))) return json({ error: "로그인이 필요해요." }, 401);
  let body = {};
  try { body = await request.json(); } catch {}
  const ids = [...new Set(Array.isArray(body.ids) ? body.ids.map(String) : [])];
  if (!ids.length) return json({ error: "삭제할 항목을 골라 주세요." }, 400);
  if (ids.length > 200) return json({ error: "한 번에 200개까지 삭제할 수 있어요." }, 400);

  const marks = ids.map(() => "?").join(",");
  const rows = (await env.DB.prepare(`SELECT id, src_key, thumb_key FROM items WHERE id IN (${marks})`).bind(...ids).all()).results;
  if (!rows.length) return json({ deleted: 0 });

  await env.DB.batch(rows.map(r => env.DB.prepare("DELETE FROM items WHERE id = ?").bind(r.id)));
  // 기록을 먼저 지우고 파일을 지웁니다. 파일 삭제가 실패해도 화면에서는 이미 사라진 상태가 됩니다.
  await deleteKeys(env, rows.flatMap(r => [r.src_key, r.thumb_key]));
  return json({ deleted: rows.length });
}
