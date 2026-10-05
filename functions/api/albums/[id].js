import { isAuthed, json } from "../../_lib/auth.js";
import { deleteKeys } from "../../_lib/media.js";

// 앨범을 통째로 삭제합니다 (로그인 필요). 안의 사진·영상·음악 파일도 모두 지워지며 되돌릴 수 없습니다.
export async function onRequestDelete({ request, env, params }) {
  if (!(await isAuthed(request, env))) return json({ error: "로그인이 필요해요." }, 401);
  const id = String(params.id);
  const album = await env.DB.prepare("SELECT id FROM albums WHERE id = ?").bind(id).first();
  if (!album) return json({ error: "앨범을 찾을 수 없어요." }, 404);

  const items = (await env.DB.prepare("SELECT src_key, thumb_key FROM items WHERE album_id = ?").bind(id).all()).results;
  let musicKey = null;
  try { musicKey = (await env.DB.prepare("SELECT music_key FROM albums WHERE id = ?").bind(id).first())?.music_key; } catch {}

  await env.DB.batch([
    env.DB.prepare("DELETE FROM items WHERE album_id = ?").bind(id),
    env.DB.prepare("DELETE FROM albums WHERE id = ?").bind(id),
  ]);
  await deleteKeys(env, [...items.flatMap(r => [r.src_key, r.thumb_key]), musicKey]);
  return json({ deleted: items.length });
}
