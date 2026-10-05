// R2에 저장된 사진·영상을 내려줍니다. 영상 재생을 위해 Range 요청을 지원합니다.
export async function onRequestGet({ request, env, params }) {
  const key = (Array.isArray(params.path) ? params.path : [params.path]).join("/");
  if (!key) return new Response("Not found", { status: 404 });

  const range = request.headers.get("Range");
  const obj = await env.BUCKET.get(key, range ? { range: request.headers } : undefined);
  if (!obj) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("ETag", obj.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "public, max-age=31536000, immutable"); // 파일 이름이 바뀌지 않으므로 오래 캐시
  if (obj.range) {
    const { offset = 0, length = obj.size - offset } = obj.range;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set("Content-Length", String(length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(obj.size));
  return new Response(obj.body, { headers });
}
