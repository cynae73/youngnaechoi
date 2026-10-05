CREATE TABLE IF NOT EXISTS albums (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id         TEXT PRIMARY KEY,
  album_id   TEXT NOT NULL REFERENCES albums(id),
  type       TEXT NOT NULL CHECK (type IN ('photo', 'video')),
  title      TEXT NOT NULL DEFAULT '',
  src_key    TEXT NOT NULL,
  thumb_key  TEXT NOT NULL,
  size       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_album ON items(album_id, created_at);
