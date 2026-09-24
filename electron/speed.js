'use strict'
// 이 컴퓨터가 곡 하나를 만드는 데 실제로 얼마나 걸리는지 재고, 그 값을 평균에 섞는다.
//
// 진행률 막대의 "남은 시간"은 그래픽카드가 얼마나 빠른지에 달렸다. 값을 상수로 박아두면
// 카드가 다를 때 두 배씩 어긋난다. 그래서 곡마다 재서 settings.json 에 쌓고 다음 추정에 쓴다.
//
// Electron 에 기대지 않는 순수 모듈이라 따로 돌려볼 수 있다(speed.test.js).

const SAMPLES_CAP = 8 // 표본이 이만큼 쌓이면 새 표본의 영향력이 1/8 로 고정된다

/** 워커가 올리는 이벤트를 받아 단계별 시간과 토큰 수를 주워 담는다. */
class Meter {
  constructor (now = Date.now) {
    this.now = now
    this.reset()
  }

  reset () {
    this.jobStart = this.now()
    this.startup = null // 작업 시작 → 첫 단계 (파이프라인 구성 비용)
    this.stage = null
    this.stageT0 = 0
    this.loadT0 = 0
    this.loadSeconds = 0
    this.tokens = 0
    this.seconds = {}
    this.tokensBy = {}
  }

  track (event) {
    if (!event) return

    if (event.type === 'progress') {
      if (event.tokens) this.tokens = event.tokens
      return
    }
    if (event.type !== 'stage') return

    // 모델 적재는 plan 단계 안에서 일어난다. 따로 재고, 감싸는 단계에서는 빼준다.
    if (event.stage === 'load') {
      if (event.status === 'start') {
        this.loadT0 = this.now()
      } else if (this.loadT0) {
        const took = this.now() - this.loadT0
        this.loadSeconds = took / 1000
        this.stageT0 += took
        this.loadT0 = 0
      }
      return
    }

    if (event.status === 'start') {
      if (this.startup === null) this.startup = (this.now() - this.jobStart) / 1000
      this.stage = event.stage
      this.stageT0 = this.now()
      this.tokens = 0
      return
    }

    // 이어 만들기는 이미 끝난 단계를 디스크에서 읽고 done 만 보낸다.
    // 시작을 못 본 단계는 시간을 잴 수 없으니 버린다.
    if (this.stage !== event.stage) return
    this.seconds[event.stage] = (this.now() - this.stageT0) / 1000
    this.tokensBy[event.stage] = event.tokens || this.tokens
    this.stage = null
    this.tokens = 0
  }
}

const ratio = (actual, divisor) =>
  (Number.isFinite(actual) && Number.isFinite(divisor) && actual > 0 && divisor > 0)
    ? actual / divisor
    : NaN

/**
 * 이번 곡에서 잰 값을 기존 평균에 섞는다.
 * 표본이 적을 땐 크게 움직이고, 쌓일수록 조금씩만 움직인다.
 *
 * @param old     지금까지 쌓인 값 (settings.speed)
 * @param meter   이번 곡을 잰 Meter
 * @param predict 화면이 보낸 "보정 전" 토큰 예측 {plan, semantic}
 */
function blend (old, meter, predict) {
  const previous = old || {}
  const n = Math.min((previous.samples || 0) + 1, SAMPLES_CAP)
  const mix = (before, next) => !Number.isFinite(next) || next <= 0
    ? (before ?? null)
    : (before == null ? next : before + (next - before) / n)

  const planTokens = meter.tokensBy.plan || 0
  const semTokens = meter.tokensBy.semantic || 0

  return {
    // 초당 토큰
    plan: mix(previous.plan, ratio(planTokens, meter.seconds.plan)),
    semantic: mix(previous.semantic, ratio(semTokens, meter.seconds.semantic)),
    // 노래 토큰 하나당 합성에 걸리는 초
    synthPerToken: mix(previous.synthPerToken, ratio(meter.seconds.synth, semTokens)),
    decode: mix(previous.decode, meter.seconds.decode),
    // 적재 비용은 모델을 실제로 올린 곡에서만 배운다. 두 번째 곡부터는 0 이라 평균을 망친다.
    load: mix(previous.load, meter.loadSeconds > 0 ? (meter.startup || 0) + meter.loadSeconds : NaN),
    // 가사 길이 → 토큰 수 어림식도 같이 보정한다. predict 는 보정을 적용하기 전 원값이라야
    // 비율이 한 번 맞춰진 뒤 1 로 수렴해 보정이 스스로 풀리는 일이 없다.
    planTokenFactor: mix(previous.planTokenFactor, ratio(planTokens, predict && predict.plan)),
    semanticTokenFactor: mix(previous.semanticTokenFactor, ratio(semTokens, predict && predict.semantic)),
    samples: (previous.samples || 0) + 1
  }
}

module.exports = { Meter, blend, SAMPLES_CAP }
