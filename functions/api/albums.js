import { isAuthed, json } from "../_lib/auth.js";

const mediaUrl = key => "media/" + key.split("/").map(encodeURIComponent).join("/");

// 앨범과 그 안의 사진·영상 목록 (누구나 볼 수 있음)
export async function onRequestGet({ env }) {
  const [albums, items] = await Promise.all([
    env.DB.prepare("SELECT id, title, description FROM albums ORDER BY created_at DESC").all(),
    env.DB.prepare("SELECT id, album_id, type, title, src_key, thumb_key FROM items ORDER BY created_at ASC").all(),
  ]);
  const byAlbum = new Map();
  for (const it of items.results) {
    if (!byAlbum.has(it.album_id)) byAlbum.set(it.album_id, []);
    byAlbum.get(it.album_id).push({
      id: it.id, type: it.type, title: it.title,
      src: mediaUrl(it.src_key), thumb: mediaUrl(it.thumb_key),
    });
  }
  return json({
    albums: albums.results.map(a => {
      const list = byAlbum.get(a.id) || [];
      return { ...a, cover: list[0]?.thumb || "", items: list };
    }),
  });
}

// 새 앨범 만들기 (로그인 필요)
export async function onRequestPost({ request, env }) {
  if (!(await isAuthed(request, env))) return json({ error: "로그인이 필요해요." }, 401);
  let body = {};
  try { body = await request.json(); } catch {}
  const title = String(body.title ?? "").trim().slice(0, 60);
  if (!title) return json({ error: "앨범 이름을 입력해 주세요." }, 400);
  const id = crypto.randomUUID().slice(0, 8);
  const description = String(body.description ?? "").trim().slice(0, 200);
  await env.DB.prepare("INSERT INTO albums (id, title, description, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, title, description, Date.now()).run();
  return json({ id, title, description }, 201);
}
