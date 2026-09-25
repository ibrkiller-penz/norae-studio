'use strict'
// electron/models.js 확인. `node electron/models.test.js` 로 돌린다.
// 인터넷도 Electron 도 쓰지 않는다 — 임시 폴더에 가짜 캐시를 만들고 API 는 흉내낸다.

const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const models = require('./models')

let failures = 0
function check (name, fn) {
  return fn().then(
    () => console.log(`  OK   ${name}`),
    (error) => { failures += 1; console.log(`  실패 ${name}\n       ${error.message}`) })
}

// 허깅페이스 캐시 모양을 흉내낸 임시 폴더
function fakeCache (shas) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'norae-models-'))
  for (const [repo, sha] of Object.entries(shas)) {
    if (sha === null) continue // 아직 안 받은 저장소
    const refs = path.join(models.cacheDir(home, repo), 'refs')
    fs.mkdirSync(refs, { recursive: true })
    fs.writeFileSync(path.join(refs, 'main'), sha + '\n', 'utf8')
  }
  return home
}

const fakeApi = (shas) => async (url) => {
  const repo = url.replace('https://huggingface.co/api/models/', '')
  if (!(repo in shas)) throw new Error('HTTP 404')
  return { sha: shas[repo], lastModified: '2026-09-16T08:38:56.000Z' }
}

const A = '14fc6c6f146441b1dd6363fcb2e01e82a6914cb7'
const B = '9a94e1d0ea9f8087e98f77fa88df4a4068104d2a'
const NEW = 'ffffffffffffffffffffffffffffffffffffffff'

async function main () {
  console.log('models.js')

  await check('같은 해시면 최신이다', async () => {
    const home = fakeCache({ 'm-a-p/YuE2-3B': A, 'm-a-p/YuE2-Vae': B })
    const result = await models.check(home, fakeApi({ 'm-a-p/YuE2-3B': A, 'm-a-p/YuE2-Vae': B }))
    assert.strictEqual(result.hasUpdate, false)
    assert.strictEqual(result.missing, false)
    assert.strictEqual(result.reachable, true)
  })

  await check('해시가 다르면 새 판으로 본다', async () => {
    const home = fakeCache({ 'm-a-p/YuE2-3B': A, 'm-a-p/YuE2-Vae': B })
    const result = await models.check(home, fakeApi({ 'm-a-p/YuE2-3B': NEW, 'm-a-p/YuE2-Vae': B }))
    assert.strictEqual(result.hasUpdate, true)
    const changed = result.repos.filter((r) => r.changed).map((r) => r.repo)
    assert.deepStrictEqual(changed, ['m-a-p/YuE2-3B'], '바뀐 저장소만 표시해야 한다')
  })

  await check('아직 안 받은 모델은 "새 판"이 아니라 "설치 안 됨"이다', async () => {
    const home = fakeCache({ 'm-a-p/YuE2-3B': null, 'm-a-p/YuE2-Vae': B })
    const result = await models.check(home, fakeApi({ 'm-a-p/YuE2-3B': A, 'm-a-p/YuE2-Vae': B }))
    assert.strictEqual(result.hasUpdate, false, '없는 걸 업데이트라고 하면 안 된다')
    assert.strictEqual(result.missing, true)
  })

  await check('refs/main 의 줄바꿈·공백을 털어낸다', async () => {
    const home = fakeCache({ 'm-a-p/YuE2-3B': A, 'm-a-p/YuE2-Vae': B })
    assert.strictEqual(await models.localSha(home, 'm-a-p/YuE2-3B'), A)
  })

  await check('인터넷이 안 되면 예외 대신 reachable:false', async () => {
    const home = fakeCache({ 'm-a-p/YuE2-3B': A, 'm-a-p/YuE2-Vae': B })
    const dead = async () => { throw new Error('getaddrinfo ENOTFOUND') }
    const result = await models.check(home, dead)
    assert.strictEqual(result.reachable, false)
    assert.strictEqual(result.hasUpdate, false, '모르면 업데이트가 있다고 하면 안 된다')
  })

  await check('캐시가 통째로 없어도 죽지 않는다', async () => {
    const result = await models.check(path.join(os.tmpdir(), 'norae-없는폴더-' + Date.now()),
      fakeApi({ 'm-a-p/YuE2-3B': A, 'm-a-p/YuE2-Vae': B }))
    assert.strictEqual(result.missing, true)
    assert.strictEqual(result.hasUpdate, false)
  })

  await check('캐시 용량을 잰다', async () => {
    const home = fakeCache({ 'm-a-p/YuE2-3B': A, 'm-a-p/YuE2-Vae': B })
    const blobs = path.join(models.cacheDir(home, 'm-a-p/YuE2-3B'), 'blobs')
    fs.mkdirSync(blobs, { recursive: true })
    fs.writeFileSync(path.join(blobs, 'chunk'), Buffer.alloc(4096))
    assert.strictEqual(models.cacheBytes(home), 4096)
  })

  console.log(failures ? `\n${failures}개 실패` : '\n전부 통과')
  process.exit(failures ? 1 : 0)
}

main()
