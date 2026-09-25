'use strict'
// 렌더러(화면)는 Node 에 직접 손대지 않는다. 여기서 허용한 함수만 window.norae 로 노출된다.
const { contextBridge, ipcRenderer } = require('electron')

// 이벤트 구독: 핸들러를 걸고, 해제하는 함수를 돌려준다.
const on = (channel) => (handler) => {
  const listener = (_event, payload) => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('norae', {
  // 앱 상태 / 설치
  state: () => ipcRenderer.invoke('app:state'),
  checkSetup: () => ipcRenderer.invoke('setup:check'),
  location: () => ipcRenderer.invoke('setup:location'),
  pickLocation: () => ipcRenderer.invoke('setup:pick-location'),
  adoptRuntime: () => ipcRenderer.invoke('setup:adopt-runtime'),
  runSetup: () => ipcRenderer.invoke('setup:run'),

  // 프로젝트
  projects: () => ipcRenderer.invoke('projects:list'),
  selectProject: (name) => ipcRenderer.invoke('projects:select', name),
  createProject: (name) => ipcRenderer.invoke('projects:create', name),
  renameProject: (from, to) => ipcRenderer.invoke('projects:rename', { from, to }),
  deleteProject: (name) => ipcRenderer.invoke('projects:delete', name),

  // 곡
  listSongs: () => ipcRenderer.invoke('songs:list'),
  generate: (payload) => ipcRenderer.invoke('song:generate', payload),
  resume: (dir) => ipcRenderer.invoke('song:resume', dir),
  cancel: () => ipcRenderer.invoke('song:cancel'),
  remove: (dir) => ipcRenderer.invoke('song:delete', dir),
  rename: (dir, title) => ipcRenderer.invoke('song:rename', { dir, title }),
  reveal: (dir) => ipcRenderer.invoke('song:reveal', dir),
  score: (dir) => ipcRenderer.invoke('song:score', dir),
  exportMp3: (dir, title) => ipcRenderer.invoke('song:export', { dir, title }),

  // 대기열
  queue: () => ipcRenderer.invoke('queue:list'),
  queueRemove: (jobId) => ipcRenderer.invoke('queue:remove', jobId),
  queueClear: () => ipcRenderer.invoke('queue:clear'),

  // 설정 / 정리
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  resetSpeed: () => ipcRenderer.invoke('settings:reset-speed'),

  // AI 모델(가중치) 갱신 — 프로그램 업데이트와는 별개다
  checkModels: () => ipcRenderer.invoke('models:check'),
  updateModels: () => ipcRenderer.invoke('models:update'),
  onModelProgress: on('models:progress'),
  moveModels: () => ipcRenderer.invoke('settings:move-models'),
  compact: () => ipcRenderer.invoke('songs:compact'),

  // 잡동사니
  open: (target) => ipcRenderer.invoke('shell:open', target),
  openLog: () => ipcRenderer.invoke('log:open'),
  log: (text) => ipcRenderer.invoke('ui:log', text),

  // 업데이트 (본인 GitHub 릴리스)
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: (info) => ipcRenderer.invoke('update:install', info),

  // 메인 → 화면 알림
  onSetupStep: on('setup:step'),
  onSetupProgress: on('setup:progress'),
  onSetupLog: on('setup:log'),
  onQueue: on('queue:update'),
  onJobStarted: on('job:started'),
  onJobEvent: on('job:event'),
  onJobDone: on('job:done'),
  onJobError: on('job:error'),
  onWorkerLog: on('worker:log'),
  onUpdateProgress: on('update:progress')
})
