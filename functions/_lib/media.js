// R2 파일 삭제 도우미. 한 번에 최대 1000개까지 지울 수 있어서 나눠서 처리합니다.
export async function deleteKeys(env, keys) {
  const list = keys.filter(Boolean);
  for (let i = 0; i < list.length; i += 500) {
    await env.BUCKET.delete(list.slice(i, i + 500));
  }
}

export const mediaUrl = key => "media/" + key.split("/").map(encodeURIComponent).join("/");
