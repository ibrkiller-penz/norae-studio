# 노래공방 (Norae Studio)

내 컴퓨터의 그래픽카드로 노래를 만드는 Electron 프로그램. 사용자는 비개발자이고 한국어로
대화한다. 답변도 한국어로. 작곡은 오픈소스 모델 **YuE2** 가 하고, 이 앱은 그걸 8GB
그래픽카드에서 돌아가게 감싼 껍데기다.

- 배포: https://norae-studio.web.app (비밀번호 `1004`)
- GitHub: `ibrkiller-penz/norae-studio` (공개, 브랜치 `main`)
- Firebase: 프로젝트 `happymp3`, 호스팅 사이트 `norae-studio`
  (같은 프로젝트의 `happymp3` 사이트는 **다른 앱이다. 건드리지 않는다.**)

## 명령

```
npm install
npm start                        # 개발 실행
npm test                         # speed / models / lyrics 테스트
npm run dist                     # dist/NoraeStudio-Setup-<버전>.exe

node scripts/preview.mjs score   # 화면 배치를 브라우저에서 재보기
node site/build.mjs <릴리스주소> <버전> <바이트수>   # 다운로드 페이지 생성
firebase deploy --only hosting --project happymp3
```

윈도우 + Git Bash. 서버를 띄웠으면 끝나고 반드시 종료한다.

## 구조

```
electron/main.js       설치·워커·대기열·파일·업데이트 (가장 크다)
electron/preload.js    화면에 열어주는 함수 목록. 여기 없으면 화면에서 못 쓴다
electron/speed.js      생성 속도 학습 (순수 모듈, 테스트 있음)
electron/models.js     YuE2 모델 갱신 확인 (순수 모듈, 테스트 있음)
electron/updater.js    본인 GitHub 릴리스에서 새 버전 확인
renderer/app.js        화면 동작 (가장 크다)
renderer/lyrics.js     가사 구간 자동 태그 (순수 모듈, 테스트 있음)
python/worker.py       YuE2 실행 + 저VRAM 패치
python/transcribe.py   채보 — 음원에서 ABC 악보
python/analyze.py      참고곡 분석 — 템포·조성·코드
python/ytdl.py         유튜브 → MP3
python/score_compare.py 채보 품질을 정답 악보와 대조해 숫자로
site/                  다운로드 페이지 (비밀번호로 주소를 암호화)
```

## 반드시 알아야 할 함정들

전부 실제로 사고가 나서 알아낸 것이다. 고치기 전에 여기를 먼저 읽는다.

**scipy 가 워커를 영구히 멈춘다.** `transformers` 는 scipy·sklearn 이 설치돼 있으면
자동으로 import 하는데, scipy 의 BLAS DLL 이 torch 의 OpenMP 와 부딪혀 윈도우 DLL
로더가 교착에 빠진다. 모델을 올리는 순간 CPU 0%로 멈춘다. `worker.py` 의
`_hide_scipy_from_transformers()` 가 막고 있다. **이 함수를 지우면 앱이 죽는다.**
scipy·sklearn 은 채보·분석에 필요해서 환경에서 뺄 수 없고, 그쪽은 별도 프로세스라 괜찮다.

**파일 삭제는 `removeLocked` 를 쓴다.** 재생기가 음원을 붙잡고 있으면 윈도우가 삭제를
막는다(EBUSY). `fsp.rm` 을 직접 부르지 않는다. 화면에서는 지우기 전에 `releasePlayer()`.

**악보의 옥타브는 실제 노래보다 한 옥타브 높다.** 성악 표기 관행이다(실측: 악보 81~89,
실제 노래 중앙값 70). `transcribe.py` 의 `NOTATION_RANGE` 가 그걸 맞춘다. 동시에
`SINGABLE` 로 사람이 못 내는 음을 접어 넣는다 — 안 하면 MIDI 100 같은 음이 박힌다.

**가사에는 반드시 `[Verse]`/`[Chorus]` 태그가 있어야 한다.** YuE2 는 가사의 태그와
악보의 `% verse` 를 짝지어 어느 대목을 어디서 부를지 정한다. 태그 없이 줄글만 주면
가사가 전혀 맞지 않는다. `renderer/lyrics.js` 가 자동으로 붙인다.

**수노식 태그는 안 먹는다.** `[Verse 1: warm female vocal, breathy]` 의 대괄호 안
설명을 YuE2 는 못 읽는다. 악기·보컬 지시는 스타일 프롬프트(`[Tags]`)에서만 받는다.
`cleanLyrics` 가 그 설명을 뽑아내 스타일로 옮길지 물어본다.

**"코드만" 모드에 악보를 주면 안 된다.** 보컬 성부를 전부 쉼표로 채운 악보는 워커가
*연주곡*을 만들 때 쓰는 수법이다(`silence_vocals`). 노래를 아예 안 부른다. 화성·빠르기만
넘기려면 `abc` 를 `null` 로 두고 잰 값을 스타일 프롬프트로 넘긴다.

**노래 토큰은 9000개가 상한이다**(약 6분). 넘으면 뒤가 잘린다. 워커가 `truncated` 로
알려주니 화면에서 그걸 버리지 않는다.

**커버는 `plan()` 이 `request.abc` 를 받으면 작곡 단계를 건너뛴다**("Using provided
score"). 그래서 악보를 `meta.json` 에 남긴다 — `tidySong` 이 `plan/` 폴더를 지우기 때문.

## 채보 품질 (있는 그대로)

정답 악보를 아는 곡으로 대조한 실측치:

| 항목 | 결과 |
|---|---|
| 템포·박자·조표 | 정확 |
| 코드 근음 | 앞 네 마디 3/4, 전체 35% |
| 멜로디 윤곽 | 52% · 음정 ±1반음 55% |

**멜로디 채보는 실제 노래에서 잘 맞지 않는다.** 그래서 [코드·템포만]이 기본값이다.
품질을 바꿨다면 `python/score_compare.py` 로 숫자를 다시 재서 확인한다.

## 작업 규칙

- **파일 수정은 Edit 도구로.** 파이썬·셸 치환 스크립트를 쓰지 않는다. 이스케이프가
  세 겹(heredoc→Python→JS)으로 깨져 같은 수정을 여러 번 다시 하게 된다.
- 커밋 메시지는 한국어. 무엇을 왜 고쳤는지, 어떻게 확인했는지 적는다.
  끝에 `Co-Authored-By: Claude ... <noreply@anthropic.com>`.
- 배포(릴리스·firebase)는 사용자가 원할 때만.
- **고쳤다고 말하기 전에 재서 확인한다.** 이 프로젝트의 버그는 대부분 눈으로는
  안 보였다 — `py-spy` 로 스택을 뜨고, 파일 잠금을 실제로 걸어 보고, 정답 악보와
  대조해서 찾았다.
- 화면을 고쳤으면 `scripts/preview.mjs` 로 배치를 숫자로 확인한다. Electron 창은
  바깥에서 잴 수 없다.

## 남은 과제

- 채보한 악보에 `% verse` 구간 표시 넣기 (가사 태그에서 끌어오면 된다)
- 박자 추적이 배속을 잘못 잡는 경우 (발라드 68 → 136 으로 읽었다)
- 음 개수와 가사 음절 수가 크게 어긋나면 경고
- 이 소스의 출처: ssokMusic Free(ssok.dev, MIT)를 분석해 다시 작성했다. YuE2 모델
  자체의 상업적 사용 조건은 따로 확인이 필요하다.
