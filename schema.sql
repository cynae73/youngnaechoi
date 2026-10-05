-- 새로 만드는 데이터베이스용 전체 구조입니다.
-- 이미 만들어 둔 데이터베이스는 migrations/001_order_and_music.sql 만 실행하면 됩니다.
CREATE TABLE IF NOT EXISTS albums (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  music_key   TEXT,
  music_title TEXT
);

CREATE TABLE IF NOT EXISTS items (
  id         TEXT PRIMARY KEY,
  album_id   TEXT NOT NULL REFERENCES albums(id),
  type       TEXT NOT NULL CHECK (type IN ('photo', 'video')),
  title      TEXT NOT NULL DEFAULT '',
  src_key    TEXT NOT NULL,
  thumb_key  TEXT NOT NULL,
  size       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_items_album ON items(album_id, sort_order, created_at);
