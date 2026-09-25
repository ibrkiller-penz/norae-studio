'use strict'
// YuE2 모델(가중치)에 새 판이 나왔는지 본다.
//
// 허깅페이스 캐시는 저장소마다 refs/main 파일에 "지금 받아둔 커밋 해시"를 적어 둔다.
//   <hfHome>/hub/models--m-a-p--YuE2-3B/refs/main  →  14fc6c6f...
// 같은 값을 API 가 알려주므로 둘을 견주면 새 판인지 알 수 있다.
//   GET https://huggingface.co/api/models/m-a-p/YuE2-3B  →  { sha, lastModified }
//
// 프로그램 업데이트(updater.js)와는 다른 일이다. 이쪽은 AI 모델 자체가 바뀐 경우다.
// Electron 에 기대지 않는 순수 모듈이라 따로 돌려볼 수 있다(models.test.js).
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const https = require('https')

const REPOS = ['m-a-p/YuE2-3B', 'm-a-p/YuE2-Vae']
const USER_AGENT = 'norae-studio'

// 허깅페이스는 저장소 이름의 '/' 를 '--' 로 바꿔 폴더를 만든다.
const cacheDir = (hfHome, repo) => path.join(hfHome, 'hub', `models--${repo.replace(/\//g, '--')}`)

/** 지금 받아둔 판의 해시. 아직 안 받았으면 null. */
async function localSha (hfHome, repo) {
  try {
    const text = await fsp.readFile(path.join(cacheDir(hfHome, repo), 'refs', 'main'), 'utf8')
    return text.trim() || null
  } catch {
    return null
  }
}

function getJson (url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
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

/** 허깅페이스가 말하는 최신 판. */
async function remoteInfo (repo, fetchJson = getJson) {
  const data = await fetchJson(`https://huggingface.co/api/models/${repo}`)
  return { sha: data.sha || null, lastModified: data.lastModified || null }
}

/**
 * 두 저장소를 견줘 새 판이 있는지 알려준다.
 * 인터넷이 안 되면 예외를 던지지 않고 reachable:false 로 돌려준다 —
 * 모델 확인에 실패했다고 프로그램을 못 쓰게 만들 이유가 없다.
 */
async function check (hfHome, fetchJson = getJson) {
  const repos = []
  let reachable = true
  for (const repo of REPOS) {
    const local = await localSha(hfHome, repo)
    let remote = null
    let lastModified = null
    try {
      const info = await remoteInfo(repo, fetchJson)
      remote = info.sha
      lastModified = info.lastModified
    } catch {
      reachable = false
    }
    repos.push({
      repo,
      local,
      remote,
      lastModified,
      // 아직 안 받은 것(local null)은 "새 판"이 아니라 "설치 안 됨"이다.
      changed: Boolean(local && remote && local !== remote),
      missing: !local
    })
  }
  return {
    reachable,
    repos,
    hasUpdate: repos.some((r) => r.changed),
    missing: repos.some((r) => r.missing)
  }
}

/** 캐시가 디스크에서 차지하는 크기. 오래된 판이 쌓였는지 볼 때 쓴다. */
function folderBytes (dir) {
  let total = 0
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += folderBytes(full)
    else if (entry.isFile()) {
      // 허깅페이스 캐시는 심링크를 쓴다. 실제 덩어리는 blobs 아래 한 번만 센다.
      try { total += fs.lstatSync(full).size } catch {}
    }
  }
  return total
}

function cacheBytes (hfHome) {
  return REPOS.reduce((sum, repo) => sum + folderBytes(path.join(cacheDir(hfHome, repo), 'blobs')), 0)
}

module.exports = { REPOS, check, localSha, remoteInfo, cacheDir, cacheBytes, folderBytes }
