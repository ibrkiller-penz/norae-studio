'use strict'
// 노래공방 — 메인 프로세스.
// 하는 일: 첫 실행 설치, 파이썬 워커 관리, 생성 대기열, 곡 폴더/MP3 관리, 업데이트.
//
// 바깥 세상에 의존하는 곳은 여기가 전부다(모두 원본 배포처를 직접 본다):
//   uv       → github.com/astral-sh/uv
//   PyTorch  → download.pytorch.org
//   YuE2     → github.com/multimodal-art-projection/YuE
//   모델      → huggingface.co
//   업데이트   → 본인 GitHub 릴리스 (updater.js, 기본 꺼짐 아님·없으면 조용히 통과)
// 이 중 어느 하나가 사라져도, 이미 설치된 실행환경을 "가져오기" 하면 계속 돌아간다.
const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron')
const { spawn, execFile } = require('child_process')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const https = require('https')
const os = require('os')
const { pathToFileURL } = require('url')
const updater = require('./updater')
const speed = require('./speed')
const models = require('./models')

const UV_URL = 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip'
const YUE_URL = 'https://github.com/multimodal-art-projection/YuE/archive/refs/tags/yue2-v0.1.6.zip'
const TORCH_INDEX = 'https://download.pytorch.org/whl/cu128'
const TORCH_VERSION = 'torch==2.10.0'
const MODEL_BYTES = 8.4 * 1024 ** 3 // 두 체크포인트 합계 — 다운로드 막대용 추정치

const NEEDED_GB = 20 // 설치에 필요한 여유 공간
const NEEDED_VRAM_GB = 8
// YuE2 는 BF16 으로 돈다. 네이티브로 실행하는 건 Ampere(계산능력 8.0) 이상뿐이다.
// 그 아래 카드에서도 PyTorch 는 bf16 을 "지원"한다고 답하므로(에뮬레이션) 카드를 직접 봐야 한다.
// 안 그러면 11GB 를 다 받고 나서야 못 쓴다는 걸 알게 된다.
const MIN_COMPUTE = 8.0

// 참고곡 분석·유튜브 받기에 쓰는 꾸러미. 설치할 때 같이 받고, 이미 설치한 사람은
// 필요할 때 받는다.
const ANALYZE_PACKAGES = ['librosa==0.11.0', 'yt-dlp>=2025.1.1']
// 채보(음원 → 악보)에는 보컬 분리가 필요하다. 이건 따로 받는다 — torchaudio 는
// PyTorch 쪽 저장소에서 와야 버전이 맞는다.
const TRANSCRIBE_PACKAGES = ['demucs']
const TORCHAUDIO_PACKAGE = 'torchaudio'

let win = null
let worker = null
let currentJob = null
// 곡은 한 번에 하나씩 만든다. 8GB 그래픽카드로 두 곡을 동시에 만들 수는 없다.
const queue = []

// 데이터 폴더 이름을 고정해 둔다. 나중에 제품 이름을 바꿔도 설치된 실행환경이나
// 설정이 미아가 되지 않는다.
app.setPath('userData', path.join(app.getPath('appData'), 'NoraeStudio'))

const userData = () => app.getPath('userData')
// 패키징하면 스크립트가 app.asar 안에 들어가는데 파이썬은 그걸 못 읽는다.
// electron-builder 가 옆에 풀어둔 사본을 가리킨다.
const unpacked = (p) => p.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)

function settingsSync () {
  try { return JSON.parse(fs.readFileSync(path.join(userData(), 'settings.json'), 'utf8')) } catch { return {} }
}

const paths = () => {
  const root = userData()
  const pinned = settingsSync()
  // 실행환경 + 체크포인트가 합쳐서 ~11GB 다. dataDir 로 넉넉한 드라이브에 보낼 수 있다.
  const dataDir = pinned.dataDir || root
  return {
    root,
    dataDir,
    runtime: path.join(dataDir, 'runtime'),
    uv: path.join(dataDir, 'runtime', 'uv.exe'),
    venv: path.join(dataDir, 'runtime', 'venv'),
    python: pinned.pythonPath || path.join(dataDir, 'runtime', 'venv', 'Scripts', 'python.exe'),
    // 데이터 폴더를 따로 골랐으면 모델도 그 옆에, 아니면 표준 허깅페이스 캐시에 둔다
    // (다른 로컬 AI 도구들이 이미 공유하는 자리다).
    hfHome: pinned.hfHome || process.env.HF_HOME ||
      (pinned.dataDir ? path.join(dataDir, 'models')
        : path.join(os.homedir(), '.cache', 'huggingface')),
    settings: path.join(root, 'settings.json'),
    songsPinned: pinned.songsDir || null,
    worker: unpacked(path.join(__dirname, '..', 'python', 'worker.py')),
    setupModels: unpacked(path.join(__dirname, '..', 'python', 'setup_models.py'))
  }
}

const send = (channel, payload) => win && !win.isDestroyed() && win.webContents.send(channel, payload)
const setupLog = (text) => send('setup:log', text)

// 설정 파일 옆에 남는 기록. 남의 컴퓨터에서 문제가 생겼을 때 가장 먼저 볼 곳이다.
function log (...pieces) {
  const line = `[${new Date().toISOString()}] ${pieces.map(
    (p) => typeof p === 'string' ? p : JSON.stringify(p)).join(' ')}\n`
  try {
    fs.mkdirSync(userData(), { recursive: true })
    fs.appendFileSync(path.join(userData(), 'app.log'), line, 'utf8')
  } catch { /* 기록하다가 앱이 죽으면 안 된다 */ }
  process.stdout.write(line)
}

async function readSettings () {
  try { return JSON.parse(await fsp.readFile(paths().settings, 'utf8')) } catch { return {} }
}

async function writeSettings (patch) {
  const next = { ...(await readSettings()), ...patch }
  await fsp.mkdir(userData(), { recursive: true })
  await fsp.writeFile(paths().settings, JSON.stringify(next, null, 1), 'utf8')
  return next
}

// ── 잔심부름 ──────────────────────────────────────────────────────────────────
function run (file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => {
      out += d
      if (options.stream) String(d).split(/\r?\n/).filter(Boolean).forEach(setupLog)
    })
    child.stderr.on('data', (d) => {
      err += d
      if (options.stream) String(d).split(/\r?\n/).filter(Boolean).forEach(setupLog)
    })
    child.on('error', reject)
    child.on('close', (code) => code === 0
      ? resolve(out.trim())
      : reject(new Error(`${path.basename(file)} 종료 코드 ${code}\n${(err || out).slice(-2000)}`)))
  })
}

function download (url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    const get = (link, redirects = 0) => https.get(link, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        if (redirects > 5) return reject(new Error('리다이렉트가 너무 많습니다'))
        res.resume()
        return get(res.headers.location, redirects + 1)
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} — ${link}`))
      const total = Number(res.headers['content-length'] || 0)
      let got = 0
      res.on('data', (chunk) => {
        got += chunk.length
        if (onProgress) onProgress(got, total)
      })
      res.pipe(file)
      file.on('finish', () => file.close(() => resolve(dest)))
    }).on('error', reject)
    get(url)
  })
}

const unzip = (zip, dest) => run('powershell.exe',
  ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`])

async function exists (p) { try { await fsp.access(p); return true } catch { return false } }

function withTimeout (promise, ms) {
  return Promise.race([promise, new Promise((_resolve, reject) =>
    setTimeout(() => reject(new Error(`응답 없음 (${ms}ms 초과)`)), ms))])
}

async function freeSpaceGb (target) {
  try {
    const stat = await fsp.statfs(path.parse(target).root)
    return Math.round(stat.bsize * stat.bavail / 1024 ** 3 * 10) / 10
  } catch {
    return null
  }
}

// ── 곡 폴더와 프로젝트 ────────────────────────────────────────────────────────
// OneDrive 가 물고 있는 문서 폴더는 mkdir 이 실패하는 대신 영원히 멈출 수 있다.
// 후보들을 시간제한을 걸고 찔러 본 뒤, 실제로 써지는 첫 폴더를 기억한다.
let songsDir = null

async function ensureSongsDir () {
  if (songsDir) return songsDir
  const p = paths()
  const candidates = [
    p.songsPinned,
    path.join(app.getPath('documents'), '노래공방'),
    path.join(os.homedir(), 'NoraeStudio', 'Songs'),
    path.join(userData(), 'Songs')
  ].filter(Boolean)
  for (const dir of candidates) {
    const probe = path.join(dir, '.write-test')
    try {
      await withTimeout(fsp.mkdir(probe, { recursive: true }), 4000)
      await withTimeout(fsp.rmdir(probe), 4000)
      songsDir = dir
      if (dir !== p.songsPinned) await writeSettings({ songsDir: dir })
      log('곡 폴더', dir)
      return dir
    } catch (error) {
      log('곡 폴더를 쓸 수 없음', dir, error.message)
    }
  }
  throw new Error('곡을 저장할 폴더를 만들지 못했습니다.')
}

// '#' 와 '%' 는 파일 이름에는 되지만 재생기가 읽는 file:// 주소를 깨뜨린다.
// 폴더 이름에 아예 들어가지 않게 한다.
const slug = (text) => (text || '').replace(/[\\/:*?"<>|#%\r\n]/g, ' ')
  .replace(/\s+/g, ' ').trim().slice(0, 60) || '무제'

// 곡은 <곡폴더>\<프로젝트>\<곡> 에 쌓인다. 한 번에 한 프로젝트가 현재 프로젝트이고,
// 그동안 만든 것은 전부 그 폴더로 들어간다.
const DEFAULT_PROJECT = '기본'
const projectName = () => settingsSync().project || DEFAULT_PROJECT

async function projectDir (name = projectName()) {
  const dir = path.join(await ensureSongsDir(), slug(name))
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

async function listProjects () {
  const root = await ensureSongsDir()
  await projectDir(DEFAULT_PROJECT) // 최소 한 개는 늘 있게 한다
  const names = []
  for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const songs = (await fsp.readdir(path.join(root, entry.name), { withFileTypes: true }))
      .filter((child) => child.isDirectory()).length
    names.push({ name: entry.name, songs })
  }
  return names.sort((a, b) => a.name.localeCompare(b.name, 'ko'))
}

// 프로젝트가 생기기 전에 만든 곡은 곡 폴더 바로 아래에 흩어져 있다. 기본 프로젝트로 모은다.
async function migrateLooseSongs () {
  const root = await ensureSongsDir()
  const home = await projectDir(DEFAULT_PROJECT)
  for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const full = path.join(root, entry.name)
    if (full === home || !await exists(path.join(full, 'meta.json'))) continue
    try {
      await fsp.rename(full, path.join(home, entry.name))
      log('기본 프로젝트로 옮김', entry.name)
    } catch (error) {
      log('프로젝트로 옮기지 못함', entry.name, error.message)
    }
  }
}

// ── 그래픽카드 확인 ───────────────────────────────────────────────────────────
async function detectGpu () {
  try {
    const out = await run('nvidia-smi',
      ['--query-gpu=name,memory.total,compute_cap', '--format=csv,noheader,nounits'])
    const [name, mb, cap] = out.split(/\n/)[0].split(',').map((s) => s.trim())
    const compute = Number(cap)
    return {
      ok: true,
      name,
      vramGb: Math.round(Number(mb) / 1024 * 10) / 10,
      compute: Number.isFinite(compute) ? compute : null,
      bf16: !Number.isFinite(compute) || compute >= MIN_COMPUTE
    }
  } catch {
    return { ok: false, name: null, vramGb: 0, compute: null, bf16: false }
  }
}

// 첫 바이트를 받기 전에 확인한다. 11GB 다 받고 나서 디스크가 꽉 찼다는 걸 아는 건 최악이다.
async function preflight () {
  const p = paths()
  const gpu = await detectGpu()
  // 실행환경과 모델이 다른 드라이브에 있을 수 있다. 더 빡빡한 쪽이 기준이 된다.
  const places = [p.dataDir, p.hfHome]
  const spaces = await Promise.all(places.map(freeSpaceGb))
  const worst = spaces.reduce((low, gb, i) => gb !== null && (low === -1 || gb < spaces[low]) ? i : low, -1)
  const drive = path.parse(places[worst === -1 ? 0 : worst]).root
  const freeGb = worst === -1 ? null : spaces[worst]
  const problems = []
  const warnings = []

  if (!gpu.ok) {
    problems.push('NVIDIA 그래픽카드를 찾지 못했습니다. 이 프로그램은 NVIDIA 그래픽카드에서만 작동합니다.')
  } else if (!gpu.bf16) {
    problems.push(`${gpu.name}는 이 프로그램이 쓰는 BF16 연산을 지원하지 않습니다. ` +
      'RTX 30 시리즈 이상(3050·3060·4060·5060 등)이 필요합니다. ' +
      'GTX 10/16 시리즈와 RTX 20 시리즈에서는 작동하지 않습니다.')
  } else if (gpu.vramGb < NEEDED_VRAM_GB - 0.5) {
    warnings.push(`그래픽카드 메모리가 ${gpu.vramGb}GB입니다. 권장은 ${NEEDED_VRAM_GB}GB 이상이라 ` +
      '곡 생성이 매우 느리거나 실패할 수 있습니다.')
  }
  if (freeGb !== null && freeGb < NEEDED_GB) {
    problems.push(`${drive} 드라이브 여유 공간이 ${freeGb}GB입니다. 설치에 ${NEEDED_GB}GB가 필요합니다.`)
  }

  // 이미 쓸 수 있는 실행환경이 컴퓨터에 있으면, 11GB 를 다시 받을 필요가 없다고 알려준다.
  const adoptable = await findExistingRuntime()
  log('사전점검', { gpu, drive, freeGb, problems, warnings, adoptable })
  return { ok: problems.length === 0, gpu, drive, freeGb, needGb: NEEDED_GB, problems, warnings, adoptable }
}

// ── 이미 설치된 실행환경 가져오기 ─────────────────────────────────────────────
// 인터넷이 끊겼거나 원본 배포처가 사라져도, 같은 부품이 이 컴퓨터에 이미 있으면 그걸 쓴다.
function runtimeCandidates () {
  const appData = app.getPath('appData')
  return [
    paths().python,
    path.join(appData, 'ssokMusic', 'runtime', 'venv', 'Scripts', 'python.exe'),
    path.join(appData, 'yue-studio', 'runtime', 'venv', 'Scripts', 'python.exe'),
    path.join(os.homedir(), 'NoraeStudio', 'runtime', 'venv', 'Scripts', 'python.exe')
  ]
}

// 인터프리터가 실제로 돌아가고, 필요한 꾸러미가 다 있는지 직접 물어본다.
async function probeRuntime (python) {
  if (!await exists(python)) return null
  try {
    const report = await withTimeout(run(python, ['-c',
      'import json,torch,yue2,soundfile;' +
      'print(json.dumps({"torch":torch.__version__,"cuda":torch.cuda.is_available()}))']), 90000)
    const info = JSON.parse(report.split(/\r?\n/).pop())
    return { python, ...info }
  } catch {
    return null
  }
}

async function findExistingRuntime () {
  for (const python of runtimeCandidates()) {
    const found = await probeRuntime(python)
    if (found && found.cuda) return found
  }
  return null
}

// 모델 가중치가 이미 받아져 있는지 (허깅페이스 캐시 안에 두 저장소가 있는지) 본다.
async function modelsPresent (hfHome) {
  const hub = path.join(hfHome, 'hub')
  const needed = ['models--m-a-p--YuE2-3B', 'models--m-a-p--YuE2-Vae']
  for (const name of needed) if (!await exists(path.join(hub, name))) return false
  return true
}

async function adoptRuntime () {
  const found = await findExistingRuntime()
  if (!found) {
    return { ok: false, message: '이 컴퓨터에서 쓸 수 있는 AI 실행환경을 찾지 못했습니다. 설치를 진행해 주세요.' }
  }
  const p = paths()
  if (!await modelsPresent(p.hfHome)) {
    return {
      ok: false,
      message: `실행환경은 찾았지만(${found.python}) 음악 모델이 없습니다.\n` +
        `모델 위치: ${p.hfHome}\n설치를 진행하면 모델만 내려받습니다.`
    }
  }
  const ffmpeg = await findFfmpeg(found.python)
  const gpu = await detectGpu()
  await writeSettings({ setupDone: true, pythonPath: found.python, ffmpeg, gpu, adoptedAt: new Date().toISOString() })
  log('실행환경 가져옴', found.python, found.torch)
  return { ok: true, python: found.python, torch: found.torch, gpu }
}

async function findFfmpeg (python) {
  try {
    return await run(python, ['-c',
      'import imageio_ffmpeg,sys;sys.stdout.write(imageio_ffmpeg.get_ffmpeg_exe())'])
  } catch {
    return null // MP3 변환만 못 쓰고 WAV 로는 잘 돌아간다
  }
}

// ── 첫 실행 설치 ──────────────────────────────────────────────────────────────
function uvEnv () {
  return { ...process.env, UV_PYTHON_INSTALL_DIR: path.join(paths().runtime, 'python'), UV_NO_PROGRESS: '1' }
}

// uv 는 `python install` 끝에 부(副)버전 링크 폴더를 만드는데, 인터프리터 자체는 멀쩡히
// 풀렸어도 그 단계가 실패하는 윈도우 환경이 있다. 완전한 "cpython-3.12.14-..." 폴더를
// 우선으로 고르고, 실제로 실행되는지 확인한 뒤에 쓴다.
async function findManagedPython (dir) {
  let entries = []
  try { entries = await fsp.readdir(dir) } catch { return null }
  const candidates = entries
    .filter((name) => /^cpython-3\.12/.test(name))
    .sort((a, b) => (/^cpython-3\.12\.\d/.test(b) ? 1 : 0) - (/^cpython-3\.12\.\d/.test(a) ? 1 : 0))
  for (const name of candidates) {
    const exe = path.join(dir, name, 'python.exe')
    if (!await exists(exe)) continue
    try {
      await run(exe, ['-c', 'pass'])
      return exe
    } catch { /* 깨진 링크 폴더 — 다음 후보로 */ }
  }
  return null
}

async function runSetup () {
  const p = paths()
  const check = await preflight()
  if (!check.ok) throw new Error(check.problems.join('\n'))
  const gpu = check.gpu
  send('setup:step', { step: 'gpu', status: 'done', detail: `${gpu.name} (${gpu.vramGb}GB)` })

  await fsp.mkdir(p.runtime, { recursive: true })
  await fsp.mkdir(p.hfHome, { recursive: true })

  // 1. uv — 독립 실행되는 파이썬/꾸러미 관리자
  if (!await exists(p.uv)) {
    send('setup:step', { step: 'uv', status: 'run' })
    const zip = path.join(os.tmpdir(), 'uv.zip')
    await download(UV_URL, zip, (got, total) => send('setup:progress', { step: 'uv', got, total }))
    await unzip(zip, p.runtime)
    await fsp.unlink(zip).catch(() => {})
  }
  send('setup:step', { step: 'uv', status: 'done' })

  // 2. 파이썬 3.12 가상환경
  if (!await exists(p.python)) {
    send('setup:step', { step: 'venv', status: 'run' })
    try {
      await run(p.uv, ['python', 'install', '3.12'], { stream: true, env: uvEnv() })
    } catch (error) {
      setupLog(`파이썬 설치 경고: ${error.message.split('\n')[0]}`)
    }
    const python = await findManagedPython(path.join(p.runtime, 'python'))
    if (!python) throw new Error('파이썬 설치에 실패했습니다. 인터넷 연결을 확인한 뒤 다시 시도해주세요.')
    await run(p.uv, ['venv', '--python', python, p.venv], { stream: true, env: uvEnv() })
  }
  send('setup:step', { step: 'venv', status: 'done' })

  // 3. PyTorch (CUDA) — 제일 큰 놈, 약 3GB
  send('setup:step', { step: 'torch', status: 'run' })
  await run(p.uv, ['pip', 'install', '--python', p.python, TORCH_VERSION,
    '--index-url', TORCH_INDEX], { stream: true, env: uvEnv() })
  send('setup:step', { step: 'torch', status: 'done' })

  // 4. YuE2 와 곁다리들
  send('setup:step', { step: 'yue', status: 'run' })
  await run(p.uv, ['pip', 'install', '--python', p.python, YUE_URL,
    'imageio-ffmpeg==0.6.0', ...ANALYZE_PACKAGES], { stream: true, env: uvEnv() })
  send('setup:step', { step: 'yue', status: 'done' })

  // 5. 모델 가중치
  send('setup:step', { step: 'models', status: 'run' })
  await new Promise((resolve, reject) => {
    const child = spawn(p.python, ['-u', p.setupModels], {
      env: { ...process.env, HF_HOME: p.hfHome, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      windowsHide: true
    })
    let err = ''
    child.stdout.on('data', (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((line) => {
      try {
        const event = JSON.parse(line)
        if (event.type === 'progress') {
          send('setup:progress', { step: 'models', got: event.bytes, total: MODEL_BYTES })
        } else if (event.type === 'error') {
          err += event.message
        }
      } catch { setupLog(line) }
    }))
    child.stderr.on('data', (d) => { err += d })
    child.on('error', reject)
    child.on('close', (code) => code === 0
      ? resolve()
      : reject(new Error(err.slice(-2000) || `모델 다운로드 실패 (${code})`)))
  })
  send('setup:step', { step: 'models', status: 'done' })

  // 6. 엔진이 여기서 실제로 켜지는지 증명한다. Visual C++ 재배포 패키지가 없다거나
  //    설치가 깨졌다는 건, 안 그러면 사용자가 첫 곡을 만들 때에야 드러난다.
  send('setup:step', { step: 'verify', status: 'run' })
  try {
    const report = await run(p.python, ['-c',
      'import torch, yue2, soundfile; print("cuda", torch.cuda.is_available())'])
    log('엔진 점검', report)
    if (!/cuda True/.test(report)) {
      throw new Error('그래픽카드를 인식하지 못했습니다. NVIDIA 드라이버를 최신으로 올린 뒤 다시 시도해 주세요.')
    }
  } catch (error) {
    throw new Error(`AI 엔진 점검에 실패했습니다.\n\n${explainCrash(String(error.message).split('\n'))}`)
  }
  send('setup:step', { step: 'verify', status: 'done' })

  // 7. imageio-ffmpeg 가 같이 가져온 ffmpeg 위치를 기억해 둔다
  const ffmpeg = await findFfmpeg(p.python)

  await writeSettings({ setupDone: true, gpu, ffmpeg, installedAt: new Date().toISOString() })
  return { ok: true, gpu }
}

// ── 파이썬 워커 ───────────────────────────────────────────────────────────────
let stderrTail = []
// 워커가 마지막으로 뭔가 말한 시각. 너무 오래 조용하면 굳은 것으로 보고 알린다.
let lastWorkerEvent = 0
let silenceTimer = null
const SILENCE_WARNING_SECONDS = 240

// 워커는 자기 사정을 보고하기도 전에 죽는다. 마지막으로 남긴 말을 읽어서
// 아는 것들은 사용자가 손쓸 수 있는 말로 바꿔준다.
const CRASH_HINTS = [
  [/WinError 126|fbgemm|shm\.dll|libomp|DLL load failed/i,
    'AI 엔진에 필요한 Microsoft Visual C++ 재배포 패키지가 없습니다.\n' +
    'microsoft.com 에서 "Visual C++ 재배포 가능 패키지 x64"를 설치한 뒤 다시 시도해 주세요.'],
  [/No such file|not found in the local cache|local_files_only|snapshot/i,
    '음악 모델 파일을 찾지 못했습니다. 저장 위치가 바뀌었거나 파일이 지워졌을 수 있습니다.\n' +
    '설정에서 "모델 위치 옮기기"로 확인하거나, 설치를 다시 실행하면 모델을 새로 받습니다.'],
  [/out of memory|OutOfMemoryError/i,
    '그래픽카드 메모리가 모자랍니다.\n' +
    '게임·영상편집·다른 AI 프로그램을 닫고 다시 시도해 주세요. ' +
    '브라우저 탭이 많아도 그래픽카드 메모리를 씁니다.'],
  [/CUDA (error|driver)|nvidia-smi|no kernel image/i,
    '그래픽카드 드라이버 문제로 보입니다. NVIDIA 드라이버를 최신으로 올린 뒤 다시 시도해 주세요.\n' +
    '다른 프로그램(게임·영상편집·다른 AI 도구)이 그래픽카드 메모리를 쓰고 있다면 먼저 종료해 주세요.'],
  [/MemoryError|paging file|cannot allocate|std::bad_alloc/i,
    '메모리(RAM)가 부족합니다. 이 프로그램은 16GB 이상을 권장합니다.\n' +
    '다른 프로그램을 닫거나 윈도우 가상 메모리를 늘린 뒤 다시 시도해 주세요.'],
  [/ModuleNotFoundError|ImportError/i,
    'AI 엔진 설치가 온전하지 않습니다. 설치를 다시 실행해 주세요.']
]

function explainCrash (lines) {
  const text = lines.join('\n')
  for (const [pattern, hint] of CRASH_HINTS) if (pattern.test(text)) return hint
  const last = lines.filter((line) => !/warning/i.test(line)).slice(-2).join('\n')
  return last
    ? `엔진이 남긴 메시지:\n${last}`
    : '원인을 알 수 없습니다. 설정 폴더의 app.log 파일을 확인해 주세요.'
}

function startWorker () {
  if (worker) return worker
  stderrTail = []
  const p = paths()
  log('워커 시작', p.python, p.worker)
  worker = spawn(p.python, ['-u', p.worker], {
    env: { ...process.env, HF_HOME: p.hfHome, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    windowsHide: true
  })

  let buffer = ''
  worker.stdout.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() // 마지막 조각은 아직 안 끝난 줄이다
    for (const line of lines) {
      if (!line.trim()) continue
      try { handleWorkerEvent(JSON.parse(line)) } catch { send('worker:log', line) }
    }
  })

  worker.stderr.on('data', (d) => {
    const text = String(d).trim()
    log('워커 stderr', text)
    send('worker:log', text)
    // 꼬리를 남겨둬야 죽었을 때 "code 1" 대신 진짜 이유를 말해줄 수 있다.
    stderrTail.push(...text.split(/\r?\n/).filter(Boolean))
    stderrTail = stderrTail.slice(-12)
  })

  worker.on('error', (error) => {
    log('워커 실행 실패', error.message)
    if (currentJob) {
      send('job:error', { jobId: currentJob.jobId, message: `생성 엔진을 시작하지 못했습니다: ${error.message}` })
    }
    currentJob = null
    worker = null
  })

  // 워커가 살아는 있는데 아무 말도 없이 굳는 일이 있었다(scipy 의 DLL 이 torch 와
  // 부딪혀 윈도우 로더에서 멈췄다). 그때는 진행 막대만 그대로 멈춰 있어서 사용자는
  // 기다려야 하는 건지 죽은 건지 알 수 없다. 오래 조용하면 알려 준다.
  clearInterval(silenceTimer)
  silenceTimer = setInterval(() => {
    if (!currentJob || !lastWorkerEvent) return
    const quiet = Math.round((Date.now() - lastWorkerEvent) / 1000)
    if (quiet < SILENCE_WARNING_SECONDS || currentJob.warnedAt === lastWorkerEvent) return
    currentJob.warnedAt = lastWorkerEvent
    log('워커 무응답', `${quiet}초`)
    send('job:event', {
      type: 'notice',
      message: `${Math.round(quiet / 60)}분째 진행이 없습니다. 멈춘 것일 수 있습니다.\n` +
        '[취소] 를 누르고 다시 시도해 보세요. 만들던 단계는 저장되어 있어 이어서 만들 수 있습니다.'
    })
  }, 30000)

  worker.on('close', (code) => {
    clearInterval(silenceTimer)
    log('워커 종료', code, stderrTail.join(' | '))
    if (currentJob) {
      send('job:error', {
        jobId: currentJob.jobId,
        message: `생성 엔진이 종료되었습니다 (code ${code}).\n\n${explainCrash(stderrTail)}`,
        detail: stderrTail.join('\n')
      })
      currentJob = null
    }
    worker = null
    sendQueue()
    pump() // 하나가 죽었다고 뒤에 기다리는 곡들까지 멈추면 안 된다
  })

  return worker
}

let lastProgressLog = 0

// ── 속도 학습 ─────────────────────────────────────────────────────────────────
// 재는 일과 섞는 일은 electron/speed.js 가 한다(따로 돌려볼 수 있게 분리했다).
// 여기서는 이벤트를 넘겨주고, 곡이 끝나면 결과를 settings.json 에 적는 것만 맡는다.
const meter = new speed.Meter()

async function learnSpeed (predict) {
  const settings = await readSettings()
  const next = speed.blend(settings.speed, meter, predict)
  await writeSettings({ speed: next })
  log('속도 학습', next)
}

async function handleWorkerEvent (event) {
  lastWorkerEvent = Date.now()
  if (event.type === 'progress' && Date.now() - lastProgressLog > 30000) {
    lastProgressLog = Date.now()
    log('진행', event)
  } else if (event.type === 'stage' || event.type === 'notice') {
    log(event.type, event.stage || '', event.status || event.message || '')
  }

  meter.track(event)

  // 악보는 커버를 만들 때 다시 쓴다. 완성 뒤 plan/ 폴더는 정리되므로 여기서 붙잡아
  // meta.json 에 글로 남긴다(몇 KB 짜리 텍스트다).
  if (event.type === 'stage' && event.stage === 'plan' && event.status === 'done' &&
      event.abc && currentJob) {
    currentJob.abc = event.abc
  }

  if (event.type === 'done') {
    await learnSpeed(currentJob && currentJob.predict)
    const song = await saveSong(event, currentJob)
    currentJob = null
    send('job:done', song)
    sendQueue()
    pump()
  } else if (event.type === 'error') {
    const failed = currentJob
    currentJob = null
    if (failed) await discardPartial(failed.outDir)
    send('job:error', event)
    sendQueue()
    pump()
  } else {
    send('job:event', event)
  }
}

// ── 만들다 만 곡 ──────────────────────────────────────────────────────────────
// 취소하거나 실패하면 폴더가 남는다. 빈 껍데기만 버린다. 악보나 노래 토큰이 이미 있는
// 폴더는 진짜 GPU 시간이 들어간 결과라서, 나중에 이어서 만들 수 있게 둔다.
async function resumable (dir) {
  return await exists(path.join(dir, 'semantic.npy')) ||
    await exists(path.join(dir, 'plan', 'plan_manifest.json'))
}

async function discardPartial (dir) {
  if (!dir || !dir.startsWith(await ensureSongsDir())) return
  if (await exists(path.join(dir, 'audio.wav')) ||
      await exists(path.join(dir, 'song.mp3')) ||
      await resumable(dir)) return
  try {
    await fsp.rm(dir, { recursive: true, force: true })
    log('빈 곡 폴더 삭제', dir)
  } catch (error) {
    log('빈 곡 폴더를 지우지 못함', dir, error.message)
  }
}

async function sweepPartials () {
  try {
    for (const project of await listProjects()) {
      const dir = await projectDir(project.name)
      for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const full = path.join(dir, entry.name)
        if (currentJob && currentJob.outDir === full) continue
        await discardPartial(full)
      }
    }
  } catch (error) {
    log('정리 건너뜀', error.message)
  }
}

// ── 곡 보관함 ─────────────────────────────────────────────────────────────────
// 48kHz 24비트 WAV 는 1분에 ~17MB 라 보관함이 금방 디스크를 채운다.
// 320kbps MP3 는 대략 10분의 1이고 귀로는 차이를 못 느낀다.
async function encodeMp3 (dir) {
  const settings = await readSettings()
  const wav = path.join(dir, 'audio.wav')
  const mp3 = path.join(dir, 'song.mp3')
  if (!settings.ffmpeg || !await exists(wav)) return null
  await new Promise((resolve, reject) => execFile(settings.ffmpeg,
    ['-y', '-i', wav, '-b:a', '320k', mp3],
    (error) => error ? reject(error) : resolve()))
  return mp3
}

// 곡이 완성되면 오디오와 meta.json 말고는 쓸모가 없다. 중간 단계 파일은 끊긴 곡을
// 이어 만들려고 두는 것이라, 끝난 뒤에는 폴더만 어지럽힌다(latent.npy 만 ~2MB).
const LEFTOVERS = ['semantic.npy', 'latent.npy', 'result.json']

async function folderSize (dir) {
  let total = 0
  for (const entry of await fsp.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    try { total += (await fsp.stat(path.join(entry.parentPath || entry.path, entry.name))).size } catch {}
  }
  return total
}

async function tidySong (dir) {
  try {
    for (const name of LEFTOVERS) await fsp.rm(path.join(dir, name), { force: true })
    await fsp.rm(path.join(dir, 'plan'), { recursive: true, force: true })
    // meta.json 은 숨김으로 돌려서 폴더에 음악만 보이게 한다.
    const meta = path.join(dir, 'meta.json')
    if (await exists(meta)) {
      await new Promise((resolve) => execFile('attrib', ['+h', meta], () => resolve()))
    }
  } catch (error) {
    log('정리 건너뜀', dir, error.message)
  }
}

async function autoConvert (dir) {
  const settings = await readSettings()
  if (!settings.autoMp3) return {}
  try {
    const mp3 = await encodeMp3(dir)
    if (!mp3) return {}
    if (settings.dropWav) {
      await fsp.rm(path.join(dir, 'audio.wav'), { force: true })
      // 잠재벡터는 같은 테이크를 다시 디코딩할 때만 쓴다. 같이 버린다.
      await fsp.rm(path.join(dir, 'latent.npy'), { force: true })
    }
    log('MP3 저장', mp3, settings.dropWav ? '(WAV 삭제)' : '')
    return { mp3 }
  } catch (error) {
    log('MP3 변환 실패', error.message)
    send('job:event', { type: 'notice', message: `MP3 변환에 실패했습니다: ${error.message}` })
    return {}
  }
}

async function saveSong (event, job) {
  const dir = path.dirname(event.audio)
  // 워커는 사용자가 입력한 제목을 모른 채 meta 를 다시 쓴다.
  // 작업을 시작할 때 이 프로세스가 적어둔 자리표시자를 위에 덮어 되살린다.
  let placeholder = {}
  try { placeholder = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8')) } catch {}
  const { mp3 } = await autoConvert(dir)
  const audio = mp3 && !await exists(event.audio) ? mp3 : event.audio
  const meta = {
    ...event.meta,
    dir,
    audio,
    mp3: mp3 || null,
    status: 'done',
    audioUrl: pathToFileURL(audio).href,
    title: placeholder.title || event.meta.title || event.meta.id,
    // 이 곡의 악보. 이게 있어야 나중에 다른 장르로 커버를 만들 수 있다.
    abc: (job && job.abc) || placeholder.abc || null,
    // 어느 곡을 커버한 것인지 (원곡 폴더 이름)
    coverOf: placeholder.coverOf || null
  }
  await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 1), 'utf8')
  await tidySong(dir)
  return meta
}

async function listSongs () {
  await migrateLooseSongs()
  const dir = await projectDir()
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  const songs = []
  for (const entry of entries.filter((e) => e.isDirectory())) {
    const songDir = path.join(dir, entry.name)
    const metaFile = path.join(songDir, 'meta.json')
    const wav = path.join(songDir, 'audio.wav')
    const mp3 = path.join(songDir, 'song.mp3')
    if (!await exists(metaFile)) continue
    const audio = await exists(wav) ? wav : await exists(mp3) ? mp3 : null
    if (!audio && !await resumable(songDir)) continue
    try {
      const { abc, ...meta } = JSON.parse(await fsp.readFile(metaFile, 'utf8'))
      // 주소는 여기서 만든다. '#' 이나 공백, 한글이 든 경로는 인코딩하기 전에는
      // 올바른 file:// 주소가 아니고, <audio> 태그는 주소를 요구한다.
      songs.push({
        ...meta,
        // 악보 본문은 목록에 싣지 않는다(곡당 수 KB). 커버를 누를 때만 따로 가져온다.
        canCover: Boolean(abc),
        dir: songDir,
        audio,
        folder: entry.name,
        unfinished: !audio,
        format: audio === mp3 ? 'mp3' : 'wav',
        audioUrl: audio ? pathToFileURL(audio).href : null
      })
    } catch { /* 읽을 수 없는 항목은 건너뛴다 */ }
  }
  return songs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

// ── 대기열 ────────────────────────────────────────────────────────────────────
function queueState () {
  return {
    current: currentJob ? { jobId: currentJob.jobId, title: currentJob.title } : null,
    waiting: queue.map(({ jobId, title }) => ({ jobId, title }))
  }
}

const sendQueue = () => send('queue:update', queueState())

// 기다리는 다음 곡을 워커에 넘긴다. 대기열이 바뀌거나 곡이 끝날 때마다 불러서,
// 사용자가 지켜보지 않아도 대기열이 알아서 비워지게 한다.
function pump () {
  if (currentJob || !queue.length) return
  currentJob = queue.shift()
  // 워커가 첫 신호조차 못 보내고 굳는 경우도 있다. 여기서 시계를 걸어 둬야
  // 그 경우에도 "무응답" 경고가 뜬다.
  lastWorkerEvent = Date.now()
  meter.reset() // 이 곡이 얼마나 걸리는지 재기 시작한다
  startWorker()
  worker.stdin.write(JSON.stringify(currentJob.job) + '\n')
  log('작업 시작', { jobId: currentJob.jobId, title: currentJob.title })
  send('job:started', { jobId: currentJob.jobId, title: currentJob.title })
  sendQueue()
}

async function startGeneration (payload) {
  const p = paths()
  log('생성 요청', { title: payload.title, seed: payload.seed, python: p.python })
  if (!await exists(p.python)) {
    return { ok: false, message: '실행 환경을 찾지 못했습니다. 설치를 다시 실행해 주세요.' }
  }
  // 이어 만들기는 기존 폴더를 그대로 쓴다. 워커가 거기 있는 단계 파일을 집어서
  // 다시 계산하지 않고 이어간다.
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const outDir = payload.outDir || path.join(await projectDir(), `${stamp}_${slug(payload.title)}`)
  await fsp.mkdir(outDir, { recursive: true })

  const jobId = `${Date.now()}`
  const job = {
    cmd: 'generate',
    jobId,
    outDir,
    id: 'song',
    style: payload.style,
    lyrics: payload.lyrics,
    instrumental: Boolean(payload.instrumental),
    // 커버: 원곡의 악보를 그대로 넘기면 작곡 단계를 건너뛰고 편곡만 새로 한다.
    abc: payload.abc || null,
    cot: payload.cot || 'full',
    // 시드를 워커가 아니라 여기서 못 박는다. 그래야 meta.json 에 남고,
    // 이어 만들 때 저장된 단계들과 같은 시드를 계속 쓴다.
    seed: payload.seed === '' || payload.seed == null
      ? Math.floor(Math.random() * 2 ** 31)
      : Number(payload.seed)
  }
  const title = payload.title || '무제'
  await fsp.writeFile(path.join(outDir, 'meta.json'),
    JSON.stringify({ title, ...job, coverOf: payload.coverOf || null, status: 'queued' }, null, 1), 'utf8')

  // 화면이 보낸 "보정 전" 토큰 예측. 끝나고 실제값과 견줘 추정식을 다듬는 데만 쓴다.
  queue.push({ jobId, outDir, title, job, predict: payload.predict || null, abc: job.abc })
  log('작업 대기열 추가', { jobId, title, waiting: queue.length })
  sendQueue()
  pump()
  return { ok: true, jobId, position: currentJob && currentJob.jobId === jobId ? 0 : queue.length }
}

// ── IPC ───────────────────────────────────────────────────────────────────────
ipcMain.handle('app:state', async () => {
  const settings = await readSettings()
  const p = paths()
  const ready = Boolean(settings.setupDone) && await exists(p.python)
  // 폴더 단추는 보관함 전체가 아니라 지금 작업 중인 프로젝트를 연다.
  const dir = ready ? await projectDir().catch(() => null) : null
  return { ready, gpu: settings.gpu || await detectGpu(), songsDir: dir, version: app.getVersion() }
})

ipcMain.handle('setup:check', () => preflight())

ipcMain.handle('setup:location', async () => {
  const p = paths()
  return {
    dataDir: p.dataDir,
    models: p.hfHome,
    freeGb: await freeSpaceGb(p.dataDir),
    chosen: Boolean(settingsSync().dataDir)
  }
})

// 아무것도 받기 전이라면 11GB 전부를 다른 드라이브로 보낼 수 있다.
ipcMain.handle('setup:pick-location', async () => {
  const picked = await dialog.showOpenDialog(win, {
    title: 'AI 실행환경과 모델을 저장할 폴더',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '이 폴더 사용'
  })
  if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true }
  const chosen = path.join(picked.filePaths[0], 'NoraeStudio')
  const freeGb = await freeSpaceGb(chosen)
  if (freeGb !== null && freeGb < NEEDED_GB) {
    return { ok: false, message: `${path.parse(chosen).root} 여유 공간이 ${freeGb}GB입니다. ${NEEDED_GB}GB가 필요합니다.` }
  }
  try {
    await fsp.mkdir(chosen, { recursive: true })
  } catch (error) {
    return { ok: false, message: `그 폴더를 쓸 수 없습니다: ${error.message}` }
  }
  // 손으로 따로 지정하지 않았다면 모델 위치는 데이터 폴더를 따라간다.
  await writeSettings({ dataDir: chosen, hfHome: path.join(chosen, 'models') })
  log('데이터 폴더', chosen, `${freeGb}GB 여유`)
  return { ok: true, dataDir: chosen, freeGb }
})

ipcMain.handle('setup:adopt-runtime', () => adoptRuntime())

ipcMain.handle('setup:run', async () => {
  try { return await runSetup() } catch (error) { return { ok: false, message: error.message } }
})

ipcMain.handle('projects:list', async () => ({
  current: projectName(), projects: await listProjects()
}))

ipcMain.handle('projects:select', async (_e, name) => {
  await projectDir(name)
  await writeSettings({ project: name })
  log('프로젝트', name)
  return { ok: true, current: name }
})

ipcMain.handle('projects:create', async (_e, name) => {
  const clean = slug(name)
  const existing = await listProjects()
  if (existing.some((p) => p.name === clean)) return { ok: false, message: '같은 이름의 프로젝트가 있습니다.' }
  await projectDir(clean)
  await writeSettings({ project: clean })
  log('프로젝트 만듦', clean)
  return { ok: true, current: clean }
})

ipcMain.handle('projects:rename', async (_e, { from, to }) => {
  const clean = slug(to)
  const root = await ensureSongsDir()
  if (clean === from) return { ok: true, current: clean }
  if (await exists(path.join(root, clean))) return { ok: false, message: '같은 이름의 프로젝트가 있습니다.' }
  try {
    await fsp.rename(path.join(root, from), path.join(root, clean))
  } catch (error) {
    return { ok: false, message: `이름을 바꾸지 못했습니다: ${error.message}` }
  }
  if (projectName() === from) await writeSettings({ project: clean })
  return { ok: true, current: projectName() }
})

// 프로젝트는 휴지통으로 보낸다. 곡이 통째로 들어 있으므로 되돌릴 길을 남겨둔다.
ipcMain.handle('projects:delete', async (_e, name) => {
  if (currentJob || queue.length) return { ok: false, message: '곡을 만드는 중에는 지울 수 없습니다.' }
  const all = await listProjects()
  if (all.length <= 1) return { ok: false, message: '마지막 프로젝트는 지울 수 없습니다.' }
  const root = await ensureSongsDir()
  const target = path.join(root, name)
  if (!target.startsWith(root)) return { ok: false, message: '알 수 없는 폴더입니다.' }
  try {
    await shell.trashItem(target)
  } catch (first) {
    // 곡 삭제와 같은 이유로 실패한다 — 누군가 폴더 안의 파일을 붙잡고 있다.
    await new Promise((resolve) => setTimeout(resolve, 700))
    try {
      await shell.trashItem(target)
    } catch (second) {
      log('프로젝트 삭제 실패', name, second.message)
      return {
        ok: false,
        message: '지우지 못했습니다. 다른 프로그램이 이 폴더의 파일을 쓰고 있을 수 있습니다.\n' +
          '재생을 멈추고 탐색기에서 그 폴더를 닫은 뒤 다시 시도해 주세요.'
      }
    }
  }
  if (projectName() === name) {
    const left = (await listProjects())[0]
    await writeSettings({ project: left ? left.name : DEFAULT_PROJECT })
  }
  log('프로젝트 삭제', name)
  return { ok: true, current: projectName() }
})

ipcMain.handle('songs:list', async () => {
  await sweepPartials()
  return listSongs()
})

ipcMain.handle('song:generate', async (_e, payload) => {
  try {
    return await startGeneration(payload)
  } catch (error) {
    currentJob = null
    log('생성 실패', error.stack || error.message)
    return { ok: false, message: `생성을 시작하지 못했습니다: ${error.message}` }
  }
})

ipcMain.handle('song:resume', async (_e, dir) => {
  try {
    if (!dir.startsWith(await ensureSongsDir())) return { ok: false, message: '알 수 없는 폴더입니다.' }
    const meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'))
    if (!meta.lyrics || !meta.style) {
      return { ok: false, message: '이 곡의 정보가 남아 있지 않아 이어서 만들 수 없습니다.' }
    }
    return await startGeneration({ ...meta, outDir: dir })
  } catch (error) {
    log('이어 만들기 실패', error.stack || error.message)
    return { ok: false, message: `이어서 만들지 못했습니다: ${error.message}` }
  }
})

ipcMain.handle('song:cancel', () => {
  if (worker && currentJob) worker.stdin.write(JSON.stringify({ cmd: 'cancel' }) + '\n')
  return { ok: true }
})

ipcMain.handle('queue:list', () => queueState())

ipcMain.handle('queue:remove', async (_e, jobId) => {
  const index = queue.findIndex((item) => item.jobId === jobId)
  if (index < 0) return { ok: false, message: '이미 시작했거나 없는 곡입니다.' }
  const [removed] = queue.splice(index, 1)
  await discardPartial(removed.outDir)
  log('대기열에서 제거', removed.title)
  sendQueue()
  return { ok: true }
})

ipcMain.handle('queue:clear', async () => {
  const removed = queue.splice(0, queue.length)
  for (const item of removed) await discardPartial(item.outDir)
  log('대기열 비움', removed.length)
  sendQueue()
  return { ok: true, removed: removed.length }
})

ipcMain.handle('song:delete', async (_e, dir) => {
  if (!dir || !dir.startsWith(await ensureSongsDir())) {
    return { ok: false, message: '알 수 없는 폴더입니다.' }
  }
  if (currentJob && currentJob.outDir === dir) {
    return { ok: false, message: '지금 만들고 있는 곡입니다. 먼저 취소해 주세요.' }
  }

  // 휴지통으로 보내는 게 실패하는 가장 흔한 이유는 누군가 음원 파일을 붙잡고
  // 있는 것이다. 화면이 재생기를 놓아도 윈도우가 핸들을 거두는 데 잠깐 걸린다.
  // 한 번 더 시도해 보고, 그래도 안 되면 왜 안 되는지 알려 준다.
  // (전에는 여기서 예외가 그대로 터져 IPC 가 거부됐고, 화면은 아무 말도 못 했다.)
  const attempt = () => shell.trashItem(dir)
  try {
    await attempt()
  } catch (first) {
    await new Promise((resolve) => setTimeout(resolve, 700))
    try {
      await attempt()
    } catch (second) {
      log('삭제 실패', dir, second.message)
      return {
        ok: false,
        message: '삭제하지 못했습니다. 다른 프로그램이 이 곡의 파일을 쓰고 있을 수 있습니다.\n' +
          '재생을 멈추고 탐색기에서 그 폴더를 닫은 뒤 다시 시도해 주세요.',
        detail: `${first.message}\n${second.message}\n${dir}`
      }
    }
  }
  log('삭제', dir)
  return { ok: true }
})

ipcMain.handle('song:rename', async (_e, { dir, title }) => {
  const metaFile = path.join(dir, 'meta.json')
  const meta = JSON.parse(await fsp.readFile(metaFile, 'utf8'))
  meta.title = title
  await fsp.writeFile(metaFile, JSON.stringify(meta, null, 1), 'utf8')
  return { ok: true }
})

ipcMain.handle('song:reveal', (_e, dir) => { shell.openPath(dir); return { ok: true } })

// 커버를 만들 때만 악보를 꺼내 온다. 목록에 매번 싣기에는 곡당 수 KB 라 무겁다.
ipcMain.handle('song:score', async (_e, dir) => {
  try {
    if (!dir.startsWith(await ensureSongsDir())) return { ok: false, message: '알 수 없는 폴더입니다.' }
    const meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'))
    if (!meta.abc) return { ok: false, message: '이 곡에는 악보가 남아 있지 않아 커버를 만들 수 없습니다.' }
    return { ok: true, abc: meta.abc, lyrics: meta.lyrics || '', style: meta.style || '', title: meta.title }
  } catch (error) {
    return { ok: false, message: `악보를 읽지 못했습니다: ${error.message}` }
  }
})

ipcMain.handle('song:export', async (_e, { dir, title }) => {
  const settings = await readSettings()
  const target = await dialog.showSaveDialog(win, {
    title: 'MP3로 내보내기',
    defaultPath: path.join(app.getPath('music'), `${slug(title)}.mp3`),
    filters: [{ name: 'MP3', extensions: ['mp3'] }]
  })
  if (target.canceled) return { ok: false, canceled: true }
  try {
    const existing = path.join(dir, 'song.mp3')
    if (await exists(path.join(dir, 'audio.wav'))) {
      if (!settings.ffmpeg) return { ok: false, message: 'MP3 변환기를 찾지 못했습니다.' }
      await new Promise((resolve, reject) => execFile(settings.ffmpeg,
        ['-y', '-i', path.join(dir, 'audio.wav'), '-b:a', '320k', target.filePath],
        (error) => error ? reject(error) : resolve()))
    } else if (await exists(existing)) {
      await fsp.copyFile(existing, target.filePath) // 이미 인코딩됨 — 다시 안 한다
    } else {
      return { ok: false, message: '내보낼 음원 파일이 없습니다.' }
    }
    return { ok: true, path: target.filePath }
  } catch (error) {
    log('내보내기 실패', error.message)
    return { ok: false, message: `저장하지 못했습니다: ${error.message}` }
  }
})

// 옵션이 생기기 전에 만든 보관함을 한 번에 정리한다.
ipcMain.handle('songs:compact', async () => {
  if (currentJob) return { ok: false, message: '곡을 만드는 중에는 정리할 수 없습니다.' }
  let converted = 0
  let savedBytes = 0
  const failures = []
  for (const song of await listSongs()) {
    if (song.unfinished) continue
    try {
      // 변환이 필요하든 아니든 중간 단계 파일은 버린다.
      const before = await folderSize(song.dir)
      const wav = path.join(song.dir, 'audio.wav')
      if (await exists(wav) && await encodeMp3(song.dir)) {
        await fsp.rm(wav, { force: true })
        converted += 1
      }
      await tidySong(song.dir)
      savedBytes += Math.max(0, before - await folderSize(song.dir))
    } catch (error) {
      failures.push(`${song.title}: ${error.message}`)
    }
  }
  log('정리', { converted, savedBytes, failures })
  return { ok: true, converted, savedGb: Math.round(savedBytes / 1024 ** 3 * 100) / 100, failures }
})

// 이미 설치했는데 C드라이브가 차오를 때: 체크포인트는 그냥 파일이라 나중에도 옮길 수 있다
// (파이썬 실행환경은 못 옮긴다 — 경로가 절대경로로 박혀 있다).
ipcMain.handle('settings:move-models', async () => {
  if (currentJob || queue.length) return { ok: false, message: '곡을 만드는 중에는 옮길 수 없습니다.' }
  const from = paths().hfHome
  const picked = await dialog.showOpenDialog(win, {
    title: '음악 모델을 옮길 폴더',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '이 폴더로 옮기기'
  })
  if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true }
  const to = path.join(picked.filePaths[0], 'NoraeStudio-models')
  if (path.resolve(to) === path.resolve(from)) return { ok: false, message: '같은 폴더입니다.' }
  const freeGb = await freeSpaceGb(to)
  if (freeGb !== null && freeGb < 9) {
    return { ok: false, message: `여유 공간이 ${freeGb}GB입니다. 9GB 이상 필요합니다.` }
  }
  try {
    send('job:event', { type: 'notice', message: '모델을 옮기는 중입니다. 몇 분 걸릴 수 있습니다…' })
    if (await exists(from)) {
      try {
        await fsp.rename(from, to) // 같은 드라이브면 즉시
      } catch {
        await fsp.cp(from, to, { recursive: true }) // 드라이브가 다르면 복사 후 원본 삭제
        await fsp.rm(from, { recursive: true, force: true })
      }
    } else {
      await fsp.mkdir(to, { recursive: true })
    }
    await writeSettings({ hfHome: to })
    log('모델 이동', from, '→', to)
    return { ok: true, path: to }
  } catch (error) {
    log('모델 이동 실패', error.message)
    return { ok: false, message: `옮기지 못했습니다: ${error.message}` }
  }
})

ipcMain.handle('settings:get', async () => {
  const settings = await readSettings()
  return {
    autoMp3: Boolean(settings.autoMp3),
    dropWav: Boolean(settings.dropWav),
    updateCheck: settings.updateCheck !== false,
    updateRepo: settings.updateRepo || updater.DEFAULT_REPO,
    speed: settings.speed || null
  }
})

// 그래픽카드를 바꿨거나 측정이 이상해졌을 때 처음 값으로 되돌린다.
ipcMain.handle('settings:reset-speed', async () => {
  await writeSettings({ speed: null })
  log('속도 학습값 초기화')
  return { ok: true }
})

ipcMain.handle('settings:set', async (_e, patch) => {
  const next = await writeSettings({
    autoMp3: Boolean(patch.autoMp3),
    // 원본을 지우는 건 MP3 를 만들 때만 의미가 있다. 혼자서는 켜지지 않게 묶어둔다.
    dropWav: Boolean(patch.autoMp3) && Boolean(patch.dropWav),
    ...(patch.updateCheck === undefined ? {} : { updateCheck: Boolean(patch.updateCheck) }),
    ...(patch.updateRepo === undefined ? {} : { updateRepo: String(patch.updateRepo || '').trim() })
  })
  log('설정', { autoMp3: next.autoMp3, dropWav: next.dropWav, updateCheck: next.updateCheck })
  return {
    autoMp3: next.autoMp3,
    dropWav: next.dropWav,
    updateCheck: next.updateCheck !== false,
    updateRepo: next.updateRepo || updater.DEFAULT_REPO
  }
})

// ── 참고곡 분석 ───────────────────────────────────────────────────────────────
// 유튜브 주소나 음원 파일에서 템포·조성·코드진행·음색을 재서 스타일 프롬프트로 옮긴다.
// 멜로디를 따오지 않는다 — 작곡은 그 설명을 참고해서 YuE2 가 새로 한다.
// uv 는 설치할 때 받아 두지만, 남의 실행환경을 "가져오기" 한 경우에는 우리 폴더에 없다.
// 그때는 파이썬 옆에서 찾고, 그래도 없으면 새로 받는다.
async function ensureUv () {
  const p = paths()
  if (await exists(p.uv)) return p.uv
  // venv/Scripts/python.exe → runtime/uv.exe
  const beside = path.resolve(path.dirname(p.python), '..', '..', 'uv.exe')
  if (await exists(beside)) return beside
  await fsp.mkdir(p.runtime, { recursive: true })
  const zip = path.join(os.tmpdir(), 'uv.zip')
  await download(UV_URL, zip)
  await unzip(zip, p.runtime)
  await fsp.unlink(zip).catch(() => {})
  return p.uv
}

async function analyzeReady () {
  const p = paths()
  if (!await exists(p.python)) return false
  try {
    await withTimeout(run(p.python, ['-c', 'import librosa, yt_dlp']), 90000)
    return true
  } catch {
    return false
  }
}

ipcMain.handle('analyze:ready', () => analyzeReady())

ipcMain.handle('analyze:install', async () => {
  const p = paths()
  try {
    const uv = await ensureUv()
    send('analyze:progress', { note: '분석 도구를 설치하는 중… (약 200MB)' })
    await run(uv, ['pip', 'install', '--python', p.python, ...ANALYZE_PACKAGES],
      { stream: true, env: uvEnv() })
    log('분석 도구 설치 완료')
    return { ok: true }
  } catch (error) {
    log('분석 도구 설치 실패', error.message)
    return { ok: false, message: `분석 도구를 설치하지 못했습니다: ${error.message}` }
  }
})

ipcMain.handle('analyze:pick-file', async () => {
  const picked = await dialog.showOpenDialog(win, {
    title: '참고할 음원 파일',
    properties: ['openFile'],
    filters: [{ name: '음원', extensions: ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'opus', 'aac', 'wma'] }]
  })
  if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true }
  return { ok: true, path: picked.filePaths[0] }
})

// ── 채보: 음원 → 악보 ────────────────────────────────────────────────────────
// 커버를 만들 재료다. demucs 로 보컬을 꺼내고 음을 따서 ABC 악보로 적는다.
const transcribeScript = () => unpacked(path.join(__dirname, '..', 'python', 'transcribe.py'))

let transcriber = null

async function transcribeReady () {
  const p = paths()
  if (!await exists(p.python)) return false
  try {
    await withTimeout(run(p.python, ['-c', 'import demucs, torchaudio, librosa']), 120000)
    return true
  } catch {
    return false
  }
}

ipcMain.handle('transcribe:ready', () => transcribeReady())

ipcMain.handle('transcribe:install', async () => {
  const p = paths()
  try {
    const uv = await ensureUv()
    send('transcribe:progress', { type: 'progress', note: '보컬 분리 도구를 설치하는 중… (약 300MB)' })
    // torchaudio 는 torch 와 같은 CUDA 빌드여야 한다. PyTorch 저장소를 함께 본다.
    await run(uv, ['pip', 'install', '--python', p.python,
      '--index-url', TORCH_INDEX, '--index-strategy', 'unsafe-best-match', TORCHAUDIO_PACKAGE],
    { stream: true, env: uvEnv() })
    await run(uv, ['pip', 'install', '--python', p.python, ...TRANSCRIBE_PACKAGES],
      { stream: true, env: uvEnv() })
    log('채보 도구 설치 완료')
    return { ok: true }
  } catch (error) {
    log('채보 도구 설치 실패', error.message)
    return { ok: false, message: `채보 도구를 설치하지 못했습니다: ${error.message}` }
  }
})

ipcMain.handle('transcribe:cancel', () => {
  if (transcriber) { transcriber.kill(); transcriber = null }
  return { ok: true }
})

ipcMain.handle('transcribe:run', async (_e, { file, chordsOnly }) => {
  if (!file) return { ok: false, message: '음원 파일이 필요합니다.' }
  if (transcriber) return { ok: false, message: '이미 악보를 만드는 중입니다.' }
  if (!await transcribeReady()) return { ok: false, message: 'needs-install' }

  const args = [transcribeScript(), '--file', file,
    '--out', path.join(os.tmpdir(), 'norae-score')]
  if (chordsOnly) args.push('--chords-only')

  log('채보 시작', file, chordsOnly ? '(코드만)' : '(멜로디 포함)')
  const result = await runJsonScript(args, 'transcribe:progress', (child) => { transcriber = child })
  transcriber = null
  if (result.ok) log('채보 완료', result.info)
  return result
})

// ── 유튜브 → MP3 ──────────────────────────────────────────────────────────────
// 참고곡을 구하려고 다른 다운로드 프로그램을 따로 띄울 필요가 없게 안에 넣어 둔다.
// 받은 MP3 는 그대로 [참고곡 분석]에 넣을 수 있다.
let downloader = null

const ytScript = () => unpacked(path.join(__dirname, '..', 'python', 'ytdl.py'))

ipcMain.handle('yt:pick-folder', async () => {
  const picked = await dialog.showOpenDialog(win, {
    title: 'MP3 를 저장할 폴더',
    defaultPath: app.getPath('music'),
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '이 폴더에 저장'
  })
  if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true }
  await writeSettings({ ytDir: picked.filePaths[0] })
  return { ok: true, path: picked.filePaths[0] }
})

ipcMain.handle('yt:folder', async () => {
  const settings = await readSettings()
  return settings.ytDir || path.join(app.getPath('music'), '노래공방 참고곡')
})

ipcMain.handle('yt:cancel', () => {
  if (downloader) { downloader.kill(); downloader = null }
  return { ok: true }
})

/**
 * 파이썬 스크립트를 돌리며 stdout 의 JSON 이벤트를 화면으로 흘려보낸다.
 * {type:"done"} 이 결과가 되고, {type:"error"} 는 실패 사유가 된다.
 * 취소할 수 있게 자식 프로세스를 onSpawn 으로 넘겨준다.
 */
function runJsonScript (args, channel, onSpawn) {
  const p = paths()
  return new Promise((resolve) => {
    const child = spawn(p.python, ['-u', ...args], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      windowsHide: true
    })
    if (onSpawn) onSpawn(child)

    let result = null
    let failure = null
    let buffer = ''

    child.stdout.on('data', (chunk) => {
      buffer += chunk
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() // 마지막 조각은 아직 안 끝난 줄이다
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)
          if (event.type === 'done') result = event
          else if (event.type === 'error') failure = event.message
          else send(channel, event)
        } catch { /* JSON 이 아닌 줄은 흘려보낸다 */ }
      }
    })
    child.stderr.on('data', (d) => log(`${channel} stderr`, String(d).trim().slice(-400)))
    child.on('error', (error) => resolve({ ok: false, message: error.message }))
    child.on('close', (code) => resolve(result
      ? { ok: true, ...result }
      : { ok: false, message: failure || `실패했습니다 (code ${code}).` }))
  })
}

ipcMain.handle('yt:info', async (_e, url) => {
  if (!url) return { ok: false, message: '주소가 필요합니다.' }
  if (!await analyzeReady()) return { ok: false, message: 'needs-install' }
  return runJsonScript([ytScript(), '--url', url, '--info'], 'yt:progress')
})

ipcMain.handle('yt:download', async (_e, { url, dir, bitrate }) => {
  if (!url) return { ok: false, message: '주소가 필요합니다.' }
  if (downloader) return { ok: false, message: '이미 받는 중입니다.' }
  if (!await analyzeReady()) return { ok: false, message: 'needs-install' }

  const target = dir || path.join(app.getPath('music'), '노래공방 참고곡')
  await fsp.mkdir(target, { recursive: true })
  log('유튜브 내려받기', url, '→', target)

  const result = await runJsonScript(
    [ytScript(), '--url', url, '--out', target, '--bitrate', String(bitrate || 320)],
    'yt:progress', (child) => { downloader = child })
  downloader = null
  if (result.ok) log('내려받기 완료', result.path, `${Math.round(result.bytes / 1024)}KB`)
  return result
})

let analyzer = null

ipcMain.handle('analyze:cancel', () => {
  if (analyzer) { analyzer.kill(); analyzer = null }
  return { ok: true }
})

ipcMain.handle('analyze:run', async (_e, { url, file }) => {
  const p = paths()
  if (!url && !file) return { ok: false, message: '주소나 파일이 필요합니다.' }
  if (analyzer) return { ok: false, message: '이미 분석 중입니다.' }

  const args = ['-u', unpacked(path.join(__dirname, '..', 'python', 'analyze.py'))]
  args.push(...(url ? ['--url', url] : ['--file', file]))
  // 받은 음원은 임시 폴더에 뒀다가 분석이 끝나면 스스로 지운다.
  args.push('--out', path.join(os.tmpdir(), 'norae-reference'))

  log('참고곡 분석 시작', url || file)
  return await new Promise((resolve) => {
    analyzer = spawn(p.python, args, {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      windowsHide: true
    })
    let analysis = null
    let failure = null
    let buffer = ''

    analyzer.stdout.on('data', (chunk) => {
      buffer += chunk
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop()
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)
          if (event.type === 'done') analysis = event.analysis
          else if (event.type === 'error') failure = event.message
          else send('analyze:progress', event)
        } catch { /* 진행 보고가 아닌 줄은 흘려보낸다 */ }
      }
    })
    analyzer.stderr.on('data', (d) => log('분석 stderr', String(d).trim().slice(-400)))
    analyzer.on('error', (error) => {
      analyzer = null
      resolve({ ok: false, message: `분석을 시작하지 못했습니다: ${error.message}` })
    })
    analyzer.on('close', (code) => {
      analyzer = null
      if (analysis) {
        log('참고곡 분석 완료', { bpm: analysis.bpm, key: `${analysis.key} ${analysis.mode}` })
        return resolve({ ok: true, analysis })
      }
      resolve({ ok: false, message: failure || `분석에 실패했습니다 (code ${code}).` })
    })
  })
})

// ── 모델(가중치) 업데이트 ─────────────────────────────────────────────────────
// 프로그램 업데이트와는 다른 일이다. m-a-p 가 YuE2 가중치를 새로 올리면 여기서 잡는다.
ipcMain.handle('models:check', async () => {
  const p = paths()
  const result = await models.check(p.hfHome)
  log('모델 확인', {
    hasUpdate: result.hasUpdate,
    missing: result.missing,
    reachable: result.reachable,
    repos: result.repos.map((r) => ({ repo: r.repo, local: (r.local || '').slice(0, 7), remote: (r.remote || '').slice(0, 7) }))
  })
  return { ...result, hfHome: p.hfHome, cacheGb: Math.round(models.cacheBytes(p.hfHome) / 1024 ** 3 * 10) / 10 }
})

// 새 판 받기 = 설치 때 쓰는 스크립트를 그대로 한 번 더 돌린다.
// snapshot_download 는 바뀐 파일만 가져오므로 통째로 다시 받지는 않는다.
ipcMain.handle('models:update', async () => {
  if (currentJob || queue.length) return { ok: false, message: '곡을 만드는 중에는 모델을 바꿀 수 없습니다.' }
  const p = paths()
  if (!await exists(p.python)) return { ok: false, message: '실행 환경을 찾지 못했습니다.' }

  // 모델 파일이 바뀌면 이미 올라가 있는 워커는 옛 파일을 물고 있다. 먼저 내려보낸다.
  if (worker) {
    try { worker.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n') } catch {}
    worker.kill()
    worker = null
  }

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(p.python, ['-u', p.setupModels], {
        env: { ...process.env, HF_HOME: p.hfHome, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        windowsHide: true
      })
      let err = ''
      child.stdout.on('data', (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((line) => {
        try {
          const event = JSON.parse(line)
          if (event.type === 'progress') send('models:progress', { bytes: event.bytes, total: MODEL_BYTES })
          else if (event.type === 'error') err += event.message
        } catch { /* 진행 보고가 아닌 줄은 흘려보낸다 */ }
      }))
      child.stderr.on('data', (d) => { err += d })
      child.on('error', reject)
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(err.slice(-2000) || `모델 받기 실패 (${code})`)))
    })
  } catch (error) {
    log('모델 업데이트 실패', error.message)
    return { ok: false, message: error.message }
  }

  const after = await models.check(p.hfHome)
  log('모델 업데이트 완료', after.repos.map((r) => `${r.repo}@${(r.local || '').slice(0, 7)}`).join(' '))
  return { ok: true, ...after, cacheGb: Math.round(models.cacheBytes(p.hfHome) / 1024 ** 3 * 10) / 10 }
})

ipcMain.handle('shell:open', (_e, target) => { shell.openPath(target); return { ok: true } })

ipcMain.handle('log:open', () => {
  shell.showItemInFolder(path.join(userData(), 'app.log'))
  return { ok: true }
})

ipcMain.handle('ui:log', (_e, text) => { log('화면', text); return { ok: true } })

// ── 업데이트 ──────────────────────────────────────────────────────────────────
ipcMain.handle('update:check', async () => {
  const found = await updater.check(await readSettings())
  log('업데이트 확인', found ? { version: found.version, current: found.current } : '최신')
  return found
})

ipcMain.handle('update:install', async (_e, info) => {
  if (!info || !info.url) return { ok: false, error: '내려받을 주소가 없습니다.' }
  if (info.forMe === false) return updater.openInBrowser(info.url)
  const downloaded = await updater.download(info.url, (ratio) => send('update:progress', ratio), info.version)
  if (!downloaded.ok) {
    log('업데이트 다운로드 실패', downloaded.error)
    return downloaded
  }
  const started = updater.run(downloaded.path)
  if (!started.ok) return started
  log('업데이트 설치 시작', downloaded.path)
  // 설치기가 이 앱을 닫고 덮어쓴 뒤 다시 연다. 열린 창이 파일을 물고 있으면 안 되니 비켜준다.
  setTimeout(() => { if (win && !win.isDestroyed()) win.hide(); app.quit() }, 800)
  return started
})

// ── 창 ────────────────────────────────────────────────────────────────────────
// 메뉴가 없으면 Ctrl+C/V/X/A 단축키가 등록되지 않아서 복사·붙여넣기가 조용히 안 먹는다.
// 막대는 계속 숨겨둔다 — 단축키만 필요하다.
function installEditMenu () {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{
    label: '편집',
    submenu: [
      { role: 'undo', label: '실행 취소' },
      { role: 'redo', label: '다시 실행' },
      { type: 'separator' },
      { role: 'cut', label: '잘라내기' },
      { role: 'copy', label: '복사' },
      { role: 'paste', label: '붙여넣기' },
      { role: 'selectAll', label: '전체 선택' }
    ]
  }]))
}

// 대부분의 사람은 입력칸에서 오른쪽 클릭으로 붙여넣는다. Electron 은 기본 메뉴가 없다.
function installContextMenu (target) {
  target.webContents.on('context-menu', (_event, params) => {
    const flags = params.editFlags
    const items = []
    if (params.isEditable || params.selectionText) {
      items.push(
        { role: 'cut', label: '잘라내기', enabled: params.isEditable && flags.canCut },
        { role: 'copy', label: '복사', enabled: flags.canCopy },
        { role: 'paste', label: '붙여넣기', enabled: params.isEditable && flags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', label: '전체 선택', enabled: flags.canSelectAll }
      )
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: target })
  })
}

function createWindow () {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: '#0f1115',
    title: '노래공방',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  })
  win.setMenuBarVisibility(false)
  win.autoHideMenuBar = true
  installContextMenu(win)
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
}

app.whenReady().then(() => {
  updater.init({ app, shell, log })
  installEditMenu()
  createWindow()
})

app.on('window-all-closed', () => {
  if (worker) {
    try { worker.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n') } catch {}
    worker.kill()
  }
  if (process.platform !== 'darwin') app.quit()
})
