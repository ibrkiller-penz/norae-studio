'use strict'
// 노래공방 — 화면. 메인 프로세스와는 preload 가 열어준 window.norae 로만 이야기한다.

const $ = (id) => document.getElementById(id)
const api = window.norae

// ── 스타일 프리셋 ─────────────────────────────────────────────────────────────
// 모델이 영어 설명에 훨씬 잘 반응한다. 장르·악기·보컬 톤·분위기·BPM 순서로 적는다.
const PRESETS = [
  { name: '시티팝', style: 'Korean, 1980s city pop, groovy funk bass, Rhodes electric piano, bright brass stabs, clean funky guitar cutting, analog synth pads, tight disco drums, sweet airy Korean female vocal, nostalgic night drive mood, 112 BPM' },
  { name: '트로트', style: 'Korean trot, ppongjjak, upbeat cheerful festival mood, electric organ, bright saxophone fills, brass section, synth strings, shuffle drums with strong backbeat, walking electric bass, warm mature Korean female trot vocal with kkeokgi bending and wide vibrato, 128 BPM' },
  { name: '발라드', style: 'Korean ballad, emotional piano, lush string section, soft electric guitar solo, slow build to a big chorus, tender Korean female vocal with airy head voice, sorrowful and warm, 68 BPM' },
  { name: 'K-pop 댄스', style: 'K-pop dance pop, punchy synth bass, bright plucks, trap-influenced hi-hats, big layered chorus with group vocals, confident young Korean female vocal, glossy modern production, 124 BPM' },
  { name: 'R&B', style: 'Korean R&B, smooth Rhodes chords, mellow bass groove, laid-back drums, subtle vinyl texture, breathy soulful Korean female vocal with rich harmonies, late night mood, 86 BPM' },
  { name: '어쿠스틱 포크', style: 'Korean acoustic folk, fingerpicked steel string guitar, soft cajon, warm upright bass, gentle strings, intimate Korean female vocal, sunny afternoon mood, 96 BPM' },
  { name: '신스웨이브', style: 'synthwave retro pop, analog synth arpeggio, gated reverb drums, fat bass synth, neon 1980s atmosphere, dreamy Korean female vocal with reverb, 108 BPM' },
  { name: '록 밴드', style: 'Korean modern rock band, distorted electric guitars, driving bass, energetic live drums, anthemic chorus, powerful Korean female rock vocal, 142 BPM' },
  { name: '재즈 보사노바', style: 'bossa nova jazz, nylon string guitar, brushed drums, upright bass, soft flugelhorn, relaxed swing feel, smooth Korean female jazz vocal, cafe mood, 92 BPM' },
  { name: '동요', style: 'Korean childrens song, bright xylophone, playful piano, light percussion, simple cheerful melody, clear friendly Korean female vocal, happy and innocent mood, 116 BPM' }
]

// ── 진행률 추정 ───────────────────────────────────────────────────────────────
const STAGES = {
  plan: '작곡 (악보 만드는 중)',
  semantic: '노래 생성 중',
  synth: '소리로 바꾸는 중',
  decode: '파일로 저장 중'
}
const ORDER = ['plan', 'semantic', 'synth', 'decode']

// 처음 한 곡을 만들기 전까지 쓸 기본값(RTX 3050급 기준). 곡을 만들 때마다 메인 프로세스가
// 실제 속도를 재서 settings.json 에 쌓고, 여기서 그 값으로 갈아끼운다. 그래서 어떤 그래픽카드든
// 두세 곡이면 "남은 시간"이 맞아 들어간다.
const SPEED = { plan: 14, semantic: 30, synthPerToken: 0.034, decode: 8, load: 55 }

// 모델이 한 번에 만들 수 있는 노래 토큰의 상한. yue2 의 GenerationConfig 에
// semantic.max_tokens = 9000 으로 박혀 있다. 그 너머는 만들다 말고 잘린다.
const MAX_SONG_TOKENS = 9000
// 토큰 하나가 몇 초어치인지. 실측: 3,863토큰 → 166초 음원.
const TOKENS_PER_SECOND = 23
let learned = null // settings.speed — 이 컴퓨터에서 실제로 잰 값

const clamp = (value, low, high) => Math.min(high, Math.max(low, value))

// 가사 글자 수로 어림잡는 "보정 전" 토큰 수. 학습이 이 값과 실제값을 견주기 때문에
// 여기에는 학습 결과를 섞지 않는다(섞으면 비율이 1 로 수렴해 보정이 스스로 풀린다).
function baseTokens (lyrics) {
  const chars = (lyrics || '').replace(/^\s*\[.*\]\s*$/gm, '').replace(/\s/g, '').length
  return {
    plan: clamp(Math.round(500 + 3 * chars), 400, 4096),
    semantic: clamp(Math.round(1200 + 7 * chars), 800, 9000)
  }
}

function estimate (lyrics, { firstRun = true, skipPlan = false } = {}) {
  const speed = { ...SPEED, ...(learned || {}) }
  const base = baseTokens(lyrics)
  const tokens = {
    plan: Math.max(200, Math.round(base.plan * (learned && learned.planTokenFactor || 1))),
    semantic: Math.max(400, Math.round(base.semantic * (learned && learned.semanticTokenFactor || 1)))
  }
  const seconds = {
    // 커버는 악보를 이미 갖고 있다. 작곡 단계는 글자를 토큰으로 바꾸는 찰나로 끝난다.
    plan: skipPlan ? 1 : tokens.plan / speed.plan,
    semantic: tokens.semantic / speed.semantic,
    synth: tokens.semantic * speed.synthPerToken,
    decode: speed.decode
  }
  const total = ORDER.reduce((sum, key) => sum + seconds[key], 0) + (firstRun ? speed.load : 0)
  const weights = {}
  for (const key of ORDER) weights[key] = seconds[key] / total
  return { base, tokens, seconds, weights, total }
}

// ── 가사 다듬기 ───────────────────────────────────────────────────────────────
// 모델은 밋밋한 [Verse]/[Chorus] 표시로 학습됐다. 번호가 붙거나 꾸며진 태그,
// 가사 위에 붙은 마크다운 제목 줄은 둘 다 모델을 헷갈리게 한다.
// 순서가 중요하다. 위에서부터 먼저 맞는 것을 쓴다.
// pre-chorus 와 post-chorus 를 chorus 보다 먼저 봐야 한다. 안 그러면 둘 다
// 그냥 Chorus 가 되어 곡 구조가 뭉개진다.
const TAG_RULES = [
  [/pre[\s-]*chorus|프리\s*코러스/i, 'Pre-Chorus'],
  // YuE2 가 아는 구간에 post-chorus 는 없다. 후렴 뒤에 붙는 짧은 대목이라
  // 가장 가까운 것은 Chorus 다. 다만 pre 와 섞이지 않게 따로 잡아 둔다.
  [/post[\s-]*chorus|포스트\s*코러스/i, 'Chorus'],
  [/chorus|hook|refrain|후렴|코러스/i, 'Chorus'],
  [/verse|절|벌스/i, 'Verse'],
  [/bridge|브릿지/i, 'Bridge'],
  [/intro|인트로|전주/i, 'Intro'],
  [/outro|아우트로|아웃트로|후주/i, 'Outro']
]

// 부를 말이 없어도 모델에게 곡의 모양은 알려줘야 한다. 구간 표시와 연주 신호를
// 주면 보컬 자리를 비워두지, 없는 음절을 지어내지 않는다.
const INSTRUMENTAL_LYRICS = [
  '[Intro]', '[instrumental]', '', '[Verse]', '[instrumental]', '',
  '[Chorus]', '[instrumental]', '', '[Bridge]', '[instrumental]', '',
  '[Outro]', '[instrumental]'
].join('\n')

function instrumentalStyle (style) {
  return /\b(instrumental|no vocal)/i.test(style)
    ? style
    : `${style}, instrumental, no vocals, no singing, melody carried by lead instrument`
}

// 수노처럼 태그 안에 지시를 적는 사람이 많다.
//   [Verse 1: mid-range warm female vocal, breathy and husky tone]
// YuE2 는 그걸 못 읽는다. 대괄호 안은 구간 이름으로만 쓰이고, 악기·보컬 지시는
// [Tags](스타일 프롬프트)에서만 받는다. 그래서 태그는 기본형으로 되돌려야 하는데,
// 적어 준 지시를 그냥 버리면 안 된다. 뽑아내서 스타일 쪽으로 옮겨 준다.
function extractTagDescription (inside) {
  // "Verse 1: warm female vocal, husky" → {name:"Verse 1", description:"warm female vocal, husky"}
  const colon = inside.indexOf(':')
  if (colon < 0) return { name: inside.trim(), description: '' }
  return { name: inside.slice(0, colon).trim(), description: inside.slice(colon + 1).trim() }
}

function cleanLyrics (raw) {
  const notes = []
  const descriptions = []
  let lines = raw.replace(/\r\n/g, '\n').split('\n')

  const titles = lines.filter((line) => /^\s*#/.test(line)).length
  if (titles) {
    lines = lines.filter((line) => !/^\s*#/.test(line))
    notes.push(`제목 줄 ${titles}개를 제외했습니다`)
  }

  let retagged = 0
  lines = lines.map((line) => {
    const match = line.match(/^\s*\[([^\]]+)\]\s*$/)
    if (!match) return line
    const { name, description } = extractTagDescription(match[1])
    const rule = TAG_RULES.find(([pattern]) => pattern.test(name))
    if (!rule) return line
    if (description) descriptions.push(description)
    const tag = `[${rule[1]}]`
    if (tag !== line.trim()) retagged += 1
    return tag
  })
  if (retagged) notes.push(`구간 태그 ${retagged}개를 기본 형태로 바꿨습니다`)

  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return { text, notes, descriptions }
}

// 태그에서 뽑아낸 지시들을 스타일 프롬프트에 쓸 한 줄로 합친다. 같은 말이 여러 구간에
// 되풀이되므로(후렴마다 같은 보컬 지시) 중복은 지운다.
function mergeDescriptions (descriptions) {
  const seen = new Set()
  const parts = []
  for (const chunk of descriptions) {
    for (const piece of chunk.split(',')) {
      const trimmed = piece.trim()
      const key = trimmed.toLowerCase()
      if (!trimmed || seen.has(key)) continue
      seen.add(key)
      parts.push(trimmed)
    }
  }
  return parts.join(', ')
}

// ── 화면 상태 ─────────────────────────────────────────────────────────────────
let songs = []
let selected = null
let running = false
let warmed = false // 모델 적재 비용(~1분)은 첫 곡에만 든다
let currentProject = null
let runningJob = null
let queueState = { current: null, waiting: [] }
const plans = new Map() // jobId → 시간 추정. 대기 중인 곡도 자기 추정치를 갖는다
let plan = estimate('')
let updateHint = () => {} // wireGenerate 가 채운다. 학습값이 바뀌면 예상 시간을 다시 그린다

// 만들기 모드. 'cover' 면 고른 원곡의 악보를 그대로 쓰고 편곡(스타일)만 새로 한다.
let mode = 'new'
let coverScore = null // {dir, abc, title, lyrics, style}
let scoreFile = null  // 채보하려고 고른 음원
let scoreResult = null // 채보 결과 {abc, info}

// ── 잔심부름 ──────────────────────────────────────────────────────────────────
let toastTimer = null
function toast (text, ms = 2600) {
  const box = $('toast')
  box.textContent = text
  box.classList.remove('hidden')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => box.classList.add('hidden'), ms)
}

const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)}GB`

function mmss (seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}분 ${String(s).padStart(2, '0')}초`
}

// Electron 에는 prompt() 가 없다. 직접 만든 입력 상자를 약속(Promise)으로 감싼다.
function ask (title, initial = '') {
  return new Promise((resolve) => {
    $('askTitle').textContent = title
    $('askInput').value = initial
    $('ask').classList.remove('hidden')
    $('askInput').focus()
    $('askInput').select()
    const done = (value) => {
      $('ask').classList.add('hidden')
      $('askOk').onclick = null
      $('askCancel').onclick = null
      $('askInput').onkeydown = null
      resolve(value)
    }
    $('askOk').onclick = () => done($('askInput').value.trim() || null)
    $('askCancel').onclick = () => done(null)
    $('askInput').onkeydown = (e) => {
      if (e.key === 'Enter') done($('askInput').value.trim() || null)
      if (e.key === 'Escape') done(null)
    }
  })
}

/**
 * 예/아니오만 묻는다.
 *
 * 전에는 지울 때마다 "삭제" 를 받아 적게 했는데, 손이 많이 가고 오타가 나면
 * 아무 일도 일어나지 않아 "안 지워진다" 로 보였다. 휴지통으로 가는 일이라
 * 되돌릴 수 있으니 한 번 묻는 것으로 충분하다.
 */
function confirmAsk (title, okLabel = '삭제') {
  return new Promise((resolve) => {
    $('askTitle').textContent = title
    $('askInput').classList.add('hidden')
    $('askOk').textContent = okLabel
    $('askOk').classList.add('danger')
    $('ask').classList.remove('hidden')
    $('askOk').focus()

    const done = (yes) => {
      $('ask').classList.add('hidden')
      $('askInput').classList.remove('hidden')
      $('askOk').textContent = '확인'
      $('askOk').classList.remove('danger')
      $('askOk').onclick = null
      $('askCancel').onclick = null
      document.onkeydown = null
      resolve(yes)
    }
    $('askOk').onclick = () => done(true)
    $('askCancel').onclick = () => done(false)
    document.onkeydown = (e) => {
      if (e.key === 'Escape') done(false)
      if (e.key === 'Enter') done(true)
    }
  })
}

function showProblem (message, detail) {
  $('problemText').textContent = message || '알 수 없는 오류입니다.'
  const box = $('problemDetail')
  box.textContent = detail || ''
  box.classList.toggle('hidden', !detail)
  $('problem').classList.remove('hidden')
}

// ── 설치 화면 ─────────────────────────────────────────────────────────────────
function setStep (step, status, detail) {
  const li = document.querySelector(`.steps li[data-step="${step}"]`)
  if (!li) return
  li.classList.remove('run', 'done')
  if (status) li.classList.add(status)
  if (detail) li.querySelector('.detail').textContent = detail
}

async function refreshLocation () {
  const place = await api.location()
  $('dataDir').textContent = place.dataDir + (place.freeGb === null ? '' : `  (여유 ${place.freeGb}GB)`)
}

async function refreshPreflight () {
  const check = await api.checkSetup()
  const box = $('preflight')
  const lines = [...check.problems, ...check.warnings]
  box.className = 'preflight' + (check.problems.length ? ' bad' : check.warnings.length ? ' warn' : '')
  box.textContent = lines.join('\n\n')
  box.classList.toggle('hidden', !lines.length)
  $('setupStart').disabled = !check.ok

  // 같은 부품이 이미 컴퓨터에 있으면 다시 받을 이유가 없다.
  const adopt = $('adopt')
  if (check.adoptable) {
    $('adoptPath').textContent = `${check.adoptable.python} (PyTorch ${check.adoptable.torch})`
    adopt.classList.remove('hidden')
  } else {
    adopt.classList.add('hidden')
  }
  if (check.gpu && check.gpu.ok) setStep('gpu', 'done', `${check.gpu.name} (${check.gpu.vramGb}GB)`)
  return check
}

function wireSetup () {
  api.onSetupStep(({ step, status, detail }) => setStep(step, status, detail))

  api.onSetupProgress(({ step, got, total }) => {
    if (!total) return
    setStep(step, 'run', `${gb(got)} / ${gb(total)}`)
    // 모델(8GB)과 파이토치(3GB)가 대부분의 시간을 먹는다. 막대는 그 둘만 따라간다.
    if (step === 'models' || step === 'uv') {
      $('setupBar').style.width = `${Math.min(100, got / total * 100)}%`
    }
  })

  api.onSetupLog((line) => {
    const box = $('setupLog')
    box.textContent = `${box.textContent}${line}\n`.split('\n').slice(-400).join('\n')
    box.scrollTop = box.scrollHeight
  })

  $('setupLogToggle').onclick = () => $('setupLog').classList.toggle('hidden')

  $('pickLocation').onclick = async () => {
    const picked = await api.pickLocation()
    if (picked.canceled) return
    if (!picked.ok) return toast(picked.message)
    await refreshLocation()
    await refreshPreflight()
  }

  $('adoptUse').onclick = async () => {
    $('adoptUse').disabled = true
    const result = await api.adoptRuntime()
    $('adoptUse').disabled = false
    if (!result.ok) return showProblem(result.message)
    toast('기존 실행환경을 가져왔습니다.')
    $('setup').classList.add('hidden')
    await boot()
  }

  $('setupStart').onclick = async () => {
    $('setupStart').disabled = true
    $('setupError').classList.add('hidden')
    $('setupStart').textContent = '설치 중…'
    const result = await api.runSetup()
    $('setupStart').textContent = '설치 시작'
    if (!result.ok) {
      $('setupError').textContent = result.message
      $('setupError').classList.remove('hidden')
      $('setupStart').disabled = false
      $('setupLog').classList.remove('hidden')
      return
    }
    $('setup').classList.add('hidden')
    await boot()
  }
}

// ── 프로젝트 ──────────────────────────────────────────────────────────────────
async function refreshProjects () {
  const { current, projects } = await api.projects()
  currentProject = current
  const select = $('project')
  select.innerHTML = ''
  for (const item of projects) {
    const option = document.createElement('option')
    option.value = item.name
    option.textContent = `${item.name} (${item.songs})`
    select.appendChild(option)
  }
  select.value = current
}

function wireProjects () {
  $('project').onchange = async (e) => {
    await api.selectProject(e.target.value)
    await refreshProjects()
    await refreshSongs()
  }

  $('newProject').onclick = async () => {
    const name = await ask('새 프로젝트 이름')
    if (!name) return
    const result = await api.createProject(name)
    if (!result.ok) return toast(result.message)
    await refreshProjects()
    await refreshSongs()
  }

  $('renameProject').onclick = async () => {
    const name = await ask('프로젝트 이름 변경', currentProject)
    if (!name) return
    const result = await api.renameProject(currentProject, name)
    if (!result.ok) return toast(result.message)
    await refreshProjects()
    await refreshSongs()
  }

  $('deleteProject').onclick = async () => {
    const name = currentProject
    // 곡이 통째로 사라지는 일이라 몇 곡인지 보여주고 묻는다.
    const count = songs.length
    const what = count ? `안에 든 곡 ${count}개와 함께 ` : ''
    if (!await confirmAsk(`"${name}" 프로젝트를 ${what}휴지통으로 보냅니다.`)) return

    releasePlayer() // 재생 중이면 파일을 붙잡고 있어 삭제가 막힌다
    const result = await api.deleteProject(name)
    if (!result.ok) return showProblem(result.message || '지우지 못했습니다.')
    toast('휴지통으로 보냈습니다.')
    selected = null
    $('player').classList.add('hidden')
    await refreshProjects()
    await refreshSongs()
  }

  $('openFolder').onclick = async () => {
    const state = await api.state()
    if (state.songsDir) api.open(state.songsDir)
  }
}

// ── 곡 보관함 ─────────────────────────────────────────────────────────────────
function songLine (song) {
  const row = document.createElement('div')
  row.className = 'song' + (song.unfinished ? ' unfinished' : '') +
    (selected && selected.dir === song.dir ? ' on' : '')
  const when = String(song.createdAt || '').replace('T', ' ').slice(0, 16)
  const length = song.seconds ? `${Math.floor(song.seconds / 60)}:${String(Math.round(song.seconds % 60)).padStart(2, '0')}` : ''
  row.innerHTML = `
    <div class="t"><span></span><span class="tag"></span></div>
    <div class="s"></div>`
  row.querySelector('.t span').textContent = song.title || '무제'
  row.querySelector('.tag').textContent = song.unfinished ? '미완성' : (song.format || '').toUpperCase()
  row.querySelector('.s').textContent = [when, length].filter(Boolean).join(' · ')

  row.onclick = () => {
    if (song.unfinished) return resumeSong(song)
    selectSong(song)
  }
  return row
}

async function refreshSongs () {
  songs = await api.listSongs()
  const box = $('songs')
  box.innerHTML = ''

  // 만드는 중인 곡과 대기 중인 곡을 보관함 맨 위에 보여준다.
  if (runningJob) {
    const row = document.createElement('div')
    row.className = 'song'
    row.innerHTML = '<div class="t"><span></span><span class="tag">생성 중</span></div>'
    row.querySelector('.t span').textContent = runningJob.title
    box.appendChild(row)
  }

  if (!songs.length && !runningJob) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = '아직 만든 곡이 없습니다.\n왼쪽에 가사와 스타일을 적고 [곡 만들기]를 누르세요.'
    empty.style.whiteSpace = 'pre-line'
    box.appendChild(empty)
  }

  for (const song of songs) box.appendChild(songLine(song))

  if (mode === 'cover' && $('coverFrom').value === 'song') refreshCoverPicker()

  // 골라뒀던 곡이 사라졌으면 재생기를 접는다.
  if (selected && !songs.some((s) => s.dir === selected.dir)) {
    selected = null
    $('player').classList.add('hidden')
    $('audio').src = ''
  }
}

function selectSong (song) {
  selected = song
  $('player').classList.remove('hidden')
  $('nowTitle').textContent = song.title || '무제'
  $('audio').src = song.audioUrl || ''
  $('songMeta').textContent = [
    `스타일: ${song.style || '—'}`,
    `시드: ${song.seed ?? '—'}`,
    `길이: ${song.seconds ? `${song.seconds}초` : '—'}`,
    `만드는 데 걸린 시간: ${song.wallSeconds ? mmss(song.wallSeconds) : '—'}`,
    `폴더: ${song.dir}`
  ].join('\n')
  refreshSongs()
}

async function resumeSong (song) {
  const go = await ask(`"${song.title}" 은(는) 만들다 만 곡입니다.\n이어서 만들려면 "이어"라고 입력하세요.`)
  if (go !== '이어') return
  const result = await api.resume(song.dir)
  if (!result.ok) return showProblem(result.message)
  toast('이어서 만듭니다.')
}

/**
 * 재생기가 물고 있는 음원 파일을 놓게 한다.
 *
 * src 를 '' 로 두는 것만으로는 브라우저가 파일을 반납하지 않는다. 속성을 지우고
 * load() 를 불러야 한다. 이걸 안 해서 윈도우가 "사용 중인 파일"이라며 삭제를
 * 막았고, 앱은 그 실패를 알리지도 않아 그냥 안 지워지는 것처럼 보였다.
 */
function releasePlayer () {
  const audio = $('audio')
  try {
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
  } catch { /* 재생기가 비어 있으면 그만이다 */ }
}

function wireLibrary () {
  $('renameSong').onclick = async () => {
    if (!selected) return
    const name = await ask('곡 이름 변경', selected.title)
    if (!name) return
    await api.rename(selected.dir, name)
    selected.title = name
    $('nowTitle').textContent = name
    await refreshSongs()
  }

  $('revealSong').onclick = () => selected && api.reveal(selected.dir)

  $('exportMp3').onclick = async () => {
    if (!selected) return
    const result = await api.exportMp3(selected.dir, selected.title)
    if (result.canceled) return
    toast(result.ok ? `저장했습니다: ${result.path}` : result.message)
  }

  $('deleteSong').onclick = async () => {
    if (!selected) return
    const song = selected
    if (!await confirmAsk(`"${song.title}" 을(를) 휴지통으로 보냅니다.`)) return

    // 재생기가 음원 파일을 붙잡고 있으면 윈도우가 삭제를 막는다.
    // src 를 빈 문자열로 두는 것만으로는 안 놓는다. 속성을 지우고 load() 까지 해야
    // 브라우저가 파일 핸들을 실제로 반납한다.
    releasePlayer()
    selected = null
    $('player').classList.add('hidden')

    const result = await api.remove(song.dir)
    if (!result.ok) {
      // 전에는 결과를 보지도 않아서, 실패해도 아무 말 없이 그대로 남아 있었다.
      selected = song
      $('player').classList.remove('hidden')
      return showProblem(result.message || '삭제하지 못했습니다.', result.detail)
    }
    // 휴지통이 끝내 거부하면 메인이 폴더째 지운다. 그때는 되돌릴 수 없으니 알린다.
    toast(result.trashed === false
      ? '휴지통이 거부해서 바로 지웠습니다. 되돌릴 수 없습니다.'
      : '휴지통으로 보냈습니다.', 5000)
    await refreshSongs()
    await refreshProjects()
  }
}

// ── 설정 ──────────────────────────────────────────────────────────────────────
async function refreshSettings () {
  const settings = await api.getSettings()
  $('autoMp3').checked = settings.autoMp3
  $('dropWav').checked = settings.dropWav
  $('dropWav').disabled = !settings.autoMp3
  $('updateCheck').checked = settings.updateCheck
  $('updateRepo').value = settings.updateRepo
  learned = settings.speed || null
  // plan 은 "지금 만들고 있는 곡"의 추정치다. 생성 중에 설정 창을 열었다고 해서
  // 입력칸에 적힌 다른 가사 기준으로 덮어쓰면 진행 막대가 엉뚱하게 뛴다.
  if (!running) plan = estimate($('lyrics').value, { firstRun: !warmed })
  $('speedInfo').textContent = learned
    ? `곡 ${learned.samples}개를 만들면서 잰 값으로 예상 시간을 맞추고 있습니다 ` +
      `(노래 생성 초당 ${Math.round(learned.semantic)}토큰).`
    : '아직 측정값이 없습니다. 곡을 만들수록 예상 시간이 정확해집니다.'
  return settings
}

function wireSettings () {
  const save = async () => {
    const next = await api.setSettings({
      autoMp3: $('autoMp3').checked,
      dropWav: $('dropWav').checked,
      updateCheck: $('updateCheck').checked,
      updateRepo: $('updateRepo').value
    })
    $('dropWav').checked = next.dropWav
    $('dropWav').disabled = !next.autoMp3
  }
  $('autoMp3').onchange = save
  $('dropWav').onchange = save

  $('settingsBtn').onclick = async () => {
    await refreshSettings()
    $('settings').classList.remove('hidden')
  }
  $('settingsSave').onclick = async () => {
    await save()
    $('settings').classList.add('hidden')
    toast('저장했습니다.')
  }
  $('settingsClose').onclick = () => $('settings').classList.add('hidden')
  $('openLog').onclick = () => api.openLog()

  // AI 모델(가중치) 갱신 — 프로그램 업데이트와는 별개다.
  const short = (sha) => (sha || '').slice(0, 7) || '—'

  const showModels = (result) => {
    const box = $('modelInfo')
    if (!result.reachable) {
      box.textContent = '허깅페이스에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.'
      $('modelUpdate').classList.add('hidden')
      return
    }
    if (result.missing) {
      box.textContent = '모델이 설치되어 있지 않습니다. 설치를 먼저 진행해 주세요.'
      $('modelUpdate').classList.add('hidden')
      return
    }
    const lines = result.repos.map((r) =>
      `${r.repo.split('/')[1]}: ${short(r.local)}` + (r.changed ? ` → ${short(r.remote)} (새 판)` : ' (최신)'))
    lines.push(`저장 위치 ${result.hfHome} · ${result.cacheGb}GB`)
    box.textContent = lines.join('\n')
    $('modelUpdate').classList.toggle('hidden', !result.hasUpdate)
  }

  const checkModels = async () => {
    $('modelInfo').textContent = '확인 중…'
    try { showModels(await api.checkModels()) } catch (error) {
      $('modelInfo').textContent = `확인하지 못했습니다: ${error.message}`
    }
  }

  $('modelCheck').onclick = checkModels

  $('modelUpdate').onclick = async () => {
    const typed = await ask('새 음악 모델을 받습니다. 바뀐 파일만 받지만 몇 GB일 수 있습니다.\n계속하려면 "받기"라고 입력하세요.')
    if (typed !== '받기') return
    $('modelUpdate').disabled = true
    $('modelCheck').disabled = true
    $('modelBarWrap').classList.remove('hidden')
    const result = await api.updateModels()
    $('modelUpdate').disabled = false
    $('modelCheck').disabled = false
    $('modelBarWrap').classList.add('hidden')
    $('modelBar').style.width = '0%'
    if (!result.ok) return showProblem(result.message)
    showModels(result)
    toast('새 음악 모델을 받았습니다.')
  }

  api.onModelProgress(({ bytes, total }) => {
    if (!total) return
    $('modelBar').style.width = `${Math.min(100, bytes / total * 100)}%`
    $('modelInfo').textContent = `받는 중… ${gb(bytes)} / 약 ${gb(total)}`
  })

  // 설정 창을 열 때마다 확인하면 느리다. 창을 처음 열 때 한 번만 본다.
  let modelsChecked = false
  const maybeCheckModels = () => {
    if (modelsChecked) return
    modelsChecked = true
    checkModels()
  }
  $('settingsBtn').addEventListener('click', maybeCheckModels)

  $('resetSpeed').onclick = async () => {
    await api.resetSpeed()
    await refreshSettings()
    updateHint()
    toast('측정값을 지웠습니다. 다음 곡부터 다시 잽니다.')
  }

  $('compact').onclick = async () => {
    const typed = await ask('이미 만든 곡을 MP3로 바꾸고 중간 파일을 지웁니다.\n계속하려면 "정리"라고 입력하세요.')
    if (typed !== '정리') return
    // 원본 음원(wav)을 지우는 작업이다. 재생기가 붙잡고 있으면 EBUSY 가 난다.
    releasePlayer()
    selected = null
    $('player').classList.add('hidden')
    toast('정리 중입니다…', 60000)
    const result = await api.compact()
    if (!result.ok) return toast(result.message)
    toast(`${result.converted}곡 변환, ${result.savedGb}GB 절약했습니다.`)
    if (result.failures.length) showProblem('일부 곡을 정리하지 못했습니다.', result.failures.join('\n'))
    await refreshSongs()
  }

  $('moveModels').onclick = async () => {
    const result = await api.moveModels()
    if (result.canceled) return
    toast(result.ok ? `옮겼습니다: ${result.path}` : result.message)
  }

  $('lyricsHelp').onclick = () => showProblemAsHelp()
}

function showProblemAsHelp () {
  $('problemText').textContent =
    '가사를 구간으로 나누면 곡 구조가 잡힙니다. 대괄호 태그를 줄 하나에 단독으로 적으세요.\n\n' +
    '[Intro]  전주\n[Verse]  절\n[Pre-Chorus]  후렴 직전\n[Chorus]  후렴\n[Bridge]  브릿지\n[Outro]  후주\n\n' +
    '· 한국어로 [후렴] 처럼 적어도 자동으로 바꿔 줍니다.\n' +
    '· [Verse 1] 처럼 번호를 붙이면 [Verse] 로 정리됩니다.\n' +
    '· 가사 맨 위의 # 제목 줄은 자동으로 빠집니다.\n' +
    '· 가사가 길수록 곡이 길어지고 생성 시간도 늘어납니다.'
  $('problemDetail').classList.add('hidden')
  document.querySelector('#problem h1').textContent = '구간 태그 안내'
  $('problem').classList.remove('hidden')
}

// ── 대기열 ────────────────────────────────────────────────────────────────────
function renderQueue () {
  const box = $('queueBox')
  const list = $('queueList')
  list.innerHTML = ''
  if (!queueState.waiting.length) {
    box.classList.add('hidden')
    return
  }
  box.classList.remove('hidden')
  for (const item of queueState.waiting) {
    const li = document.createElement('li')
    const name = document.createElement('span')
    name.textContent = item.title
    const drop = document.createElement('button')
    drop.className = 'ghost small'
    drop.textContent = '빼기'
    drop.onclick = async () => {
      const result = await api.queueRemove(item.jobId)
      if (!result.ok) toast(result.message)
    }
    li.append(name, drop)
    list.appendChild(li)
  }
}

// ── 생성 ──────────────────────────────────────────────────────────────────────
function stageProgress (stage, fraction) {
  let base = 0
  for (const key of ORDER) {
    if (key === stage) break
    base += plan.weights[key]
  }
  // 1.0 은 "끝났다"는 뜻으로 아껴 둔다. 마지막 단계에서 막대가 미리 차면 안 된다.
  return Math.min(0.995, base + plan.weights[stage] * clamp(fraction, 0, 1))
}

function showProgress (stage, fraction, note) {
  $('run').classList.remove('hidden')
  $('runStage').textContent = STAGES[stage] || stage
  const done = stageProgress(stage, fraction)
  $('runBar').style.width = `${done * 100}%`
  const left = plan.total * (1 - done)
  $('runNote').textContent = note || `남은 시간 약 ${mmss(left)}`
}

function setRunning (on, title) {
  running = on
  $('generate').disabled = on
  $('generate').textContent = on ? '만드는 중…' : '곡 만들기'
  $('run').classList.toggle('hidden', !on)
  if (on) $('runTitle').textContent = title || ''
  else $('runBar').style.width = '0%'
}

// ── 커버 · 편곡 ───────────────────────────────────────────────────────────────
// 원곡의 악보(ABC)를 그대로 넘기면 작곡 단계를 건너뛴다. 멜로디와 코드는 그대로 두고
// 편곡과 보컬만 새로 만드는 것이라, 같은 곡의 "다른 장르 버전"이 된다.

// 커버 후보는 악보가 남아 있는 곡뿐이다. 악보를 남기기 전에 만든 곡은 고를 수 없다.
function coverCandidates () {
  return songs.filter((song) => song.canCover && !song.unfinished)
}

function refreshCoverPicker () {
  const select = $('coverSource')
  const candidates = coverCandidates()
  const keep = coverScore && coverScore.dir
  select.innerHTML = ''

  if (!candidates.length) {
    const option = document.createElement('option')
    option.textContent = '커버할 수 있는 곡이 없습니다'
    option.value = ''
    select.appendChild(option)
    select.disabled = true
    $('coverNote').textContent = '이 프로그램으로 만든 곡이 있어야 커버할 수 있습니다.'
    return
  }

  select.disabled = false
  for (const song of candidates) {
    const option = document.createElement('option')
    option.value = song.dir
    option.textContent = song.title || '무제'
    select.appendChild(option)
  }
  if (keep && candidates.some((song) => song.dir === keep)) select.value = keep
  $('coverNote').textContent = '멜로디와 코드는 그대로 두고 편곡만 새로 합니다.'
}

// 고른 원곡의 악보를 가져와, 스타일·가사 칸을 원곡 값으로 채운다.
async function loadCoverSource (dir) {
  if (!dir) { coverScore = null; return }
  const result = await api.score(dir)
  if (!result.ok) {
    coverScore = null
    $('coverNote').textContent = result.message
    return
  }
  coverScore = { dir, ...result }
  if (!$('lyrics').value.trim()) $('lyrics').value = result.lyrics
  if (!$('style').value.trim()) $('style').value = result.style
  if (!$('title').value.trim()) $('title').value = `${result.title} (커버)`
  $('coverNote').textContent = '멜로디와 코드는 그대로. 스타일을 바꿔 보세요.'
  updateHint()
}

function setMode (next) {
  mode = next
  for (const button of document.querySelectorAll('.mode')) {
    button.classList.toggle('on', button.dataset.mode === next)
  }
  const cover = next === 'cover'
  $('coverPick').classList.toggle('hidden', !cover)
  $('generate').textContent = cover ? '커버 만들기' : '곡 만들기'
  // 커버는 악보가 이미 있으니 작곡 단계를 건너뛴다. 남은 단계만 세면 된다.
  updateHint()
  if (cover) setCoverFrom($('coverFrom').value)
}

// 커버 재료를 어디서 가져올지: 내가 만든 곡 / MP3 파일 / 유튜브
function setCoverFrom (from) {
  const isSong = from === 'song'
  $('coverSource').classList.toggle('hidden', !isSong)
  $('coverPickFile').classList.toggle('hidden', from !== 'file')
  $('coverPickYt').classList.toggle('hidden', from !== 'yt')
  if (isSong) {
    refreshCoverPicker()
    loadCoverSource($('coverSource').value)
  } else {
    coverScore = null
    $('coverNote').textContent = from === 'file'
      ? 'MP3 를 고르면 악보를 뽑아냅니다.'
      : '유튜브에서 MP3 를 받은 뒤 악보를 뽑아냅니다.'
  }
}

// 음원 하나를 받아 채보 창을 연다. 두 경로(파일 고르기 / 유튜브)가 여기로 모인다.
function openScoreDialog (filePath) {
  // 새 곡을 가져왔는데 가사칸에 앞 곡 가사가 그대로 남아 있으면, 그 가사로 노래한다.
  // 실제로 박화요비 곡 악보에 이선희 가사가 얹혀 나왔다. 이전 곡 것이면 비운다.
  if (scoreFile && scoreFile !== filePath && $('lyrics').value.trim()) {
    $('lyrics').value = ''
    toast('새 곡이라 가사칸을 비웠습니다. 이 곡의 가사를 넣어 주세요.', 6000)
  }
  scoreFile = filePath
  $('scoreFileName').textContent = filePath.split(/[\\/]/).pop()
  $('scoreResult').classList.add('hidden')
  $('scoreUse').classList.add('hidden')
  $('scoreStatus').textContent = ''
  $('score').classList.remove('hidden')
  api.transcribeReady().then((ready) => {
    $('scoreInstall').classList.toggle('hidden', ready)
    $('scoreRun').disabled = !ready
    if (!ready) $('scoreStatus').textContent = '보컬 분리 도구를 먼저 설치해 주세요.'
  })
}

function wireCover () {
  for (const button of document.querySelectorAll('.mode')) {
    button.onclick = () => setMode(button.dataset.mode)
  }
  $('coverSource').onchange = (e) => loadCoverSource(e.target.value)
  $('coverFrom').onchange = (e) => setCoverFrom(e.target.value)

  $('coverPickFile').onclick = async () => {
    const picked = await api.analyzePickFile()
    if (!picked.ok) return
    openScoreDialog(picked.path)
  }

  $('coverPickYt').onclick = async () => {
    const url = await ask('유튜브 주소를 넣으세요', '')
    if (!url) return
    $('coverNote').textContent = '유튜브에서 받는 중…'
    const result = await api.ytDownload({ url, dir: await api.ytFolder(), bitrate: 320 })
    if (!result.ok) {
      $('coverNote').textContent = ''
      if (result.message === 'needs-install') return toast('먼저 [참고곡 분석]에서 도구를 설치해 주세요.')
      return showProblem(result.message)
    }
    $('coverNote').textContent = `받았습니다: ${result.title}`
    openScoreDialog(result.path)
  }

  // 재생기에서 바로 "이 곡 커버"
  $('coverThis').onclick = async () => {
    if (!selected) return
    if (!selected.canCover) {
      return toast('이 곡에는 악보가 남아 있지 않아 커버를 만들 수 없습니다.')
    }
    setMode('cover')
    $('coverSource').value = selected.dir
    $('title').value = `${selected.title} (커버)`
    $('lyrics').value = selected.lyrics || ''
    $('style').value = ''
    await loadCoverSource(selected.dir)
    $('style').focus()
    toast('스타일을 바꾸고 [커버 만들기]를 누르세요.')
  }
}

// ── 참고곡 분석 ───────────────────────────────────────────────────────────────
// 참고곡에서 재는 것은 템포·조성·코드진행·음색 같은 "음악적 사실"이다. 멜로디는
// 따오지 않는다. 잰 값을 영어 스타일 설명으로 옮겨 주면, 작곡은 AI 가 새로 한다.
let refAnalysis = null
let refFilePath = null

function refStatus (text) { $('refStatus').textContent = text || '' }

function showAnalysis (a) {
  refAnalysis = a
  // 조성 신뢰도가 낮으면 음악이 아니거나(말소리·효과음) 조가 계속 바뀌는 곡이다.
  // 그대로 쓰면 엉뚱한 프롬프트가 되므로 미리 알려 준다.
  const shaky = a.keyConfidence < 0.5
  $('refResult').textContent = [
    `템포        ${a.bpm} BPM`,
    `조성        ${a.key} ${a.mode}  (나란한조 ${a.relativeKey})` +
      (shaky ? `  ← 확신 낮음 ${a.keyConfidence}` : ''),
    `코드 진행    ${a.progression.join(' - ') || '—'}`,
    `음색        중심 ${a.centroid}Hz · 셈여림 ${a.dynamics} · 타악기 ${a.drive}`,
    `분석 길이    ${a.seconds}초`,
    '',
    ...(shaky
      ? ['', '⚠ 조성 확신이 낮습니다. 음악이 아니거나 조가 자주 바뀌는 곡일 수 있습니다.',
          '   조성·코드 부분은 지우고 템포만 쓰는 편이 나을 수 있습니다.']
      : []),
    '',
    '만들어진 스타일 프롬프트:',
    a.prompt
  ].join('\n')
  $('refResult').classList.remove('hidden')
  $('refApply').classList.remove('hidden')
}

function wireScore () {
  const chordsOnly = () => document.querySelector('input[name="scoreMode"]:checked').value === 'chords'

  $('scoreClose').onclick = () => {
    api.transcribeCancel()
    $('score').classList.add('hidden')
  }

  $('scoreInstallBtn').onclick = async () => {
    $('scoreInstallBtn').disabled = true
    $('scoreStatus').textContent = '설치하는 중… 몇 분 걸릴 수 있습니다.'
    const result = await api.transcribeInstall()
    $('scoreInstallBtn').disabled = false
    if (!result.ok) return showProblem(result.message)
    $('scoreInstall').classList.add('hidden')
    $('scoreRun').disabled = false
    $('scoreStatus').textContent = '설치했습니다.'
  }

  $('scoreRun').onclick = async () => {
    if (!scoreFile) return toast('음원 파일이 없습니다.')
    $('scoreRun').disabled = true
    $('scoreRun').textContent = '만드는 중…'
    $('scoreBarWrap').classList.remove('hidden')
    $('scoreResult').classList.add('hidden')
    $('scoreUse').classList.add('hidden')

    const result = await api.transcribeRun({ file: scoreFile, chordsOnly: chordsOnly() })

    $('scoreRun').disabled = false
    $('scoreRun').textContent = '악보 만들기'
    $('scoreBarWrap').classList.add('hidden')
    $('scoreBar').style.width = '0%'

    if (!result.ok) {
      $('scoreStatus').textContent = ''
      if (result.message === 'needs-install') {
        $('scoreInstall').classList.remove('hidden')
        return toast('보컬 분리 도구를 먼저 설치해 주세요.')
      }
      return showProblem(result.message)
    }

    scoreResult = result
    const info = result.info
    $('scoreStatus').textContent = '악보를 만들었습니다.'
    $('scoreResult').textContent = [
      `빠르기    ${info.bpm} BPM`,
      `조성      ${info.key}`,
      `마디      ${info.bars}마디 (${info.seconds}초)`,
      info.chordsOnly
        ? '멜로디    가져오지 않음 — AI 가 새로 짓고 가사를 부릅니다'
        : `음        ${info.notes}개` + (info.octaveShift ? ` (악보 표기에 맞춰 ${info.octaveShift}옥타브 올림)` : ''),
      `코드      ${(info.chords || []).join(' - ') || '—'}`,
      info.separated ? '보컬 분리  했음' : '보컬 분리  실패 — 정확도가 낮습니다'
    ].join('\n')
    $('scoreResult').classList.remove('hidden')
    $('scoreUse').classList.remove('hidden')
  }

  $('scoreUse').onclick = () => {
    if (!scoreResult) return
    const name = (scoreFile || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '')
    if (!$('title').value.trim()) $('title').value = `${name} (커버)`.slice(0, 60)
    $('score').classList.add('hidden')

    if (scoreResult.info && scoreResult.info.chordsOnly) {
      // 코드만 가져올 때 악보를 넘기면 안 된다. 보컬 성부가 쉼표뿐인 악보는 워커가
      // 연주곡을 만들 때 쓰는 바로 그 꼴이라, 노래를 아예 안 부른다.
      // 화성·빠르기는 말로 넘기고 가락은 모델이 짓게 한다.
      coverScore = null
      setMode('new')
      const existing = $('style').value.trim()
      const measured = scoreResult.info.prompt || ''
      $('style').value = existing ? `${existing}, ${measured}` : measured
      updateHint()
      return toast('원곡의 화성·빠르기를 스타일에 넣었습니다. 장르와 보컬을 앞에 덧붙이세요.', 6000)
    }

    coverScore = { dir: null, abc: scoreResult.abc, title: name, lyrics: '', style: '' }
    $('coverNote').textContent = `악보 준비됨: ${name}`

    // 악보에는 Q:1/4=136 이라 써 놓고 스타일 프리셋에는 86 BPM 이 들어 있으면
    // 모델이 상반된 지시를 받는다. 실제로 그렇게 나간 곡이 있었다.
    // 악보에서 잰 템포·조성을 스타일에도 넣어 둔다.
    const measured = (scoreResult.info && scoreResult.info.prompt) || ''
    if (measured && !$('style').value.includes(measured)) {
      const existing = $('style').value.trim()
      $('style').value = existing ? `${existing}, ${measured}` : measured
    }

    updateHint()
    toast('가사와 스타일을 적고 [커버 만들기]를 누르세요. 이 곡의 가사를 꼭 새로 넣으세요.', 6000)
  }

  api.onTranscribeProgress((event) => {
    if (event.type === 'progress') {
      if (event.percent) $('scoreBar').style.width = `${event.percent}%`
      if (event.note) $('scoreStatus').textContent = event.note
    } else if (event.type === 'notice') {
      toast(event.message, 6000)
    } else if (event.type === 'stage') {
      const labels = {
        separate: '보컬을 분리하는 중… (가장 오래 걸립니다)',
        decode: '음원을 읽는 중',
        melody: '멜로디를 따는 중…'
      }
      if (event.status === 'start' && labels[event.stage]) {
        $('scoreStatus').textContent = labels[event.stage]
      }
    }
  })
}

function wireReference () {
  const setBusy = (busy) => {
    $('refRun').disabled = busy
    $('refRun').textContent = busy ? '분석 중…' : '분석하기'
    $('refBarWrap').classList.toggle('hidden', !busy)
    if (!busy) $('refBar').style.width = '0%'
  }

  $('refOpen').onclick = async () => {
    $('ref').classList.remove('hidden')
    refStatus('분석 도구를 확인하는 중…')
    const ready = await api.analyzeReady()
    $('refInstall').classList.toggle('hidden', ready)
    $('refRun').disabled = !ready
    refStatus(ready ? '' : '분석 도구를 먼저 설치해 주세요.')
  }

  $('refClose').onclick = () => {
    api.analyzeCancel()
    api.ytCancel()
    $('ref').classList.add('hidden')
  }

  $('refInstallBtn').onclick = async () => {
    $('refInstallBtn').disabled = true
    refStatus('설치하는 중… 몇 분 걸릴 수 있습니다.')
    const result = await api.analyzeInstall()
    $('refInstallBtn').disabled = false
    if (!result.ok) return showProblem(result.message)
    $('refInstall').classList.add('hidden')
    $('refRun').disabled = false
    refStatus('설치했습니다. 음원 파일을 고르거나 유튜브에서 받으세요.')
  }

  const useFile = (filePath) => {
    refFilePath = filePath
    $('refFileName').textContent = filePath.split(/[\\/]/).pop()
  }

  $('refFile').onclick = async () => {
    const picked = await api.analyzePickFile()
    if (!picked.ok) return
    useFile(picked.path)
  }

  const runAnalysis = async () => {
    if (!refFilePath) return toast('참고할 음원 파일을 먼저 고르세요.')
    setBusy(true)
    $('refResult').classList.add('hidden')
    $('refApply').classList.add('hidden')
    refStatus('시작하는 중…')
    const result = await api.analyzeRun({ file: refFilePath })
    setBusy(false)
    if (!result.ok) {
      refStatus('')
      return showProblem(result.message)
    }
    refStatus('분석을 마쳤습니다.')
    showAnalysis(result.analysis)
  }

  $('refRun').onclick = runAnalysis

  // ── 유튜브 → MP3 ────────────────────────────────────────────────────────────
  const ytStatus = (text) => { $('ytStatus').textContent = text || '' }

  const refreshYtFolder = async () => { $('ytFolder').textContent = await api.ytFolder() }

  $('ytFolderBtn').onclick = async () => {
    const picked = await api.ytPickFolder()
    if (!picked.ok) return
    $('ytFolder').textContent = picked.path
  }

  $('ytGo').onclick = async () => {
    const url = $('ytUrl').value.trim()
    if (!url) return toast('유튜브 주소를 넣으세요.')
    $('ytGo').disabled = true
    $('ytBarWrap').classList.remove('hidden')
    ytStatus('주소를 확인하는 중…')

    const result = await api.ytDownload({ url, dir: $('ytFolder').textContent, bitrate: 320 })

    $('ytGo').disabled = false
    $('ytBarWrap').classList.add('hidden')
    $('ytBar').style.width = '0%'

    if (!result.ok) {
      ytStatus('')
      if (result.message === 'needs-install') {
        $('refInstall').classList.remove('hidden')
        return toast('먼저 분석 도구를 설치해 주세요.')
      }
      return showProblem(result.message)
    }

    ytStatus(`받았습니다: ${result.path}`)
    useFile(result.path)
    if ($('ytThenAnalyze').checked) runAnalysis()
  }

  api.onYtProgress((event) => {
    if (event.type === 'info') {
      const mins = event.seconds ? ` · ${Math.floor(event.seconds / 60)}분 ${event.seconds % 60}초` : ''
      return ytStatus(`${event.title}${mins}`)
    }
    if (event.type === 'progress') {
      $('ytBar').style.width = `${event.percent}%`
      return ytStatus(`${event.note} ${event.percent}%`)
    }
    if (event.type === 'stage' && event.stage === 'convert') {
      ytStatus(event.status === 'start' ? 'MP3로 바꾸는 중…' : 'MP3 변환 완료')
      if (event.status === 'start') $('ytBar').style.width = '100%'
    }
  })

  refreshYtFolder()

  $('refApply').onclick = () => {
    if (!refAnalysis) return
    // 장르·악기·보컬은 사람이 골라야 한다. 잰 값은 뒤에 붙여 준다.
    const existing = $('style').value.trim()
    $('style').value = existing ? `${existing}, ${refAnalysis.prompt}` : refAnalysis.prompt
    if (!$('title').value.trim() && refAnalysis.title) {
      $('title').value = `${refAnalysis.title} 풍`.slice(0, 60)
    }
    $('ref').classList.add('hidden')
    updateHint()
    toast('스타일 칸에 넣었습니다. 장르·악기·보컬을 앞에 덧붙이면 더 좋습니다.', 5000)
  }

  api.onAnalyzeProgress((event) => {
    if (event.type === 'progress') {
      if (event.percent) $('refBar').style.width = `${event.percent}%`
      refStatus(event.note || '')
    } else if (event.type === 'stage') {
      const labels = { download: '음원을 받는 중', decode: '음원을 읽는 중', analyze: '분석하는 중' }
      if (event.status === 'start') refStatus(labels[event.stage] || event.stage)
      if (event.stage === 'download' && event.status === 'done' && event.title) {
        refStatus(`받았습니다: ${event.title}`)
      }
    } else if (event.note) {
      refStatus(event.note)
    }
  })
}

function wireGenerate () {
  const box = $('presets')
  PRESETS.forEach((preset) => {
    const button = document.createElement('button')
    button.textContent = preset.name
    button.onclick = () => {
      $('style').value = preset.style
      for (const other of box.children) other.classList.remove('on')
      button.classList.add('on')
      updateHint()
    }
    box.appendChild(button)
  })

  updateHint = () => {
    const instrumental = $('instrumental').checked
    const lyrics = instrumental ? INSTRUMENTAL_LYRICS : $('lyrics').value
    const guess = estimate(lyrics, { firstRun: !warmed, skipPlan: mode === 'cover' })
    $('generateHint').textContent = `예상 ${mmss(guess.total)}` + (warmed ? '' : ' (첫 곡은 모델 적재가 더 걸립니다)')
  }
  // 구간 태그가 없으면 가사가 악보에 붙을 자리를 모른다. 붙여 넣는 즉시 잡아 준다.
  // 결과는 가사칸에 그대로 써서 사람이 고칠 수 있게 둔다.
  const applyAutoTag = (quiet = false) => {
    const raw = $('lyrics').value
    if (!raw.trim()) return false
    const result = autoTagLyrics(raw)
    if (!result.tagged) {
      if (!quiet) toast(result.note || '이미 구간 태그가 있습니다.')
      return false
    }
    $('lyrics').value = result.text
    updateHint()
    if (!quiet) toast(`구간을 붙였습니다 — ${result.sections.join(' · ')}. ${result.note}`, 6000)
    return true
  }

  $('autoTag').onclick = () => applyAutoTag(false)

  // 붙여 넣기는 브라우저가 값을 채운 뒤에 처리해야 한다.
  $('lyrics').addEventListener('paste', () => setTimeout(() => applyAutoTag(false), 0))

  $('lyrics').oninput = updateHint
  $('instrumental').onchange = () => {
    // 연주곡이면 가사칸을 잠그고, 왜 잠겼는지 보이게 한다.
    $('lyrics').disabled = $('instrumental').checked
    $('lyricsHint').textContent = $('instrumental').checked
      ? '연주곡 모드입니다. 가사 대신 구간 구조만 모델에 넘깁니다.'
      : '[Verse] [Pre-Chorus] [Chorus] [Bridge] 로 구간을 나누면 곡 구조가 좋아집니다.'
    updateHint()
  }
  updateHint()

  $('generate').onclick = async () => {
    const instrumental = $('instrumental').checked
    let payloadStyle = $('style').value.trim()
    if (!payloadStyle) return toast('스타일 프롬프트를 적어주세요.')

    let lyrics = INSTRUMENTAL_LYRICS
    if (!instrumental) {
      // 태그가 없으면 여기서라도 붙인다. 없는 채로 보내면 가사가 악보에 엉뚱하게 붙는다.
      applyAutoTag(true)
      const raw = $('lyrics').value.trim() ||
        (mode === 'cover' && coverScore ? coverScore.lyrics : '')
      if (!raw) return toast('가사를 적거나 [가사 없이]를 켜주세요.')
      const cleaned = cleanLyrics(raw)
      lyrics = cleaned.text
      if (cleaned.notes.length) toast(cleaned.notes.join(' · '), 4000)

      // 태그 안에 적은 악기·보컬 지시는 YuE2 가 읽지 못한다. 버리지 말고
      // 스타일 쪽으로 옮긴다. 거기가 그 말이 실제로 읽히는 자리다.
      const moved = mergeDescriptions(cleaned.descriptions)
      if (moved && !$('style').value.includes(moved)) {
        const keep = await confirmAsk(
          '구간 태그 안에 적으신 지시는 AI 가 읽지 못합니다.\n' +
          '스타일 프롬프트로 옮길까요?\n\n' + moved.slice(0, 300),
          '옮기기')
        if (keep) {
          const existing = $('style').value.trim()
          $('style').value = existing ? `${existing}, ${moved}` : moved
          payloadStyle = $('style').value.trim()
          toast('스타일에 옮겼습니다.', 4000)
        }
      }
    }

    // 커버는 원곡의 악보가 있어야 성립한다.
    if (mode === 'cover' && !(coverScore && coverScore.abc)) {
      return toast('커버할 원곡을 먼저 고르세요.')
    }

    const guess = estimate(lyrics, { firstRun: !warmed, skipPlan: mode === 'cover' })

    // 모델은 노래 토큰을 MAX_SONG_TOKENS 개까지만 만든다. 그 너머는 그냥 잘린다.
    // 만들고 나서 "뒤가 없네" 하는 것보다 미리 말해 주는 편이 낫다.
    if (guess.base.semantic >= MAX_SONG_TOKENS * 0.9) {
      const minutes = Math.round(MAX_SONG_TOKENS / TOKENS_PER_SECOND / 60)
      const go = await confirmAsk(
        `가사가 깁니다. 이 모델은 한 번에 약 ${minutes}분까지만 만들 수 있어서 ` +
        '뒷부분이 잘릴 수 있습니다. 한 절을 덜어내거나, 나눠서 만드는 편이 좋습니다.',
        '그래도 만들기')
      if (!go) return
    }

    const payload = {
      title: $('title').value.trim() || '무제',
      style: instrumental ? instrumentalStyle(payloadStyle) : payloadStyle,
      lyrics,
      instrumental,
      seed: $('seed').value.trim(),
      // 커버: 이 악보를 주면 작곡 단계를 건너뛰고 편곡만 새로 한다.
      abc: mode === 'cover' ? coverScore.abc : null,
      coverOf: mode === 'cover' ? coverScore.title : null,
      // 보정 전 토큰 예측. 끝나고 실제값과 견줘 추정식을 다듬는 데 쓴다.
      predict: guess.base
    }

    const result = await api.generate(payload)
    if (!result.ok) return showProblem(result.message)
    // 대기 중인 곡도 자기 길이에 맞는 추정치를 갖고 있어야 순서가 와도 막대가 맞는다.
    plans.set(result.jobId, guess)
    toast(result.position === 0 ? '곡을 만들기 시작합니다.' : `대기열에 넣었습니다 (${result.position}번째).`)
    await refreshSongs()
  }

  $('cancel').onclick = async () => {
    await api.cancel()
    toast('취소 요청을 보냈습니다. 지금 단계가 끝나면 멈춥니다.', 4000)
  }

  $('queueClear').onclick = async () => {
    const result = await api.queueClear()
    toast(`${result.removed}곡을 대기열에서 뺐습니다.`)
  }
}

function wireJobEvents () {
  api.onQueue((state) => {
    queueState = state
    renderQueue()
  })

  api.onJobStarted(({ jobId, title }) => {
    runningJob = { jobId, title }
    plan = plans.get(jobId) || plan
    setRunning(true, title)
    showProgress('plan', 0, '준비 중…')
    refreshSongs()
  })

  api.onJobEvent((event) => {
    if (event.type === 'notice') return toast(event.message, 5000)

    if (event.type === 'stage' && event.stage === 'load') {
      // 모델 적재는 단계 막대에 없다. 문구로만 알린다.
      if (event.status === 'start') showProgress('plan', 0, '음악 모델을 메모리에 올리는 중… (처음 한 번, 약 1분)')
      else warmed = true
      return
    }
    if (event.type === 'stage' && event.status === 'start') {
      showProgress(event.stage, 0)
      return
    }
    if (event.type === 'stage' && event.status === 'done') {
      showProgress(event.stage, 1)
      return
    }
    if (event.type === 'progress') {
      if (event.stage === 'synth' && event.steps) {
        showProgress('synth', event.step / event.steps)
      } else if (event.stage && plan.tokens[event.stage]) {
        showProgress(event.stage, event.tokens / plan.tokens[event.stage],
          event.rate ? `초당 ${event.rate} 토큰` : undefined)
      }
    }
  })

  api.onJobDone(async (song) => {
    plans.delete(runningJob && runningJob.jobId)
    runningJob = null
    warmed = true
    setRunning(false)

    // 워커는 예전부터 "잘렸다"고 알려 줬는데 화면이 그걸 버리고 있었다.
    // 가사 뒷부분이 사라진 채로 완성했다고만 하니 이유를 알 수 없었다.
    const cut = song.truncated || {}
    if (cut.semantic) {
      showProblem(
        `"${song.title}" 은(는) 만들어졌지만 뒷부분이 잘렸습니다.\n\n` +
        `이 모델은 한 번에 약 ${Math.round(MAX_SONG_TOKENS / TOKENS_PER_SECOND / 60)}분까지만 ` +
        '만들 수 있습니다. 가사가 그보다 길면 남은 대목은 노래로 만들어지지 않습니다.\n\n' +
        '가사를 줄이거나, 절을 나눠 여러 곡으로 만들어 보세요.')
    } else if (cut.abc) {
      toast('악보가 길어 일부가 잘렸습니다. 가사를 줄이면 더 안정적입니다.', 6000)
    }

    toast(`"${song.title}" 완성! (${mmss(song.wallSeconds)})`, 5000)
    // 방금 곡에서 잰 속도를 반영해 다음 예상 시간을 고친다.
    await refreshSettings()
    updateHint()
    await refreshSongs()
    await refreshProjects()
    const made = songs.find((s) => s.dir === song.dir)
    if (made) selectSong(made)
  })

  api.onJobError((event) => {
    plans.delete(runningJob && runningJob.jobId)
    runningJob = null
    setRunning(false)
    refreshSongs()
    if (event.cancelled) return toast('생성을 취소했습니다.')
    showProblem(event.message, event.detail)
  })

  api.onWorkerLog((line) => {
    const box = $('setupLog')
    box.textContent = `${box.textContent}${line}\n`.split('\n').slice(-400).join('\n')
  })
}

function wireProblem () {
  $('problemClose').onclick = () => {
    $('problem').classList.add('hidden')
    document.querySelector('#problem h1').textContent = '곡을 만들지 못했습니다'
  }
  $('problemCopy').onclick = () => {
    const text = `${$('problemText').textContent}\n\n${$('problemDetail').textContent}`.trim()
    navigator.clipboard.writeText(text).then(() => toast('복사했습니다.'))
  }
  $('problemLog').onclick = () => api.openLog()
}

// ── 업데이트 ──────────────────────────────────────────────────────────────────
async function checkUpdate () {
  const found = await api.checkUpdate()
  if (!found) return
  $('updateFrom').textContent = `현재 ${found.current}`
  $('updateTo').textContent = found.version
  const notes = $('updateNotes')
  notes.textContent = found.notes || ''
  notes.classList.toggle('hidden', !found.notes)
  $('update').classList.remove('hidden')

  $('updateLater').onclick = () => $('update').classList.add('hidden')
  $('updateNow').onclick = async () => {
    $('updateNow').disabled = true
    $('updateBarWrap').classList.remove('hidden')
    $('updateStatus').classList.remove('hidden')
    $('updateStatus').textContent = '내려받는 중…'
    const result = await api.installUpdate(found)
    if (result.opened) {
      $('updateStatus').textContent = '브라우저에서 릴리스 페이지를 열었습니다.'
      $('updateNow').disabled = false
      return
    }
    if (!result.ok) {
      $('updateStatus').textContent = `실패: ${result.error}`
      $('updateNow').disabled = false
      return
    }
    $('updateStatus').textContent = '설치를 시작합니다. 프로그램이 곧 닫힙니다…'
  }
  api.onUpdateProgress((ratio) => {
    $('updateBar').style.width = `${Math.round(ratio * 100)}%`
  })
}

// ── 시작 ──────────────────────────────────────────────────────────────────────
async function boot () {
  const state = await api.state()
  $('versionInfo').textContent = `버전 ${state.version}`
  if (state.gpu && state.gpu.ok) {
    $('gpuInfo').textContent = `${state.gpu.name} · ${state.gpu.vramGb}GB`
  }

  if (!state.ready) {
    $('setup').classList.remove('hidden')
    await refreshLocation()
    await refreshPreflight()
    return
  }

  await refreshProjects()
  await refreshSettings()
  await refreshSongs()
  queueState = await api.queue()
  renderQueue()
  if (queueState.current) {
    runningJob = queueState.current
    setRunning(true, queueState.current.title)
  }
  checkUpdate() // 실패해도 앱은 그대로 쓴다 — 기다리지 않는다
}

wireSetup()
wireProjects()
wireLibrary()
wireSettings()
wireGenerate()
wireCover()
wireScore()
wireReference()
wireJobEvents()
wireProblem()
boot().catch((error) => showProblem(`시작하지 못했습니다: ${error.message}`))
