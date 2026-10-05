import { isAuthed, json } from "../_lib/auth.js";

const MAX_PHOTO = 8 * 1024 * 1024;   // 브라우저에서 줄인 뒤의 크기 기준
const MAX_VIDEO = 50 * 1024 * 1024;  // 쇼츠 기준
const MAX_THUMB = 1 * 1024 * 1024;
const VIDEO_EXT = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };

// 사진/영상 1개 업로드 (로그인 필요). multipart: album_id, title, file, thumb
export async function onRequestPost({ request, env }) {
  if (!(await isAuthed(request, env))) return json({ error: "로그인이 필요해요." }, 401);

  let form;
  try { form = await request.formData(); } catch { return json({ error: "올바른 업로드 형식이 아니에요." }, 400); }

  const albumId = String(form.get("album_id") ?? "");
  const file = form.get("file");
  const thumb = form.get("thumb");
  const title = String(form.get("title") ?? "").trim().slice(0, 100);
  if (!(file instanceof File) || !(thumb instanceof File)) return json({ error: "파일이 없어요." }, 400);

  const album = await env.DB.prepare("SELECT id FROM albums WHERE id = ?").bind(albumId).first();
  if (!album) return json({ error: "앨범을 찾을 수 없어요." }, 404);

  const isVideo = file.type in VIDEO_EXT;
  const isPhoto = file.type === "image/jpeg";
  if (!isVideo && !isPhoto) return json({ error: "사진(JPG)과 영상(mp4, mov, webm)만 올릴 수 있어요." }, 415);
  if (thumb.type !== "image/jpeg" || thumb.size > MAX_THUMB) return json({ error: "미리보기 이미지가 올바르지 않아요." }, 400);
  if (isPhoto && file.size > MAX_PHOTO) return json({ error: "사진이 너무 커요. (최대 8MB)" }, 413);
  if (isVideo && file.size > MAX_VIDEO) return json({ error: "영상이 너무 커요. (최대 50MB)" }, 413);

  const id = crypto.randomUUID();
  const base = `${albumId}/${id}`;
  const srcKey = `${base}.${isVideo ? VIDEO_EXT[file.type] : "jpg"}`;
  const thumbKey = `${base}-thumb.jpg`;

  await env.BUCKET.put(srcKey, file.stream(), { httpMetadata: { contentType: file.type } });
  await env.BUCKET.put(thumbKey, thumb.stream(), { httpMetadata: { contentType: "image/jpeg" } });
  const now = Date.now();
  const args = [id, albumId, isVideo ? "video" : "photo", title, srcKey, thumbKey, file.size, now];
  try {
    // 새 사진은 항상 맨 뒤에 붙도록 순서값(sort_order)에 현재 시각을 넣습니다.
    await env.DB.prepare(
      "INSERT INTO items (id, album_id, type, title, src_key, thumb_key, size, created_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(...args, now).run();
  } catch {
    // D1 업데이트 전의 옛 구조
    await env.DB.prepare(
      "INSERT INTO items (id, album_id, type, title, src_key, thumb_key, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(...args).run();
  }

  return json({ id }, 201);
}
