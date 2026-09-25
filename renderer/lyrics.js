'use strict'
// 가사에 구간 태그를 붙인다.
//
// YuE2 는 가사의 [Verse]/[Chorus] 와 악보의 % verse/% chorus 를 짝지어 "어느 대목을
// 어디서 부를지" 정한다. 태그 없이 줄글만 주면 붙일 자리를 모른다. 실제로 태그 없는
// 가사로 만든 커버는 가사가 전혀 맞지 않았다.
//
// 그래서 가사를 붙여 넣으면 구조를 알아서 잡아 준다. 규칙은 단순하다.
//   1. 빈 줄로 연을 나눈다
//   2. 비슷한 연이 두 번 이상 나오면 그게 후렴이다 (후렴은 되풀이된다)
//   3. 되풀이가 없으면 절과 후렴을 번갈아 놓는다 (대중가요의 기본 꼴)
//   4. 후렴 직전의 짧은 연은 프리코러스
//   5. 뒤쪽에 딱 한 번만 나오는 남는 연은 브릿지
//
// 맞히지 못할 수도 있다. 그래서 결과를 가사칸에 그대로 써서 사람이 고칠 수 있게 둔다.

const SECTION_LINE = /^\s*\[[^\]]+\]\s*$/m

// 견주기 전에 군더더기를 없앤다. 띄어쓰기·문장부호·대소문자는 같고 다름에 상관없다.
function normalize (text) {
  return text.replace(/[\s.,!?~…"'’”·-]/g, '').toLowerCase()
}

// 두 글뭉치가 얼마나 닮았는지 0~1 로. 글자 두 개씩 끊어 겹치는 비율을 본다(Dice).
// 한국어는 띄어쓰기가 들쭉날쭉해서 낱말 단위보다 글자쌍 단위가 안정적이다.
function similarity (a, b) {
  const x = normalize(a)
  const y = normalize(b)
  if (!x || !y) return 0
  if (x === y) return 1
  if (x.length < 2 || y.length < 2) return x === y ? 1 : 0

  const pairs = (text) => {
    const out = new Map()
    for (let i = 0; i < text.length - 1; i += 1) {
      const key = text.slice(i, i + 2)
      out.set(key, (out.get(key) || 0) + 1)
    }
    return out
  }
  const left = pairs(x)
  const right = pairs(y)
  let shared = 0
  for (const [key, count] of left) {
    const other = right.get(key)
    if (other) shared += Math.min(count, other)
  }
  return (2 * shared) / ((x.length - 1) + (y.length - 1))
}

// 빈 줄로 연을 나눈다. 빈 줄이 없으면 네 줄씩 끊는다.
function splitStanzas (raw) {
  const text = raw.replace(/\r\n/g, '\n').trim()
  if (!text) return []
  const byBlank = text.split(/\n\s*\n+/).map((s) => s.trim()).filter(Boolean)
  if (byBlank.length > 1) return byBlank

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const out = []
  for (let i = 0; i < lines.length; i += 4) out.push(lines.slice(i, i + 4).join('\n'))
  return out
}

const CHORUS_SIMILARITY = 0.5 // 이만큼 닮으면 같은 후렴으로 본다
const MIN_COMPARE_LENGTH = 12 // 너무 짧은 연은 우연히 닮아 보인다. 견주지 않는다

const firstLine = (stanza) => stanza.split('\n').find((l) => l.trim()) || ''

/**
 * 두 연이 같은 후렴인지 본다.
 *
 * 후렴은 되풀이되되 똑같지는 않다. "별처럼 수 많은 사람들 그 중에 *그대를* 만나" 와
 * "... 그 중에 *서로를* 만나" 처럼 첫 줄(훅)은 같고 뒤는 바뀐다. 연 전체만 견주면
 * 이런 변주를 놓치므로, 첫 줄끼리도 견줘 둘 중 높은 쪽을 쓴다.
 */
function stanzaSimilarity (a, b) {
  if (normalize(a).length < MIN_COMPARE_LENGTH || normalize(b).length < MIN_COMPARE_LENGTH) {
    return normalize(a) === normalize(b) ? 1 : 0
  }
  return Math.max(similarity(a, b), similarity(firstLine(a), firstLine(b)))
}

/**
 * 가사에 구간 태그를 붙인다.
 * @returns {{text: string, tagged: boolean, sections: string[], note: string}}
 */
function autoTagLyrics (raw) {
  const original = (raw || '').replace(/\r\n/g, '\n')
  if (!original.trim()) return { text: original, tagged: false, sections: [], note: '' }

  // 이미 태그가 있으면 손대지 않는다. 사람이 적은 것이 우선이다.
  if (SECTION_LINE.test(original)) {
    const sections = [...original.matchAll(/^\s*\[([^\]]+)\]\s*$/gm)].map((m) => m[1])
    return { text: original, tagged: false, sections, note: '이미 구간 태그가 있어 그대로 두었습니다.' }
  }

  const stanzas = splitStanzas(original)
  if (stanzas.length === 0) return { text: original, tagged: false, sections: [], note: '' }
  if (stanzas.length === 1) {
    return {
      text: `[Verse]\n${stanzas[0]}`,
      tagged: true,
      sections: ['Verse'],
      note: '한 덩어리라 [Verse] 하나로 두었습니다.'
    }
  }

  // 되풀이되는 연을 찾는다. 그게 후렴이다.
  const groups = []            // 서로 닮은 연들의 묶음
  const groupOf = new Array(stanzas.length).fill(-1)
  stanzas.forEach((stanza, index) => {
    for (let g = 0; g < groups.length; g += 1) {
      if (stanzaSimilarity(stanzas[groups[g][0]], stanza) >= CHORUS_SIMILARITY) {
        groups[g].push(index)
        groupOf[index] = g
        return
      }
    }
    groupOf[index] = groups.length
    groups.push([index])
  })

  const repeated = groups.filter((g) => g.length >= 2)
  const labels = new Array(stanzas.length).fill(null)
  let note = ''

  if (repeated.length) {
    // 가장 많이 되풀이되는 묶음이 후렴. 같은 수면 뒤쪽에 나오는 쪽을 고른다.
    repeated.sort((a, b) => b.length - a.length || b[0] - a[0])
    for (const index of repeated[0]) labels[index] = 'Chorus'
    note = `되풀이되는 연 ${repeated[0].length}개를 후렴으로 봤습니다.`
  } else {
    // 되풀이가 없으면 절·후렴을 번갈아 놓는다.
    stanzas.forEach((_s, index) => { labels[index] = index % 2 === 0 ? 'Verse' : 'Chorus' })
    note = '되풀이되는 대목이 없어 절과 후렴을 번갈아 놓았습니다.'
  }

  // 남은 자리를 채운다.
  const lineCount = (stanza) => stanza.split('\n').filter((l) => l.trim()).length
  const lastChorus = labels.lastIndexOf('Chorus')

  stanzas.forEach((stanza, index) => {
    if (labels[index]) return
    const nextIsChorus = labels[index + 1] === 'Chorus'
    if (nextIsChorus && lineCount(stanza) <= 2) {
      labels[index] = 'Pre-Chorus'           // 후렴 직전의 짧은 연
    } else if (index > lastChorus && lastChorus !== -1) {
      labels[index] = 'Outro'                // 마지막 후렴 뒤
    } else if (index >= stanzas.length * 0.6) {
      labels[index] = 'Bridge'               // 뒤쪽에 한 번만 나오는 연
    } else {
      labels[index] = 'Verse'
    }
  })

  // 브릿지가 여럿이면 앞쪽 것은 절로 되돌린다. 브릿지는 보통 하나다.
  let bridgeSeen = false
  for (let i = stanzas.length - 1; i >= 0; i -= 1) {
    if (labels[i] !== 'Bridge') continue
    if (bridgeSeen) labels[i] = 'Verse'
    bridgeSeen = true
  }

  const text = stanzas.map((stanza, index) => `[${labels[index]}]\n${stanza}`).join('\n\n')
  return { text, tagged: true, sections: labels, note }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { autoTagLyrics, similarity, stanzaSimilarity, splitStanzas }
}
