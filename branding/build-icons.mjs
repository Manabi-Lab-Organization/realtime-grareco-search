
import sharp from 'sharp'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const at = (p) => join(root, p)

const COLORS = { bg: '#1B6FB3', wave: '#FFFFFF', line: '#F5C04A' }

const GLYPH = `
<g stroke-linecap="round" fill="none">
  <g stroke="${COLORS.wave}" stroke-width="7">
    <line x1="20" y1="54" x2="20" y2="70"/>
    <line x1="32" y1="40" x2="32" y2="84"/>
    <line x1="44" y1="48" x2="44" y2="76"/>
    <line x1="56" y1="56" x2="56" y2="68"/>
  </g>
  <circle cx="84" cy="58" r="19" stroke="${COLORS.wave}" stroke-width="7"/>
  <path d="M72 59 q6 -13 12 0 t12 0" stroke="${COLORS.line}" stroke-width="5"/>
  <line x1="98" y1="72" x2="108" y2="82" stroke="${COLORS.wave}" stroke-width="8"/>
</g>`

const LABEL = 'Realtime GraReco &amp; Search'
const svg = (bg, glyph = GLYPH) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 125 125" width="125" height="125" role="img" aria-label="${LABEL}">${bg}${glyph}</svg>`

const square = svg(`<rect width="125" height="125" fill="${COLORS.bg}"/>`)
const rounded = svg(`<rect width="125" height="125" rx="25" fill="${COLORS.bg}"/>`)
const circle = svg(`<circle cx="62.5" cy="62.5" r="60" fill="${COLORS.bg}"/>`, `<g transform="translate(10 10) scale(0.84)">${GLYPH}</g>`)

const png = (src, size, { opaque = false } = {}) => {
  let img = sharp(Buffer.from(src), { density: (72 * size) / 125 }).resize(size, size)
  if (opaque) img = img.flatten({ background: COLORS.bg }).removeAlpha()
  return img.png().toBuffer()
}

const ico = (pngs) => {
  const head = Buffer.alloc(6 + 16 * pngs.length)
  head.writeUInt16LE(0, 0)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(pngs.length, 4)
  let offset = head.length
  pngs.forEach(({ size, buf }, i) => {
    const e = 6 + 16 * i
    head.writeUInt8(size >= 256 ? 0 : size, e)
    head.writeUInt8(size >= 256 ? 0 : size, e + 1)
    head.writeUInt16LE(1, e + 4)
    head.writeUInt16LE(32, e + 6)
    head.writeUInt32LE(buf.length, e + 8)
    head.writeUInt32LE(offset, e + 12)
    offset += buf.length
  })
  return Buffer.concat([head, ...pngs.map((p) => p.buf)])
}

const write = (p, data) => {
  writeFileSync(at(p), data)
  console.log(`✓ ${p}`)
}

const ios = await png(square, 1024, { opaque: true })
write('mobile-app/resources/icon-ios.png', ios)
write('mobile-app/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', ios)

const splashIcon = await png(rounded, 480)
const splash = await sharp({ create: { width: 2732, height: 2732, channels: 3, background: '#FFFFFF' } })
  .composite([{ input: splashIcon, gravity: 'center' }])
  .png()
  .toBuffer()
for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
  write(`mobile-app/ios/App/App/Assets.xcassets/Splash.imageset/${name}`, splash)
}

write('client/public/favicon.svg', circle)
write('mobile-app/public/favicon.svg', circle)
write('client/public/apple-touch-icon.svg', rounded)
write('client/public/favicon.png', await png(circle, 32))
write('client/public/favicon.ico', ico([{ size: 48, buf: await png(circle, 48) }]))
write('client/public/apple-touch-icon.png', await png(square, 180, { opaque: true }))
write('client/public/icon-192.png', await png(rounded, 192))
write('client/public/icon-512.png', await png(rounded, 512))

write('electron-app/resources/icon.png', await png(rounded, 512))
const icoSizes = [16, 24, 32, 48, 64, 256]
write('electron-app/resources/icon.ico', ico(await Promise.all(icoSizes.map(async (size) => ({ size, buf: await png(rounded, size) })))))

const work = mkdtempSync(join(tmpdir(), 'grareco-icon-'))
const set = join(work, 'icon.iconset')
execFileSync('mkdir', [set])
for (const size of [16, 32, 128, 256, 512]) {
  writeFileSync(join(set, `icon_${size}x${size}.png`), await png(rounded, size))
  writeFileSync(join(set, `icon_${size}x${size}@2x.png`), await png(rounded, size * 2))
}
execFileSync('iconutil', ['-c', 'icns', set, '-o', at('electron-app/resources/icon.icns')])
rmSync(work, { recursive: true, force: true })
console.log('✓ electron-app/resources/icon.icns')
