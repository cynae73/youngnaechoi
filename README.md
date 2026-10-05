# 윤서네 가족앨범

가족이 사진과 쇼츠 영상을 올리고 함께 보는 온라인 앨범 사이트.

## 구성 (Cloudflare 무료 범위)
- `public/` : 사이트 화면 (Cloudflare Pages로 배포)
  - `index.html` : 앨범 목록 / 앨범 보기 / 확대 보기 (사진·영상)
  - `upload.html` : 비밀번호 로그인 + 사진·영상 올리기
  - `data/albums.json`, `albums/` : 샘플 앨범(솔비치). 서버 앨범 뒤에 같이 표시
- `functions/` : 서버 코드 (Pages Functions)
  - `api/login.js` 로그인 / `api/albums.js` 앨범 목록·만들기 / `api/upload.js` 업로드 / `api/items/delete.js` 선택 삭제 / `api/albums/[id].js` 앨범 삭제 / `api/albums/[id]/order.js` 순서 저장 / `api/albums/[id]/music.js` 앨범 음악 / `media/` 사진·영상·음악 전달
- `schema.sql` : D1 테이블 / `migrations/` : 이미 만든 D1 업데이트용 / `wrangler.toml` : 연결 설정 / `docs/SETUP.md` : Cloudflare 연결 방법
- 저장소: Cloudflare R2 (10GB 무료) / 목록 DB: D1 / 업로드 처리: Pages Functions

## 진행 단계
1. [x] 앨범 구조와 화면 (사진·영상 지원)
2. [x] 업로드 (휴대폰·PC, 사진 자동 축소, 영상 50MB·1분 제한)
3. [x] 접근 관리 (보기는 링크만, 올리기는 가족 비밀번호)
4. [ ] 정리 기능 (설명, 삭제, 앨범 이동)

## 로컬에서 시험하기
`docs/SETUP.md` 맨 아래 "내 컴퓨터에서 시험해 보기" 참고.
