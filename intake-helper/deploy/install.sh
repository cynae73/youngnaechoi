#!/usr/bin/env bash
# 접수 도우미 서버 설치 (Linux). 같은 명령을 다시 실행하면 갱신(.env 는 그대로 유지).
#
#   sudo bash deploy/install.sh --url https://intake.example.go.kr [--port 8791]
#        [--ips 10.20.0.0/24] [--employees 100123,100456] [--user intake] [--no-service]
#
# 하는 일: Node 확인 → npm ci → .env 만들기(접속 비밀번호 자동 생성) → systemd 서비스 등록·시작 → 점검
# HTTPS 는 별도입니다: deploy/nginx.conf.example 또는 .env 의 TLS_CERT/TLS_KEY (docs/서버배포.md 참고)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
URL=""; PORT=8791; IPS=""; EMPS=""; SVC_USER="intake"; SERVICE=1; RENDER=0

while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2%/}"; shift 2;;
    --port) PORT="$2"; shift 2;;
    --ips) IPS="$2"; shift 2;;
    --employees) EMPS="$2"; shift 2;;
    --user) SVC_USER="$2"; shift 2;;
    --no-service) SERVICE=0; shift;;
    --render-unit) RENDER=1; shift;;
    -h|--help) sed -n '2,9p' "$0"; exit 0;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 2;;
  esac
done

say() { printf '\n== %s\n' "$*"; }
die() { printf '오류: %s\n' "$*" >&2; exit 1; }

NODE="$(command -v node || true)"
[ -n "$NODE" ] || die "Node.js 가 없습니다. Node 18 이상을 설치하세요 (예: https://nodejs.org)."

render_unit() {
  sed -e "s#@DIR@#$DIR#g" -e "s#@USER@#$SVC_USER#g" -e "s#@NODE@#$NODE#g" "$DIR/deploy/intake-helper.service"
}
if [ "$RENDER" = 1 ]; then render_unit; exit 0; fi

say "1/5 Node.js 확인"
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js 18 이상이 필요합니다 (현재 $("$NODE" -v))."
echo "Node.js $("$NODE" -v) ($NODE)"

say "2/5 라이브러리 설치 (npm ci)"
command -v npm >/dev/null || die "npm 이 없습니다."
( cd "$DIR" && npm ci --omit=dev --no-audit --no-fund --silent )
echo "완료"

say "3/5 설정 파일(.env)"
ENVF="$DIR/.env"
NEWPW=""
if [ -f "$ENVF" ]; then
  echo ".env 가 이미 있어 그대로 둡니다. (바꾸려면 직접 편집: $ENVF)"
else
  [ -n "$URL" ] || die "처음 설치에는 --url (사용자가 입력할 주소, 예: https://intake.example.go.kr) 이 필요합니다."
  NEWPW="$("$NODE" -e 'console.log(require("crypto").randomBytes(15).toString("base64url"))')"
  umask 077
  sed -e "s#^PORT=.*#PORT=$PORT#" \
      -e "s#^PUBLIC_URL=.*#PUBLIC_URL=$URL#" \
      -e "s#^ACCESS_PASSWORD=.*#ACCESS_PASSWORD=$NEWPW#" \
      -e "s#^ALLOWED_IPS=.*#ALLOWED_IPS=$IPS#" \
      -e "s#^ALLOWED_EMPLOYEES=.*#ALLOWED_EMPLOYEES=$EMPS#" \
      "$DIR/.env.server.example" > "$ENVF"
  chmod 600 "$ENVF"
  echo ".env 를 만들었습니다."
fi
mkdir -p "$DIR/logs"

say "4/5 서비스 등록"
if [ "$SERVICE" = 0 ]; then
  echo "--no-service: 건너뜁니다. 직접 실행: cd $DIR && node src/server.js"
elif [ ! -d /run/systemd/system ]; then
  echo "systemd 를 쓸 수 없는 환경이라 건너뜁니다. 직접 실행: cd $DIR && node src/server.js"
elif [ "$(id -u)" -ne 0 ]; then
  die "서비스 등록은 root 권한이 필요합니다: sudo bash deploy/install.sh ..."
else
  id "$SVC_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
  chown -R "$SVC_USER":"$SVC_USER" "$DIR/logs" "$ENVF"
  render_unit > /etc/systemd/system/intake-helper.service
  systemctl daemon-reload
  systemctl enable intake-helper >/dev/null 2>&1
  systemctl restart intake-helper
  sleep 2
  systemctl --no-pager --lines=0 status intake-helper | sed -n '1,3p' || true
fi

say "5/5 점검"
if [ "$SERVICE" = 1 ] && [ -d /run/systemd/system ]; then
  ( cd "$DIR" && sudo -u "$SVC_USER" "$NODE" deploy/check.js --url "http://127.0.0.1:$(grep -E '^PORT=' "$ENVF" | cut -d= -f2)" ) || echo "(점검에서 오류가 있었습니다. 위 내용을 확인하세요)"
else
  ( cd "$DIR" && "$NODE" deploy/check.js ) || echo "(점검에서 오류가 있었습니다. 위 내용을 확인하세요)"
fi

echo
echo "────────────────────────────────────────────"
echo " 설치 위치     $DIR"
[ -n "$URL" ] && echo " 접속 주소     $URL  (HTTPS 설정은 별도: docs/서버배포.md)"
if [ -n "$NEWPW" ]; then
  echo " 접속 비밀번호 $NEWPW"
  echo "               (고객지원팀에만 알려 주세요. $ENVF 의 ACCESS_PASSWORD 에도 있습니다.)"
fi
echo " 사용 안내서   <접속 주소>/guide.html  (브라우저에서 열어 A4 1장으로 인쇄)"
echo " 기록 보기     journalctl -u intake-helper  /  $DIR/logs/audit-*.log"
echo "────────────────────────────────────────────"
