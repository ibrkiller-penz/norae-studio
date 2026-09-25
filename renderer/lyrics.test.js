'use strict'
// renderer/lyrics.js 확인. `node renderer/lyrics.test.js` 로 돌린다.
// 실제로 커버가 실패했던 가사(태그가 하나도 없던 그 가사)를 자료로 쓴다.

const assert = require('node:assert')
const { autoTagLyrics, similarity, splitStanzas } = require('./lyrics')

let failures = 0
function check (name, fn) {
  try {
    fn()
    console.log(`  OK   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  실패 ${name}\n       ${error.message}`)
  }
}

// 2026-09-25 에 실제로 앱에 들어갔던 가사. 태그가 없어서 가사가 전혀 맞지 않았다.
const REAL = `그렇게 대단한 운명까진
바란적 없다 생각했는데
그대 하나 떠나간 내 하룬 이제
운명이 아님 채울 수 없소

별처럼 수 많은 사람들 그 중에 그대를 만나
꿈을 꾸듯 서롤 알아보고
주는 것 만으로 벅찼던 내가 또 사랑을 받고
그 모든건 기적이었음을

그렇게 어른이 되었다고
자신한 내가 어제같은데
그대라는 인연을 놓지 못하는
내 모습, 어린아이가 됐소

나를 꽃처럼 불러주던 그대 입술에 핀 내 이름
이제 수많은 이름들 그 중에 하나되고
오 그대의 이유였던 나의 모든 것도 그저 그렇게

별처럼 수 많은 사람들 그 중에 서로를 만나
사랑하고 다시 멀어지고
억겁의 시간이 지나도 어쩌면 또다시 만나
우리 사랑 운명이었다면
내가 너의 기적이었다면`

console.log('lyrics.js')

check('실제 가사에서 되풀이되는 후렴을 찾아낸다', () => {
  const result = autoTagLyrics(REAL)
  assert.ok(result.tagged, '태그를 붙여야 한다')
  // 2연과 5연이 "별처럼 수 많은 사람들 그 중에 ..." 로 겹친다.
  assert.strictEqual(result.sections[1], 'Chorus', '2연은 후렴')
  assert.strictEqual(result.sections[4], 'Chorus', '5연도 후렴')
  assert.strictEqual(result.sections[0], 'Verse', '1연은 절')
  assert.strictEqual(result.sections[2], 'Verse', '3연도 절')
})

check('붙인 태그가 가사 본문을 건드리지 않는다', () => {
  const result = autoTagLyrics(REAL)
  const stripped = result.text.replace(/^\[[^\]]+\]\n/gm, '')
  assert.strictEqual(stripped.replace(/\s/g, ''), REAL.replace(/\s/g, ''),
    '글자는 하나도 바뀌면 안 된다')
})

check('모든 연에 태그가 하나씩 붙는다', () => {
  const result = autoTagLyrics(REAL)
  const tags = result.text.match(/^\[[^\]]+\]$/gm) || []
  assert.strictEqual(tags.length, splitStanzas(REAL).length)
  assert.strictEqual(tags.length, 5, '이 가사는 5연이다')
})

check('이미 태그가 있으면 손대지 않는다', () => {
  const tagged = '[Verse]\n창문을 열면\n\n[Chorus]\n너와 함께'
  const result = autoTagLyrics(tagged)
  assert.strictEqual(result.tagged, false)
  assert.strictEqual(result.text, tagged)
  assert.deepStrictEqual(result.sections, ['Verse', 'Chorus'])
})

check('되풀이가 없으면 절과 후렴을 번갈아 놓는다', () => {
  const result = autoTagLyrics('첫째 연이다\n둘 줄\n\n아주 다른 둘째\n연이다\n\n또 다른 셋째\n연이다')
  assert.deepStrictEqual(result.sections.slice(0, 2), ['Verse', 'Chorus'])
})

check('빈 줄이 없으면 네 줄씩 끊는다', () => {
  const flat = ['한줄', '두줄', '세줄', '네줄', '다섯', '여섯', '일곱', '여덟'].join('\n')
  assert.strictEqual(splitStanzas(flat).length, 2)
  const result = autoTagLyrics(flat)
  assert.strictEqual((result.text.match(/^\[/gm) || []).length, 2)
})

check('한 덩어리면 [Verse] 하나로 둔다', () => {
  const result = autoTagLyrics('짧은 가사 한 줄')
  assert.strictEqual(result.text, '[Verse]\n짧은 가사 한 줄')
  assert.deepStrictEqual(result.sections, ['Verse'])
})

check('빈 가사는 그대로 둔다', () => {
  const result = autoTagLyrics('   ')
  assert.strictEqual(result.tagged, false)
})

check('닮음 재기가 한국어에서 동작한다', () => {
  assert.ok(similarity('별처럼 수 많은 사람들 그 중에 그대를 만나',
    '별처럼 수 많은 사람들 그 중에 서로를 만나') > 0.7, '후렴 변주는 닮은 것으로 봐야 한다')
  assert.ok(similarity('그렇게 대단한 운명까진',
    '별처럼 수 많은 사람들') < 0.3, '다른 연은 안 닮아야 한다')
  assert.strictEqual(similarity('같은 글', '같은  글!'), 1, '띄어쓰기·문장부호는 무시한다')
})

check('태그 이름이 모델이 아는 것들뿐이다', () => {
  const allowed = new Set(['Intro', 'Verse', 'Pre-Chorus', 'Chorus', 'Bridge', 'Outro'])
  for (const name of autoTagLyrics(REAL).sections) {
    assert.ok(allowed.has(name), `모르는 태그: ${name}`)
  }
})

console.log(failures ? `\n${failures}개 실패` : '\n전부 통과')
process.exit(failures ? 1 : 0)
