-- 순서 변경과 앨범 음악을 쓰기 위한 D1 업데이트. 한 번만 실행하세요.
ALTER TABLE items ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
UPDATE items SET sort_order = created_at;
ALTER TABLE albums ADD COLUMN music_key TEXT;
ALTER TABLE albums ADD COLUMN music_title TEXT;
