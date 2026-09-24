'use strict'
// electron/speed.js 확인. Electron 없이 그냥 `node electron/speed.test.js` 로 돌린다.
// 시계를 손으로 굴려서, 실제 곡 하나(RTX 4060 실측)와 같은 이벤트 흐름을 흉내낸다.

const assert = require('node:assert')
const { Meter, blend } = require('./speed')

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

// 손으로 굴리는 시계
function fakeClock () {
  let t = 1000000
  const now = () => t
  now.advance = (seconds) => { t += seconds * 1000 }
  return now
}

const close = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} 이(가) ${expected} ±${tolerance} 밖에 있음`)

// 2026-09-24 RTX 4060 에서 실제로 잰 곡:
//   시작 → 20.1s plan 시작 → 45.3s load 시작 → 46.1s load 끝 → 71.9s plan 끝
//   → 93.2s semantic 끝(872토큰) → 124.4s synth 끝 → 130.0s decode 끝
function runRealSong (now) {
  const meter = new Meter(now)
  meter.reset()

  now.advance(20.1)
  meter.track({ type: 'stage', stage: 'plan', status: 'start' })
  now.advance(25.2)
  meter.track({ type: 'stage', stage: 'load', status: 'start' })
  now.advance(0.8)
  meter.track({ type: 'stage', stage: 'load', status: 'done' })
  now.advance(25.8)
  meter.track({ type: 'progress', stage: 'plan', tokens: 640 })
  meter.track({ type: 'stage', stage: 'plan', status: 'done', abc: 'X:1' })

  meter.track({ type: 'stage', stage: 'semantic', status: 'start' })
  now.advance(21.3)
  meter.track({ type: 'progress', stage: 'semantic', tokens: 860 })
  meter.track({ type: 'stage', stage: 'semantic', status: 'done', tokens: 872 })

  meter.track({ type: 'stage', stage: 'synth', status: 'start' })
  now.advance(31.2)
  meter.track({ type: 'progress', stage: 'synth', step: 32, steps: 32 })
  meter.track({ type: 'stage', stage: 'synth', status: 'done' })

  meter.track({ type: 'stage', stage: 'decode', status: 'start' })
  now.advance(5.6)
  meter.track({ type: 'stage', stage: 'decode', status: 'done' })
  return meter
}

console.log('speed.js')

check('모델 적재 시간을 plan 단계에서 빼낸다', () => {
  const meter = runRealSong(fakeClock())
  // plan 은 벽시계로 51.8초였지만 그중 0.8초는 모델 적재다.
  close(meter.seconds.plan, 51.0, 0.05, 'plan 초')
  close(meter.loadSeconds, 0.8, 0.05, 'load 초')
  close(meter.startup, 20.1, 0.05, 'startup 초')
})

check('단계별 시간과 토큰 수를 제대로 담는다', () => {
  const meter = runRealSong(fakeClock())
  close(meter.seconds.semantic, 21.3, 0.05, 'semantic 초')
  close(meter.seconds.synth, 31.2, 0.05, 'synth 초')
  close(meter.seconds.decode, 5.6, 0.05, 'decode 초')
  assert.strictEqual(meter.tokensBy.semantic, 872, 'semantic 토큰은 done 이벤트 값을 쓴다')
  assert.strictEqual(meter.tokensBy.plan, 640, 'plan 토큰은 마지막 progress 값을 쓴다')
})

check('첫 곡은 실측값을 그대로 받는다', () => {
  const meter = runRealSong(fakeClock())
  const learned = blend(null, meter, { plan: 700, semantic: 1500 })
  close(learned.semantic, 872 / 21.3, 0.1, 'semantic 초당 토큰')   // ≈ 40.9
  close(learned.synthPerToken, 31.2 / 872, 0.001, 'synth 토큰당 초') // ≈ 0.0358
  close(learned.decode, 5.6, 0.05, 'decode 초')
  close(learned.load, 20.9, 0.05, 'load 초 (구성 + 적재)')
  close(learned.semanticTokenFactor, 872 / 1500, 0.01, 'semantic 토큰 보정')
  assert.strictEqual(learned.samples, 1)
})

check('보정이 스스로 풀리지 않는다 (같은 곡을 다섯 번)', () => {
  // 화면은 늘 "보정 전" 예측을 보낸다. 그래서 비율은 매번 같은 값이어야 하고,
  // 1 로 수렴해 버리면 안 된다.
  let learned = null
  for (let i = 0; i < 5; i += 1) {
    learned = blend(learned, runRealSong(fakeClock()), { plan: 700, semantic: 1500 })
  }
  close(learned.semanticTokenFactor, 872 / 1500, 0.001, '다섯 번 뒤 semantic 보정')
  close(learned.semantic, 872 / 21.3, 0.001, '다섯 번 뒤 semantic 속도')
  assert.strictEqual(learned.samples, 5)
})

check('새 표본 쪽으로 서서히 움직인다', () => {
  const slow = { semantic: 20, samples: 1 }
  const learned = blend(slow, runRealSong(fakeClock()), { plan: 700, semantic: 1500 })
  const measured = 872 / 21.3 // ≈ 40.9
  // 표본 2개째라 절반만큼 움직인다.
  close(learned.semantic, 20 + (measured - 20) / 2, 0.1, '두 번째 표본 혼합')
  assert.ok(learned.semantic > 20 && learned.semantic < measured, '두 값 사이에 있어야 한다')
})

check('두 번째 곡은 적재 시간을 배우지 않는다 (모델이 이미 올라가 있다)', () => {
  const now = fakeClock()
  const meter = new Meter(now)
  meter.reset()
  now.advance(0.4) // 파이프라인이 이미 살아 있어 바로 시작한다
  meter.track({ type: 'stage', stage: 'plan', status: 'start' })
  now.advance(50)
  meter.track({ type: 'progress', stage: 'plan', tokens: 640 })
  meter.track({ type: 'stage', stage: 'plan', status: 'done' })

  const before = { load: 20.9, samples: 1 }
  const learned = blend(before, meter, { plan: 700, semantic: 1500 })
  close(learned.load, 20.9, 0.001, 'load 는 그대로여야 한다')
})

check('이어 만들기: 건너뛴 단계는 재지 않는다', () => {
  const now = fakeClock()
  const meter = new Meter(now)
  meter.reset()
  // plan 과 semantic 은 디스크에서 읽어 done 만 온다 — 시작을 못 봤으니 버려야 한다.
  meter.track({ type: 'stage', stage: 'plan', status: 'done', abc: 'X:1' })
  meter.track({ type: 'stage', stage: 'semantic', status: 'done', tokens: 872 })
  meter.track({ type: 'stage', stage: 'synth', status: 'start' })
  now.advance(31.2)
  meter.track({ type: 'stage', stage: 'synth', status: 'done' })

  assert.strictEqual(meter.seconds.plan, undefined, 'plan 시간은 없어야 한다')
  assert.strictEqual(meter.seconds.semantic, undefined, 'semantic 시간은 없어야 한다')
  close(meter.seconds.synth, 31.2, 0.05, 'synth 시간은 재야 한다')

  // 토큰 수를 모르니 synth 도 배울 수 없다. 옛 값이 그대로 남아야 한다.
  const before = { semantic: 41, synthPerToken: 0.0358, samples: 3 }
  const learned = blend(before, meter, { plan: 700, semantic: 1500 })
  close(learned.semantic, 41, 0.001, 'semantic 속도는 그대로')
  close(learned.synthPerToken, 0.0358, 0.0001, 'synth 값도 그대로')
})

check('0 이나 NaN 이 평균을 망가뜨리지 않는다', () => {
  const now = fakeClock()
  const meter = new Meter(now)
  meter.reset()
  meter.track({ type: 'stage', stage: 'decode', status: 'start' })
  meter.track({ type: 'stage', stage: 'decode', status: 'done' }) // 0초
  const before = { decode: 5.6, semantic: 41, samples: 2 }
  const learned = blend(before, meter, null)
  close(learned.decode, 5.6, 0.001, '0초는 무시해야 한다')
  close(learned.semantic, 41, 0.001, '안 잰 값은 그대로')
})

console.log(failures ? `\n${failures}개 실패` : '\n전부 통과')
process.exit(failures ? 1 : 0)
