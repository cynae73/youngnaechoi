# Cloudflare 연결 방법 (한 번만 하면 됩니다)

화면 이름은 Cloudflare 개편으로 조금 다를 수 있어요. 막히면 화면을 알려주세요.

## 1. 계정과 저장소 만들기
1. https://dash.cloudflare.com/sign-up 에서 계정을 만들고 이메일을 인증합니다.
2. 왼쪽 메뉴 **R2 Object Storage** → 카드 등록 → **Create bucket** → 이름 `family-album`
   (무료 10GB 안에서는 0원입니다.)
3. 왼쪽 메뉴 **Storage & Databases → D1 SQL Database** → **Create** → 이름 `family-album`
4. 만든 D1을 열고 **Console** 탭에 `schema.sql` 파일의 내용을 전부 붙여넣어 실행합니다.
5. D1 화면에 보이는 **Database ID**(긴 문자열)를 복사해서 알려주세요.
   (`wrangler.toml`의 `database_id` 자리에 제가 넣겠습니다.)

## 2. 사이트 연결 (Pages)
1. **Workers & Pages → Create → Pages → Connect to Git** → GitHub의 `youngnaechoi` 저장소 선택
2. 브랜치: `main`(PR을 합친 뒤) / Build command: 비워둠 / Build output directory: `public`
3. 배포가 끝나면 `https://…pages.dev` 주소가 생깁니다.

## 3. 비밀번호 설정
Pages 프로젝트 **Settings → Variables and Secrets** 에서 **Secret** 으로 두 개를 추가합니다.
- `UPLOAD_PASSWORD` : 가족이 올릴 때 쓸 비밀번호 (예: 외우기 쉬운 8자 이상)
- `SESSION_SECRET` : 아무 긴 무작위 문자열 (30자 이상, 아무도 몰라도 됩니다)

추가한 뒤 **Deployments → Retry deployment** 로 다시 배포합니다.

## 4. 확인
`https://…pages.dev/upload.html` 에 들어가 비밀번호를 입력하고 사진 한 장을 올려 보세요.

## 순서 변경과 앨범 음악을 쓰려면 (D1 업데이트, 한 번만)
삭제 기능은 바로 쓸 수 있지만, **순서 변경과 앨범 음악**은 데이터베이스에 칸을 두 개 더 만들어야 합니다.
1. Cloudflare 대시보드에서 D1 `family-album`을 열고 **Console** 탭으로 갑니다.
2. 아래 내용을 전부 붙여넣고 **Execute**를 누릅니다. (`migrations/001_order_and_music.sql` 파일과 같은 내용입니다.)
3. 성공하면 끝입니다. **한 번만** 실행하세요. 두 번 실행하면 "duplicate column" 오류가 나지만 데이터는 그대로입니다.

```sql
ALTER TABLE items ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
UPDATE items SET sort_order = created_at;
ALTER TABLE albums ADD COLUMN music_key TEXT;
ALTER TABLE albums ADD COLUMN music_title TEXT;
```

업데이트를 하기 전에도 사이트는 정상으로 보이고 올리기·삭제도 됩니다. 순서 변경과 음악만 "D1 업데이트가 필요해요"라고 안내됩니다.

## 사용 방법
- **삭제·순서 변경:** 로그인(올리기 화면에서 비밀번호 입력)한 뒤 앨범을 열면 **편집** 버튼이 보입니다. 사진을 눌러 고르고 **선택 삭제**, 순서는 ◀ ▶ 버튼(휴대폰·컴퓨터)이나 끌어서 놓기(컴퓨터)로 바꿉니다. **앨범 삭제**로 앨범 전체를 지울 수 있습니다. 삭제는 되돌릴 수 없어요.
- **슬라이드쇼:** 첫 화면에서 앨범을 누르면 그 앨범의 첫 사진부터 한 장씩 자동으로 넘어갑니다(앨범 음악도 함께). 아래쪽 **❚❚ 멈춤**과 **초 버튼**으로 멈추거나 간격(3·4·6·8초)을 바꾸고, 스페이스바로도 멈출 수 있어요. 영상은 끝까지 재생된 뒤 넘어가고, 마지막 사진에서 멈춥니다. 앨범 화면의 **▶ 슬라이드쇼** 버튼으로 다시 시작할 수 있어요.
- **사진 설명:** 편집 모드에서 사진 아래쪽 가운데 **✎** 버튼을 누르면 설명(100자까지)을 쓰거나 고치거나 지울 수 있어요. 설명은 사진 목록 아래쪽과 크게 볼 때 나옵니다.
- **다른 앨범으로 이동:** 편집 모드에서 사진을 고르고 **다른 앨범으로 이동**을 누른 뒤 앨범을 고르면, 선택한 순서 그대로 그 앨범의 맨 뒤로 옮겨집니다. 설명은 그대로 따라갑니다.
- **앨범 음악:** 올리기 화면의 "3. 앨범 음악"에서 앨범을 고르고 mp3 등을 등록합니다. 앨범마다 다른 곡을 쓸 수 있고, 사진을 크게 볼 때 흘러나옵니다. 저작권이 있는 곡은 올리지 마세요.
- 처음 만든 샘플 앨범(솔비치)은 저장소 파일이라 편집할 수 없습니다. 편집하려면 사진을 올리기 화면에서 새로 올려 주세요.

## 내 컴퓨터에서 시험해 보기 (선택)
```
npm install
echo "UPLOAD_PASSWORD=test1234" > .dev.vars
echo "SESSION_SECRET=local-secret-local-secret-1234" >> .dev.vars
npm run db:local
npm run dev        # http://localhost:8788
```
