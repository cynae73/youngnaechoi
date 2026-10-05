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

## 내 컴퓨터에서 시험해 보기 (선택)
```
npm install
echo "UPLOAD_PASSWORD=test1234" > .dev.vars
echo "SESSION_SECRET=local-secret-local-secret-1234" >> .dev.vars
npm run db:local
npm run dev        # http://localhost:8788
```
