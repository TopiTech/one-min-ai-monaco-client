# 1min.ai Monaco Client

> 🌐 [日本語](README.md) | [English](README.en.md) | [中文](README.zh.md) | [한국어](README.ko.md) | [Español](README.es.md)

> [!WARNING]
> **이 애플리케이션은 로컬 환경(localhost/127.0.0.1)에서의 개인 개발 및 단일 사용자 이용을 전제로 설계되었습니다.**
> `/api/fs/*` (파일 시스템 작업) 및 에이전트 명령 실행 기능에는 멀티 사용자를 위한 역할 기반 접근 제어(RBAC), 상세 감사 로그, 샌드박스 실행과 같은 엔터프라이즈급 보호机制가 포함되어 있지 않습니다. **공개 인터넷 서버나 공유 개발/스테이징 환경에 절대 배포하지 마세요.**
>
> **【중요】AI 에이전트 OS 명령 실행 보안 경고**
>
> - 에이전트 기능으로 OS 명령 실행(`ENABLE_COMMAND_EXECUTION=true`)을 활성화하면, AI가 악성 패키지 설치/실행 등 임의의 코드를 실행할 위험이 있습니다.
> - 기본적으로 **`AGENT_AUTO_APPROVE=false`**로 실행하고, 실행 전에 반드시 사람이 명령의 안전성을 확인하세요. `AGENT_AUTO_APPROVE=true`로 설정하는 경우, 완전히 격리된 샌드박스나 Docker 컨테이너 환경에서 사용하세요.

Monaco Editor + 커스텀 UI + 1min.ai API로 구성된 브라우저 기반 AI 클라이언트 MVP입니다.
Express 서버를 BFF로 사용하여 1min.ai API 키를 프론트엔드에 노출하지 않는 구성입니다.

## 주요 기능

- 채팅
- 모델 피커 카테고리 분류 (플래그십, 추론, 고속/경량)
- 대화 생성 / `conversationId`로 대화 재개
- Web Search 토글을 통한 채팅 확장
- 이미지 생성
- 이미지 텍스트 에디터
- Asset API를 통한 이미지 업로드
- Monaco Editor 통합
- 코드 설명 / 생성 / 리팩터링 지원
- 인라인 채팅 (적용/discard 미리보기 포함)
- 고급 AI 코딩 에이전트 (상세 사고 과정 표시, 승인 흐름)
- 프로젝트 파일 탐색 및 저장
- API 키를 프론트엔드에 노출하지 않는 서버 릴레이 구성
- 강력한 파일 경로 보안 가드 (`fs-guard`)

## 필요 환경

- Node.js 18+
- 1min.ai API Key
- Monaco Editor / marked / DOMPurify는 `npm start` 시 `node_modules`에서 `public/`으로 자동 복사되므로, `npm install` 후 인터넷 연결이 필요 없습니다 (Google Fonts 로딩 제외)

## 빠른 시작

```bash
cp .env.example .env
# .env의 ONE_MIN_AI_API_KEY를 편집하세요
npm install
npm start
```

또는 개발용 워치 모드:

```bash
npm run dev
```

시작 후 다음을 엽니다:

```text
http://localhost:3000
```

## 환경 변수

| 변수                       | 필수   | 기본값             | 설명                                                                   |
| -------------------------- | ------ | ------------------ | ---------------------------------------------------------------------- |
| `ONE_MIN_AI_API_KEY`       | 예     | 없음               | 1min.ai API 키. `.env`에만 저장하세요.                                 |
| `PORT`                     | 아니오 | `3000`             | 로컬 Express 서버 대기 포트.                                           |
| `NODE_ENV`                 | 아니오 | `development`      | `production`으로 설정하면 스택 트레이스를 숨기고 보안 Cookie를 활성화. |
| `MAX_FILE_SIZE`            | 아니오 | `26214400`         | 에셋 업로드 크기 제한 (바이트, 기본 25MB).                             |
| `DEFAULT_CHAT_MODEL`       | 아니오 | `gpt-4o-mini`      | 채팅 및 코드 생성의 기본 모델.                                         |
| `DEFAULT_CODE_MODEL`       | 아니오 | `qwen3-coder-plus` | 코드 생성의 기본 모델.                                                 |
| `DEFAULT_IMAGE_MODEL`      | 아니오 | `gpt-image-2`      | 이미지 생성의 기본 모델.                                               |
| `ENABLE_COMMAND_EXECUTION` | 아니오 | `false`            | 에이전트 명령 실행 활성화.                                             |
| `AGENT_AUTO_APPROVE`       | 아니오 | `false`            | 승인 없이 실행 허용. 기본적으로 false 유지.                            |
| `AGENT_MAX_LOOPS`          | 아니오 | `20`               | 에이전트 최대 루프 반복 횟수 (1-100).                                  |
| `LOG_LEVEL`                | 아니오 | `info`             | 로그 레벨 (`error`, `warn`, `info`, `debug`).                          |

## 사용법

### 채팅

1. 왼쪽 메뉴에서 「일반 채팅」을 엽니다.
2. 모델을 선택합니다.
3. 메시지를 입력하고 전송합니다.
4. 대화 기록을 사용하려면 「대화 새로 만들기」를 실행하고, 반환된 ID를 `conversationId`에 입력합니다.

### 이미지 생성 / 텍스트 편집

1. 왼쪽 메뉴에서 「이미지 생성/텍스트 편집」을 엽니다.
2. 이미지 생성: 프롬프트, 모델, 가로세로 비율, 수량을 입력합니다.
3. 이미지 텍스트 에디터: 원본 이미지를 업로드하고 반환된 asset key 또는 기존 이미지 URL을 입력합니다.
4. 편집 프롬프트, 모델, 출력 크기, 품질, 수량 등을 지정하고 「이미지 편집」을 실행합니다.

### 코딩 지원

1. 왼쪽 메뉴에서 「코딩」을 엽니다.
2. 파일 트리에서 파일을 엽니다.
3. 오른쪽 AI 코딩 패널에 지시를 입력하고 「실행」을 누릅니다.
4. 「첫 번째 코드 블록을 에디터에 적용」으로 결과를 에디터에 반영합니다.
5. `Ctrl+S`로 저장, `Ctrl+I`로 인라인 채팅을 엽니다.

## 주의사항

- `.env`를 Git에 커밋하지 마세요. 실수로 커밋한 경우 반드시 1min.ai에서 API 키를 재생성하세요.
- `/api/fs/*`는 로컬 개발용입니다. 공개 환경에서는 인증, CSRF 방지, 감사 로그, 실행 샌드박스, 보호 경로 정책을 강화하세요.
- 이것은 MVP 버전입니다. 운영 환경에서는 인증, 속도 제한, 감사 로그, 샌드박스 실행, CSRF 방지 등을 추가하세요.

## 라이선스

MIT License
