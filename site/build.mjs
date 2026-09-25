// 다운로드 페이지를 만든다.
//
// 비밀번호를 단순 비교하면(if (input === '1004')) 소스만 열어도 뚫린다. 그래서
// 다운로드 주소 자체를 비밀번호로 암호화해서 넣는다. 비밀번호를 모르면 페이지
// 소스에는 알아볼 수 없는 문자열만 있다.
//
// 그래도 이건 잠금장치가 아니라 문턱이다. 네 자리 비밀번호는 1만 번이면 다 해보고,
// 설치 파일은 공개 GitHub 릴리스에 있어서 주소를 아는 사람은 그냥 받을 수 있다.
// 진짜로 막아야 한다면 릴리스를 비공개로 두고 서버에서 인증해야 한다.
//
//   node site/build.mjs <릴리스주소> <버전> <바이트수>
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const PASSWORD = process.env.NORAE_SITE_PASSWORD || '1004'
const ITERATIONS = 200000 // 네 자리 비밀번호라도 한 번 시도에 드는 비용은 올려 둔다

const [url, version, bytes] = process.argv.slice(2)
if (!url || !version) {
  console.error('쓰임: node site/build.mjs <릴리스주소> <버전> [바이트수]')
  process.exit(1)
}

// 브라우저의 WebCrypto 와 같은 방식으로 암호화한다(PBKDF2-SHA256 → AES-256-GCM).
const salt = crypto.randomBytes(16)
const iv = crypto.randomBytes(12)
const key = crypto.pbkdf2Sync(PASSWORD, salt, ITERATIONS, 32, 'sha256')

const secret = JSON.stringify({ url, version, bytes: Number(bytes) || 0 })
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
const tag = cipher.getAuthTag()

const payload = {
  v: 1,
  salt: salt.toString('base64'),
  iv: iv.toString('base64'),
  // WebCrypto 의 AES-GCM 은 암호문 뒤에 인증 태그가 붙어 있다고 본다.
  data: Buffer.concat([encrypted, tag]).toString('base64'),
  iterations: ITERATIONS
}

const template = fs.readFileSync(path.join(here, 'template.html'), 'utf8')
const page = template
  .replace('__PAYLOAD__', JSON.stringify(payload))
  .replace(/__VERSION__/g, version)

const outDir = path.join(here, 'public')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'index.html'), page, 'utf8')

console.log(`site/public/index.html 생성 — 버전 ${version}`)
console.log(`  암호화된 주소: ${url}`)
console.log(`  비밀번호: ${PASSWORD} (NORAE_SITE_PASSWORD 로 바꿀 수 있음)`)
