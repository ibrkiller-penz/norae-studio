// icon.png 을 만든다. 그림 도구나 외부 꾸러미 없이 Node 만으로 PNG 를 직접 쓴다.
// 로고는 renderer/index.html 안의 SVG 와 같은 모양이다: 보라→분홍 둥근 사각형에 음표 두 개.
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 512
const RADIUS = 112 // 512 기준 모서리 둥글기 (SVG 의 56/256 과 같은 비율)
const AA = 2       // 가장자리 계단을 없애려고 2배로 그린 뒤 줄인다

const here = path.dirname(fileURLToPath(import.meta.url))

const lerp = (a, b, t) => a + (b - a) * t
const clamp01 = (v) => Math.min(1, Math.max(0, v))

// 둥근 사각형 안쪽인지
function insideRounded (x, y, size, radius) {
  const cx = Math.min(Math.max(x, radius), size - radius)
  const cy = Math.min(Math.max(y, radius), size - radius)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= radius * radius
}

// 선분 (x1,y1)-(x2,y2) 까지의 거리 — 음표 기둥을 그리는 데 쓴다
function distToSegment (px, py, x1, y1, x2, y2) {
  const vx = x2 - x1
  const vy = y2 - y1
  const len2 = vx * vx + vy * vy
  const t = len2 ? clamp01(((px - x1) * vx + (py - y1) * vy) / len2) : 0
  const dx = px - (x1 + t * vx)
  const dy = py - (y1 + t * vy)
  return Math.hypot(dx, dy)
}

function render (size) {
  const scale = size / 256 // SVG 좌표계(256)를 그대로 쓰기 위한 배율
  const px = (v) => v * scale
  const stem = px(18) / 2      // 기둥 굵기의 절반
  const pixels = new Uint8Array(size * size * 4)

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4
      if (!insideRounded(x + 0.5, y + 0.5, size, RADIUS * (size / SIZE))) {
        pixels[i + 3] = 0 // 모서리 바깥은 투명
        continue
      }
      // 배경: 왼쪽 위 보라(#7c5cff) → 오른쪽 아래 분홍(#ff5c9d)
      const t = clamp01((x / size + y / size) / 2)
      let r = lerp(0x7c, 0xff, t)
      let g = lerp(0x5c, 0x5c, t)
      let b = lerp(0xff, 0x9d, t)

      // 음표: 기둥 두 개 + 이음선 + 머리 두 개 (흰색)
      const cx = x + 0.5
      const cy = y + 0.5
      const onStemLeft = distToSegment(cx, cy, px(96), px(176), px(96), px(80)) <= stem
      const onBeam = distToSegment(cx, cy, px(96), px(80), px(180), px(62)) <= stem
      const onStemRight = distToSegment(cx, cy, px(180), px(62), px(180), px(158)) <= stem
      const headLeft = Math.hypot(cx - px(80), cy - px(180)) <= px(20)
      const headRight = Math.hypot(cx - px(164), cy - px(162)) <= px(20)

      if (onStemLeft || onBeam || onStemRight || headLeft || headRight) {
        r = g = b = 255
      }
      pixels[i] = Math.round(r)
      pixels[i + 1] = Math.round(g)
      pixels[i + 2] = Math.round(b)
      pixels[i + 3] = 255
    }
  }
  return pixels
}

// AA 배로 그린 그림을 평균 내어 목표 크기로 줄인다
function downscale (src, from, to) {
  const factor = from / to
  const out = new Uint8Array(to * to * 4)
  for (let y = 0; y < to; y += 1) {
    for (let x = 0; x < to; x += 1) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < factor; sy += 1) {
        for (let sx = 0; sx < factor; sx += 1) {
          const i = ((y * factor + sy) * from + (x * factor + sx)) * 4
          const alpha = src[i + 3] / 255
          r += src[i] * alpha
          g += src[i + 1] * alpha
          b += src[i + 2] * alpha
          a += src[i + 3]
        }
      }
      const n = factor * factor
      const alphaSum = a / 255
      const o = (y * to + x) * 4
      out[o] = alphaSum ? Math.round(r / alphaSum) : 0
      out[o + 1] = alphaSum ? Math.round(g / alphaSum) : 0
      out[o + 2] = alphaSum ? Math.round(b / alphaSum) : 0
      out[o + 3] = Math.round(a / n)
    }
  }
  return out
}

// ── PNG 쓰기 ──────────────────────────────────────────────────────────────────
function crc32 (buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i]
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk (type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

function writePng (file, pixels, size) {
  // 각 줄 앞에 필터 바이트(0 = 필터 없음)를 붙인다 — PNG 형식 규칙
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0
    Buffer.from(pixels.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8  // 비트 깊이
  ihdr[9] = 6  // 색 종류: RGBA
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]))
}

const big = render(SIZE * AA)
const pixels = downscale(big, SIZE * AA, SIZE)
const out = path.join(here, 'icon.png')
writePng(out, pixels, SIZE)
console.log('icon.png 생성:', out, fs.statSync(out).size, 'bytes')
