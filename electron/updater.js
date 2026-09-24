'use strict'
// 새 버전 확인 — 사용자 본인의 GitHub 릴리스만 본다. 다른 회사 서버에 의존하지 않는다.
//
//   GET https://api.github.com/repos/<owner>/<repo>/releases/latest
//   → { tag_name: "v1.0.1", body: "변경 내용", assets: [{ name, browser_download_url, size }] }
//
// settings.json 의 updateRepo 로 저장소를 바꿀 수 있고, updateCheck:false 면 아예 안 본다.
// 저장소가 비공개면 익명 요청은 404 를 받는다. 그때는 조용히 "최신"으로 처리한다
// (업데이트를 못 받을 뿐, 프로그램은 그대로 돌아간다).
const fs = require('fs')
const path = require('path')
const os = require('os')
const https = require('https')
const { spawn } = require('child_process')

const DEFAULT_REPO = 'ibrkiller-penz/norae-studio'
const USER_AGENT = 'norae-studio-updater'

let ctx = { app: null, shell: null, log: () => {} }

function init (context) { ctx = { ...ctx, ...context } }

// "v1.2.3" / "1.2.3" → [1,2,3]
const parts = (version) => String(version || '').replace(/^v/, '').split('.').map(Number)

function isNewer (candidate, current) {
  const a = parts(candidate)
  const b = parts(current)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] || 0
    const right = b[i] || 0
    if (left !== right) return left > right
  }
  return false
}

function getJson (url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume()
        if (redirects > 5) return reject(new Error('리다이렉트가 너무 많습니다'))
        return resolve(getJson(res.headers.location, redirects + 1))
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }))
      }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (error) { reject(error) }
      })
    }).on('error', reject)
  })
}

// 설치 파일을 고른다: NSIS 설치기(.exe) 가 우선, 없으면 첫 번째 자산.
function pickAsset (assets = []) {
  return assets.find((a) => /\.exe$/i.test(a.name)) || assets[0] || null
}

/** 새 버전이 있으면 정보를, 없으면 null 을 돌려준다. 실패해도 예외를 던지지 않는다. */
async function check (settings = {}) {
  if (settings.updateCheck === false) return null
  const repo = settings.updateRepo || DEFAULT_REPO
  const current = ctx.app.getVersion()
  try {
    const release = await getJson(`https://api.github.com/repos/${repo}/releases/latest`)
    const version = String(release.tag_name || '').replace(/^v/, '')
    if (!version || !isNewer(version, current)) return null
    const asset = pickAsset(release.assets)
    return {
      version,
      current,
      notes: release.body || '',
      url: asset ? asset.browser_download_url : release.html_url,
      size: asset ? asset.size : 0,
      // 내려받을 설치 파일이 없으면 브라우저로 릴리스 페이지만 연다.
      forMe: Boolean(asset)
    }
  } catch (error) {
    if (error.status === 404) {
      ctx.log('update: 릴리스가 없거나 비공개 저장소입니다', repo)
    } else {
      ctx.log('update check 실패', error.message)
    }
    return null
  }
}

function download (url, onProgress, version) {
  return new Promise((resolve) => {
    const dest = path.join(os.tmpdir(), `NoraeStudio-Setup-${version || 'latest'}.exe`)
    const file = fs.createWriteStream(dest)
    const fail = (message) => {
      file.close(() => fs.promises.rm(dest, { force: true }).catch(() => {}))
      resolve({ ok: false, error: message })
    }
    const get = (link, redirects = 0) => https.get(link, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume()
        if (redirects > 5) return fail('리다이렉트가 너무 많습니다')
        return get(res.headers.location, redirects + 1)
      }
      if (res.statusCode !== 200) {
        res.resume()
        return fail(`HTTP ${res.statusCode}`)
      }
      const total = Number(res.headers['content-length'] || 0)
      let got = 0
      res.on('data', (chunk) => {
        got += chunk.length
        if (onProgress && total) onProgress(got / total)
      })
      res.pipe(file)
      file.on('finish', () => file.close(() => resolve({ ok: true, path: dest })))
    }).on('error', (error) => fail(error.message))
    get(url)
  })
}

/** 내려받은 설치 파일을 실행한다. 이 앱은 곧 스스로 종료해서 파일 잠금을 푼다. */
function run (installer) {
  try {
    spawn(installer, [], { detached: true, stdio: 'ignore' }).unref()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

function openInBrowser (url) {
  ctx.shell.openExternal(url)
  return { ok: true, opened: true }
}

module.exports = { init, check, download, run, openInBrowser, isNewer, DEFAULT_REPO }
