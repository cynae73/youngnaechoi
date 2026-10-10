# 접수 도우미 (민원접수 자동화)

시험검사의뢰서(사진·PDF·엑셀) → KAFRI 민원접수 등록 값으로 변환·검증 → 사람이 확인 후 접수하는 로컬 웹 프로그램.
전체 배경·결정 사항·남은 일은 **`민원접수_자동화_정리.md`** 를 먼저 읽을 것.

## 실행
- `npm ci` (의존성: `exceljs`(엑셀), `jszip`(docx·hwpx), `pdfjs-dist`(PDF 글자). Node 18+ 필요)
- 데모(KAFRI 접속 없음): `KAFRI_DEMO=1 node src/server.js` → http://127.0.0.1:8791
- 실제 연결: `node src/server.js` (사내망에서만 KAFRI 접속 가능. 이 클라우드 환경에서는 불가)
- AI 추출: `.env.example` 을 `.env` 로 복사 후 `ANTHROPIC_API_KEY` 입력 (`.env` 는 커밋 금지)
- Windows 사용자용 `시작.bat` / `시작_데모.bat` 은 그대로 유지

## 읽기 방식 (API 키 없이 쓰는 A+B 혼합)
- **B. 고정 양식 규칙 변환** `src/fixed.js` + `rules/*.json`: docx·hwpx·글자 있는 PDF를 표/글자 위치로 펴서 "라벨 → 옆 칸 값"으로 읽는다. 양식이 다르면 `rules/` 에 JSON만 추가·수정(코드 수정 불필요). 규칙에 안 맞으면 NO_MATCH, 스캔 PDF는 NO_TEXT 로 거절하고 Claude 앱 안내로 넘긴다.
  - 규칙 튜닝: `node src/fixed.js dump <파일>` 로 펼친 행을 보고, `node src/fixed.js run <파일>` 로 결과 확인.
- **A. Claude 앱 변환** (사진·스캔·손글씨·제각각 양식): 화면의 "변환 방법 보기" → 빈 양식 `GET /api/template`(`excel.js exportTemplate`) + 요청문 `src/prompts/claude-app.md`(`GET /api/claude-prompt`) → Claude 앱이 채운 엑셀을 "엑셀 선택"으로 불러온다. 앱이 아닌 도구가 저장한 엑셀은 노란 칸이 빠져도 "확인필요 항목"에 적힌 사유를 버리지 않는다.
- API 키가 있으면 사진·PDF는 기존 AI 읽기(`extract.js`)도 쓸 수 있다. 우선순위: docx·hwpx → 규칙 / PDF → 규칙, 안 되면 AI / 사진 → AI(키 없으면 A 안내).
- 테스트: `npm test` (`test/run.js`, `test/fixtures/` 는 합성 의뢰서)

## 구조
`src/server.js` 로컬 서버·보안검사 / `kafri-core.js` 연구관리시스템 접속(기존 코드) / `extract.js` Claude API 추출 /
`excel.js` 3시트 입출력 / `model.js` 데이터 구조·검증(서버·화면 공용) / `company.js` 업체·중복 조회(읽기 전용) /
`fixed.js` 고정 양식 규칙 변환(B) / `rules/` 양식 규칙 / `prompts/claude-app.md` Claude 앱 요청문(A) /
`codes.js` 기초코드 매칭 / `register.js` 드라이런, **`execute()` 미구현** / `demo.js` 데모 데이터 / `public/` 화면

## 작업 규칙
- 서버 저장은 아직 없음. 저장 요청 규격(캡처)이 확보되기 전까지 드라이런만 유지하고 `register.js` 의 `execute()` 만 채운다.
- 안전장치(드라이런 표시, 확정 전 등록 금지, 중복·계산서 사업자번호 확인, 파일 삭제 금지)를 약화시키지 말 것.
- 판독이 불확실한 값은 추측해 채우지 말고 노란 칸(확인 필요)으로 표시한다.
- 외부 라이브러리 추가는 최소화(서버는 순수 Node.js). 화면·메시지는 한국어.
- API 키·사번·개인정보(업체 연락처, 사업자번호)를 로그, 엑셀, 커밋에 남기지 말 것. 서버는 127.0.0.1 에서만 연다.
- `rules/기본양식.json` 은 알려진 양식 구성(의뢰인·계산서·성적서·시료표)을 바탕으로 한 **추정 규칙**이다. 실제 의뢰서 docx/hwpx/PDF 로 `dump`·`run` 해서 라벨을 맞춘 뒤 결과를 문서에 반영한다. 테스트 픽스처는 합성 문서라 실제 양식 검증이 아니다.
- 실제 KAFRI 응답 컬럼명, 기초코드 그룹명, Claude 판독 정확도는 아직 미검증. 확인되면 정리 문서에 반영한다.
