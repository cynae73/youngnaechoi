import { isAuthed, json } from "../../../_lib/auth.js";
import { deleteKeys } from "../../../_lib/media.js";

const MAX_MUSIC = 15 * 1024 * 1024;
const TYPES = { "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/ogg": "ogg", "audio/wav": "wav", "audio/x-wav": "wav" };
const EXT = { mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", wav: "audio/wav" };

// 앨범 음악 등록/교체 (로그인 필요). multipart: file(음원), title(곡 이름, 선택)
export async function onRequestPut({ request, env, params }) {
  if (!(await isAuthed(request, env))) return json({ error: "로그인이 필요해요." }, 401);
  const albumId = String(params.id);

  let form;
  try { form = await request.formData(); } catch { return json({ error: "올바른 업로드 형식이 아니에요." }, 400); }
  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "음악 파일이 없어요." }, 400);

  const ext = TYPES[file.type] || (file.name.split(".").pop() || "").toLowerCase();
  if (!EXT[ext]) return json({ error: "mp3, m4a, aac, ogg, wav 파일만 올릴 수 있어요." }, 415);
  if (file.size > MAX_MUSIC) return json({ error: "음악 파일이 너무 커요. (최대 15MB)" }, 413);

  let album;
  try { album = await env.DB.prepare("SELECT id, music_key FROM albums WHERE id = ?").bind(albumId).first(); }
  catch { return json({ error: "음악을 쓰려면 D1 업데이트가 필요해요. (docs/SETUP.md 참고)" }, 500); }
  if (!album) return json({ error: "앨범을 찾을 수 없어요." }, 404);

  const title = String(form.get("title") ?? "").trim().slice(0, 80) || file.name.replace(/\.[^.]+$/, "").slice(0, 80);
  const key = `music/${albumId}/${crypto.randomUUID()}.${ext}`;
  await env.BUCKET.put(key, file.stream(), { httpMetadata: { contentType: EXT[ext] } });
  await env.DB.prepare("UPDATE albums SET music_key = ?, music_title = ? WHERE id = ?").bind(key, title, albumId).run();
  await deleteKeys(env, [album.music_key]); // 이전 곡 파일 정리
  return json({ title }, 200);
}

// 앨범 음악 삭제 (로그인 필요)
export async function onRequestDelete({ request, env, params }) {
  if (!(await isAuthed(request, env))) return json({ error: "로그인이 필요해요." }, 401);
  const albumId = String(params.id);
  let album;
  try { album = await env.DB.prepare("SELECT music_key FROM albums WHERE id = ?").bind(albumId).first(); }
  catch { return json({ error: "음악을 쓰려면 D1 업데이트가 필요해요. (docs/SETUP.md 참고)" }, 500); }
  if (!album) return json({ error: "앨범을 찾을 수 없어요." }, 404);
  await env.DB.prepare("UPDATE albums SET music_key = NULL, music_title = NULL WHERE id = ?").bind(albumId).run();
  await deleteKeys(env, [album.music_key]);
  return json({ ok: true });
}
