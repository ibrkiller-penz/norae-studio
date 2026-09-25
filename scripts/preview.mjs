// 화면 한 조각을 브라우저에서 눈으로(그리고 자로) 확인하려고 만드는 미리보기 파일.
//
//   node scripts/preview.mjs [펼쳐둘 창 id ...]
//   python -m http.server 8899   → http://127.0.0.1:8899/preview.html
//
// Electron 창은 바깥에서 자를 댈 수 없다. renderer 를 그대로 쓰되 CSS 를 안에 넣고
// (file:// 로 열면 딸린 파일이 안 붙는 환경이 있다), 평소 숨어 있는 창을 펼쳐 둔다.
// 실제 앱이 아니므로 동작은 확인할 수 없고 배치만 본다.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const show = process.argv.slice(2)

let html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8')
const css = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8')

html = html
  .replace(/<link rel="stylesheet" href="styles\.css">/, `<style>\n${css}\n</style>`)
  // 앱 코드는 window.norae 가 없으면 곧바로 터진다. 배치만 볼 것이므로 뺀다.
  .replace(/<script src="app\.js"><\/script>/, '')
  // CSP 는 인라인 <style> 을 막는다.
  .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')

for (const id of show) {
  const pattern = new RegExp(`(<div id="${id}" class="overlay) hidden(")`)
  if (!pattern.test(html)) {
    console.error(`  펼칠 창을 찾지 못했습니다: #${id}`)
    continue
  }
  html = html.replace(pattern, '$1$2')
}

const out = path.join(root, 'preview.html')
fs.writeFileSync(out, html)
console.log(`preview.html 생성${show.length ? ` — 펼친 창: ${show.join(', ')}` : ''}`)
console.log('  python -m http.server 8899  뒤 http://127.0.0.1:8899/preview.html')
