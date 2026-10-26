# 보안 검토

Research Radar가 받는 외부 입력과 지키는 자산을 정리하고, 찾은 문제마다 공격을 재현한 뒤 고친 기록입니다.
각 공격은 테스트로 남겨 두어 다시 열리면 CI가 실패합니다.

## 무엇을 지키나

- **OpenAlex API 키**: PC는 데이터 폴더의 `settings.json`(사용자만 읽기 가능), Android는 앱의 localStorage에 있습니다.
- **북마크·메모·검색 기록·정렬 평가**: 개인 연구 기록입니다.
- **사용자 컴퓨터**: PC 앱은 파일 저장 기능(`window.pywebview.api.save_file`)을 화면에 열어 줍니다.

## 신뢰하지 않는 입력

| 입력 | 들어오는 곳 |
|---|---|
| 논문 메타데이터(제목, 저자, 링크, 키워드) | OpenAlex. 출판사·저장소가 올린 값이라 누구나 내용을 정할 수 있습니다. |
| 같은 컴퓨터의 다른 웹사이트 | PC 앱의 로컬 API(`127.0.0.1:<포트>`)는 브라우저의 어느 페이지에서나 요청할 수 있습니다. |
| GitHub 릴리스 정보 | 새 버전 확인(`/version`). |
| CI의 외부 GitHub Actions | 릴리스 빌드와 서명 키를 다루는 워크플로가 실행합니다. |

## 찾은 문제와 조치

| # | 문제 | 위험도 | 상태 |
|---|---|---|---|
| 1 | 논문 링크의 `javascript:` URL이 앱 안에서 실행됨 | 높음 | 해결 |
| 2 | 연구 흐름 지도(iframe)가 앱과 같은 권한으로 실행됨 | 높음 | 해결 |
| 3 | DNS 리바인딩으로 다른 사이트가 PC 로컬 API를 읽고 씀 | 중간 | 해결 |
| 4 | 다른 출처에서 상태를 바꾸는 요청을 서버가 받아 줌 | 중간 | 해결 |
| 5 | 지도 툴팁 일부 값이 이스케이프 없이 HTML에 들어감 | 낮음 | 해결 |
| 6 | 새 버전 링크를 검증 없이 따라감 | 낮음 | 해결 |
| 7 | CI의 외부 Action이 태그로만 지정되고 토큰 권한이 넓음 | 중간 | 해결 |
| 8 | Android 백업에 API 키와 북마크가 포함됨 | 낮음 | 결정 필요 |
| 9 | Android 앱은 OpenAlex 키를 URL 쿼리로 보냄 | 낮음 | 유지 (설명) |
| 10 | PC 창이 외부 사이트로 이동하면 파일 저장 기능이 노출됨 | 낮음 | 유지 (설명) |
| 11 | PDF 리더의 `/pdf?url=` 프록시로 내부망 주소를 읽음(SSRF) | 중간 | 해결 |
| 12 | 필기 문서 id로 데이터 폴더 밖의 파일에 접근 | 중간 | 해결 |
| 13 | 학교 도서관 로그인 쿠키가 다른 사이트로 새어 나감 | 중간 | 해결 |

### 1. 논문 링크의 `javascript:` URL

**공격.** OpenAlex의 `landing_page_url`이나 `doi`에 `javascript:...`가 들어 있으면, 검색 결과 제목이나 지도의 "논문 열기"를 누를 때 앱 안에서 코드가 실행됩니다. Android에서는 저장된 API 키와 북마크를 읽을 수 있고, PC에서는 파일 저장 기능도 부를 수 있습니다.

**재현.** `tests/e2e/security.spec.mjs`가 OpenAlex 응답의 논문 한 편에 `javascript:` 링크와 `<img onerror>` 제목, `<script>` 저자명을 심습니다. 고치기 전 코드에서는 결과 제목에 `href="javascript:window.top.__pwned = 1"`이 그대로 붙었습니다.

**조치.**
- 두 백엔드가 OpenAlex 응답을 정리할 때 `http(s)` 링크만 남깁니다(`backend/services/openalex.py`의 `web_url`, `frontend/web/core/openalex.js`의 `webUrl`).
- 화면과 지도도 링크를 걸기 직전에 한 번 더 확인합니다. 예전에 저장된 북마크에 남은 링크도 막기 위해서입니다.
- 테스트: `tests/test_security.py::test_only_web_links_survive_from_openalex`, Node 테스트, 브라우저 테스트.

### 2. 연구 흐름 지도의 권한

**공격.** 지도는 `srcdoc` iframe으로 그려지고, 제목·저자·주제명처럼 외부 데이터를 가장 많이 다룹니다. 이 iframe이 앱과 같은 출처였기 때문에, 지도에서 단 하나라도 이스케이프가 빠지면 `parent`를 통해 앱 전체(키, 북마크, 파일 저장)에 닿을 수 있었습니다.

**재현.** 브라우저 테스트 "the map cannot reach into the app"이 지도 안에서 `parent.document`와 `localStorage`를 읽어 봅니다. 고치기 전에는 읽혔습니다.

**조치.**
- iframe에 `sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"`를 붙였습니다. 지도는 스크립트를 실행할 수 있지만, 출처가 분리되어 앱의 화면과 저장소에 접근할 수 없습니다.
- 샌드박스 안에서는 앱의 글꼴 파일을 불러올 수 없으므로, 지도에 쓰는 글꼴 세 가지를 data URL로 넣습니다.
- 그래서 저장한 포스터도 인터넷 없이 같은 글꼴로 보입니다. 대신 파일이 약 0.9MB 커집니다.

### 3·4. PC 로컬 API

**공격.**
- PC 앱의 API는 `127.0.0.1`의 임의 포트에서 열립니다. 공격 사이트가 자기 도메인을 `127.0.0.1`로 다시 연결하면(DNS 리바인딩), 브라우저는 같은 출처로 보고 응답을 읽게 해 줍니다.
- 그러면 북마크와 설정을 읽고, 설정을 바꾸고, 사용자의 키로 검색해 한도를 쓸 수 있습니다.
- 다른 출처에서 보낸 쓰기 요청도 서버가 그대로 처리했습니다. 브라우저의 CORS 사전 요청이 막아 주긴 하지만 그것에만 기대고 있었습니다.

**재현.** `Host: attacker.example`로 `GET /settings`를 보내면 200이 돌아왔고, `Origin: https://evil.example`로 보낸 `DELETE /history`도 처리됐습니다.

**조치(`backend/security.py`).**
- `Host`가 `127.0.0.1`, `localhost`, `::1`이 아니면 400으로 거부합니다.
- 상태를 바꾸는 요청(GET·HEAD·OPTIONS 외)은 `Origin`이 요청을 받은 주소와 같을 때만 처리합니다. `null` 출처(샌드박스 iframe, 로컬 파일)는 거부합니다.
- 다른 사이트의 일반 form 전송은 원래부터 막혀 있었습니다. 요청 본문이 JSON이어야 하기 때문입니다(422).
- 테스트: `tests/test_security.py`. 실제 서버에 대고 `curl`로 확인한 결과 리바인딩은 400, 외부 출처 쓰기는 403, 앱 화면에서 보낸 요청은 정상 처리되었습니다.

### 5. 지도 툴팁의 이스케이프

연도·인용 수·색처럼 숫자나 서버가 정한 값으로 보고 이스케이프 없이 HTML에 넣던 곳이 있었습니다. 지도 데이터는 `/poster` 요청으로 받은 값이라 모두 이스케이프하도록 바꿨습니다. 색은 `#rrggbb` 형식일 때만 씁니다. 2번의 샌드박스와 함께 이중으로 막습니다.

### 6. 새 버전 링크

`/version`이 알려 주는 릴리스 페이지 주소를 그대로 링크로 걸고 있었습니다. 이제 `https://github.com/`으로 시작할 때만 알림과 링크를 보여 줍니다.

### 7. CI 공급망

**문제.**
- 릴리스 작업은 쓰기 권한 토큰으로 외부 Action(`softprops/action-gh-release`)을 실행합니다.
- 모든 Action이 `@v4` 같은 태그로 지정되어 있어, 태그가 다른 코드로 옮겨지면 그 코드가 그대로 실행됩니다.

**조치.**
- 모든 Action을 커밋 SHA로 고정하고, 버전 태그는 주석으로 남겼습니다. Dependabot이 SHA를 갱신합니다.
- 워크플로 기본 토큰 권한을 `contents: read`로 줄였습니다. 쓰기 권한은 릴리스 작업만 받습니다.
- 서명 키(secrets)는 원래대로 Android 빌드 단계에서만 쓰입니다. 포크에서 온 PR에는 GitHub가 secrets를 주지 않습니다.

### 8. Android 백업 — 결정 필요

`AndroidManifest.xml`이 `android:allowBackup="true"`라서 Google 백업과 기기 이전에 API 키와 북마크가 함께 들어갑니다.

- **끄면:** 키가 백업에 남지 않습니다. 대신 휴대폰을 바꾸면 북마크도 사라집니다.
- **유지하면:** 키는 무료 OpenAlex 키라 새어 나가도 한도만 쓰이는 정도입니다. 백업도 Google 계정으로 보호됩니다.

이 차이 때문에 바꾸지 않았습니다. 끄려면 `allowBackup="false"`로 바꾸고, Android 12 이상용 `dataExtractionRules`를 추가하면 됩니다.

### 9. OpenAlex 키를 URL 쿼리로 보냄 — 유지

Android의 JavaScript 백엔드는 OpenAlex 안내대로 키를 `api_key` 쿼리로 보냅니다. HTTPS라 전송 중에는 보호되고, 앱 화면이나 로그에는 남지 않습니다. PC 백엔드는 `Authorization` 헤더를 씁니다.

### 10. PC 창의 외부 이동 — 유지

PC 창(pywebview)이 외부 사이트로 이동하면, 그 페이지도 `window.pywebview.api.save_file`을 부를 수 있습니다. 그래도 실제 저장은 사용자가 저장 창에서 위치를 골라야만 일어납니다.

지금은 앱의 외부 링크가 모두 `target="_blank"`라서 기본 브라우저로 열리고, 앱 창은 이동하지 않습니다. 새 외부 링크를 추가할 때도 이 규칙을 지켜야 합니다.

### 11. PDF 프록시의 SSRF

PC 앱은 출판사 PDF를 브라우저의 CORS 제한 없이 받으려고 `GET /pdf?url=`로 대신 받아 옵니다. 이 주소는 OpenAlex(누구나 정할 수 있는 값)에서 오므로, 그대로 따라가면 공유기 관리 페이지 같은 내부망을 읽을 수 있습니다.

`backend/pdf_proxy.py`는 http(s)만 받고, 주소를 직접 풀어(`getaddrinfo`) 공인 IP일 때만 연결합니다. 리다이렉트는 자동으로 따르지 않고 한 번씩(최대 5번) 같은 검사를 다시 합니다. 크기는 80MB까지, 내용이 `%PDF`로 시작해야만 돌려줍니다. Android는 각 기기에서 직접 받으므로 프록시가 없습니다. 테스트: `tests/test_reader_backend.py`.

### 12. 필기 문서 id

필기는 `annotations/<id>.json`에 저장합니다. id는 `[A-Za-z0-9_.-]`만, 80자까지, `.`으로 시작할 수 없어 데이터 폴더 밖이나 숨은 파일을 가리킬 수 없습니다. 문서 하나는 8MB까지입니다(413). 두 백엔드가 같은 규칙을 씁니다.

PDF 본문은 pdf.js가 `isEvalSupported: false`로 그리고, 필기는 SVG의 속성 값(경로, 색은 `#rgb`·`#rrggbb`만)으로만 화면에 들어가며 텍스트 상자는 `textContent`로 넣습니다.

### 13. 학교 도서관 로그인 쿠키

PC 앱은 학교 도서관 프록시(EZproxy 등)에 로그인한 세션 쿠키를 `library-session.json`에 사용자만 읽을 수 있게 저장합니다(`backend/library.py`). 로그인 창(`desktop/main.py`)에서 받은 쿠키 가운데 프록시 호스트와 그 하위 도메인의 것만 남기고(`ezproxy.school.edu.attacker.example` 같은 이름은 버림), 요청에도 그 도메인 쿠키로만 붙입니다. 받아 오는 동안 프록시 밖으로 리다이렉트되면 쿠키를 보내기 전에 멈추고 다시 로그인하라고 알립니다. 주소마다 공인 IP 검사(11번)도 그대로 합니다. 프록시 주소를 바꾸면 이전 세션은 쓰지 않고, 설정 › 도서관에서 지울 수 있습니다. 사람이 연 논문 한 편씩만 받습니다. 테스트: `tests/test_library.py`.

Android 앱은 로그인을 앱 안의 로그인 화면(`LibraryWebActivity`, 평범한 WebView)에서 받습니다. 앱과 같은 쿠키 저장소를 쓰고, 앱과 이어지는 기능(JavaScript 브리지)은 없으며, 로그인하는 동안에는 앱이 도서관에 요청하지 않습니다. 그 안의 페이지는 다른 출처라 앱의 데이터(localStorage의 키·북마크)를 읽지 못합니다. PDF는 먼저 CapacitorHttp가 받으며 쿠키는 브라우저처럼 그 도메인에만 붙습니다(`core/library.js`). 출판사가 앱의 요청을 막으면(봇 검사) 로그인 화면에서 논문 페이지를 열고, 앱이 그 페이지의 PDF 링크를 읽어(`evaluateJavascript`, 앱 쪽에서만 부르는 것이라 페이지가 앱을 부를 수는 없음) 따라갑니다. 화면이 받은 PDF는 화면과 같은 쿠키·브라우저 이름으로 앱 캐시에 내려받고, `%PDF`로 시작할 때만 리더에 넘깁니다(100MB까지). 로그인 정보 지우기는 웹 뷰 쿠키를 모두 지웁니다. 다른 앱에서 "Research Radar로 열기"로 넘긴 PDF(`content://` PDF만 받는 인텐트 필터)는 PDF로만 다룹니다.

서버가 인증서 사슬의 중간 인증서를 빠뜨리면(연세대 도서관) Android의 WebView와 HTTP는 접속하지 못하지만 Chrome은 인증서에 적힌 주소(AIA)에서 받아 와 접속합니다. 앱도 같은 일을 합니다(`AiaTrust.java`). 빠진 인증서를 받아 붙인 뒤, 같은 호스트 이름으로 휴대폰이 믿는 루트 인증서까지 시스템 검사를 다시 하고 통과할 때만 엽니다. 받은 인증서는 믿을 근거가 아니라 사슬을 잇는 재료일 뿐이라, 인증 기관 호스트에서 http로 받아도 됩니다(`network_security_config.xml`). 기간 만료·이름 불일치 같은 다른 인증서 문제는 그대로 막습니다.

### 14. 직접 고른 PDF 보관

사람이 고른 PDF(“PDF 파일 고르기”, “Research Radar로 열기”)는 다음에 고르지 않고 열리도록 그 문서의 필기 옆에 둡니다. PC는 데이터 폴더의 `annotations/<id>.pdf`, Android는 앱 저장소의 `pdfs/<id>.pdf`입니다(`backend/annotations.py`, `mobile.js`). id는 필기와 같은 규칙(영문·숫자·`_.-`, 80자, `.`로 시작 못 함)이라 폴더 밖으로 나가지 못하고, `%PDF`로 시작하는 100MB 이하 파일만 받습니다. 읽기 목록에서 문서를 지우면 PDF도 지워집니다. 테스트: `tests/test_reader_backend.py`, `tests/js/api.test.mjs`.

## 그대로 안전한 부분

- 화면의 논문 정보는 모두 `textContent`로 넣습니다(`app.js`의 `el()`). 포스터 SVG의 텍스트는 두 백엔드가 이스케이프하고, 스크립트 안의 JSON은 `</`를 끊어 둡니다.
- 설정 API는 키 전체를 돌려주지 않습니다(끝 네 자리만). `settings.json`은 원자적으로, 사용자만 읽을 수 있게 저장합니다.
- 서버는 `127.0.0.1`에만 열리고, 검색 결과 수(최대 100)와 지도 논문 수(최대 300)에 상한이 있습니다.
