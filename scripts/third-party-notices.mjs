#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyright)([.-].*)?$/i

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (key.startsWith('--')) args[key.slice(2)] = argv[++i]
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (!args.app || (!args.out && !args['collect-swift'])) {
  console.error('使い方: node third-party-notices.mjs --app <アプリのディレクトリ> --out <出力ファイル>')
  console.error('      node third-party-notices.mjs --app <アプリのディレクトリ> --collect-swift <SourcePackages/checkouts>')
  process.exit(1)
}
const appDir = path.resolve(args.app)
const appPkg = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8'))
const cfg = appPkg.thirdPartyNotices ?? {}

function swiftPins() {
  const sp = cfg.swiftPackages
  if (!sp) return []
  const resolved = JSON.parse(readFileSync(path.join(appDir, sp.resolved), 'utf8'))
  const pins = resolved.pins ?? resolved.object?.pins ?? []
  return pins
    .map((p) => ({
      identity: p.identity ?? p.package,
      location: (p.location ?? p.repositoryURL ?? '').replace(/\.git$/, ''),
      version: p.state?.version ?? p.state?.revision ?? '',
    }))
    .sort((a, b) => a.identity.localeCompare(b.identity))
}

if (args['collect-swift']) {
  const checkouts = path.resolve(args['collect-swift'])
  const licenseDir = path.join(appDir, cfg.swiftPackages.licenseDir)
  mkdirSync(licenseDir, { recursive: true })
  const dirs = readdirSync(checkouts)
  let failed = false
  for (const pin of swiftPins()) {
    const name = dirs.find((d) => d.toLowerCase() === pin.identity.toLowerCase())
    const texts = name ? licenseTexts(path.join(checkouts, name)) : []
    if (texts.length === 0) {
      console.error(`[third-party-notices] ${pin.identity} のライセンス本文が ${checkouts} に見つかりません`)
      failed = true
      continue
    }
    const body = texts.map(({ file, text }) => (texts.length > 1 ? `--- ${file} ---\n${text}` : text)).join('\n\n')
    writeFileSync(path.join(licenseDir, `${pin.identity}.txt`), `${body}\n`)
  }
  if (failed) process.exit(1)
  console.log(`[third-party-notices] Swift パッケージのライセンスを ${path.relative(process.cwd(), licenseDir)} に取り込みました`)
  process.exit(0)
}
const outFile = path.resolve(appDir, args.out)

function resolvePackageDir(name, fromDir) {
  let dir = fromDir
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name)
    if (existsSync(path.join(candidate, 'package.json'))) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function readPkg(dir) {
  return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
}

function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type
  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses.map((l) => (typeof l === 'string' ? l : l?.type)).filter(Boolean).join(' OR ')
  }
  return '（package.json に記載なし）'
}

function sourceUrlOf(pkg) {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  if (repo) {
    let url = repo.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://')
    url = url.replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/').replace(/^git@github\.com:/, 'https://github.com/')
    if (/^github:/.test(url)) url = `https://github.com/${url.slice('github:'.length)}`
    if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`
    return url
  }
  return typeof pkg.homepage === 'string' ? pkg.homepage : ''
}

function licenseTexts(dir) {
  const files = readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f) && statSync(path.join(dir, f)).isFile())
    .sort()
  return files.map((f) => ({ file: f, text: readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim() }))
}

const found = new Map()
const missing = []

function visit(name, fromDir, { withDeps, optional }) {
  const dir = resolvePackageDir(name, fromDir)
  if (!dir) {
    if (!optional) missing.push(name)
    return
  }
  const pkg = readPkg(dir)
  const key = `${pkg.name}@${pkg.version}`
  const seen = found.get(key)
  if (seen && (seen.withDeps || !withDeps)) return
  found.set(key, { dir, pkg, withDeps })
  if (!withDeps) return
  for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, dir, { withDeps: true, optional: false })
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) visit(dep, dir, { withDeps: true, optional: true })
}

const exclude = new Set(cfg.exclude ?? [])
for (const name of Object.keys(appPkg.dependencies ?? {})) {
  if (!exclude.has(name)) visit(name, appDir, { withDeps: true, optional: false })
}
for (const name of cfg.include ?? []) visit(name, appDir, { withDeps: true, optional: false })
for (const name of cfg.includeWithoutDeps ?? []) visit(name, appDir, { withDeps: false, optional: false })

if (missing.length > 0) {
  console.error(`[third-party-notices] node_modules に見つからないパッケージがあります: ${[...new Set(missing)].join(', ')}`)
  console.error('先に npm ci を実行してください。')
  process.exit(1)
}

const entries = [...found.values()].sort((a, b) =>
  a.pkg.name === b.pkg.name ? a.pkg.version.localeCompare(b.pkg.version) : a.pkg.name.localeCompare(b.pkg.name)
)

const RULE = '='.repeat(78)
const lines = []
const title = cfg.title ?? appPkg.productName ?? appPkg.name
lines.push(`${title} に同梱しているライブラリのライセンス表示`)
lines.push('')
lines.push('このアプリには、次のオープンソースのライブラリが含まれています。')
lines.push('各ライブラリの著作権表示とライセンス本文を、ライブラリに含まれていたまま載せています。')
for (const note of cfg.notes ?? []) lines.push(note)
lines.push('')
lines.push(`ライブラリの数: ${entries.length + swiftPins().length}`)
lines.push('')

for (const { dir, pkg } of entries) {
  const license = licenseOf(pkg)
  const source = sourceUrlOf(pkg)
  lines.push(RULE)
  lines.push(`${pkg.name} ${pkg.version}`)
  lines.push(`ライセンス: ${license}`)
  if (source) lines.push(`入手先: ${source}`)
  if (/MPL/i.test(license)) {
    lines.push('このライブラリは Mozilla Public License 2.0（MPL-2.0）で提供されています。')
    lines.push('ライセンス本文: https://mozilla.org/MPL/2.0/')
    lines.push(`ソースコードの入手先: https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}${source ? `（リポジトリ: ${source}）` : ''}`)
  }
  lines.push(RULE)
  const texts = licenseTexts(dir)
  if (texts.length === 0) {
    lines.push(`（このライブラリにはライセンス本文のファイルが含まれていません。ライセンスは ${license} です）`)
  }
  for (const { file, text } of texts) {
    if (texts.length > 1) lines.push(`--- ${file} ---`)
    lines.push(text)
    lines.push('')
  }
  lines.push('')
}

const pins = swiftPins()
if (pins.length > 0) {
  const licenseDir = path.join(appDir, cfg.swiftPackages.licenseDir)
  const lacking = pins.filter((p) => !existsSync(path.join(licenseDir, `${p.identity}.txt`)))
  if (lacking.length > 0) {
    console.error(`[third-party-notices] Swift パッケージのライセンス本文がありません: ${lacking.map((p) => p.identity).join(', ')}`)
    console.error('Xcode でパッケージを解決したあと、--collect-swift で取り込んでください（docs/releasing.md の「iPhone」を参照）。')
    process.exit(1)
  }
  lines.push(RULE)
  lines.push('iPhone アプリに組み込んでいる Swift パッケージ')
  lines.push(RULE)
  lines.push('')
  for (const pin of pins) {
    lines.push(RULE)
    lines.push(`${pin.identity} ${pin.version}`)
    if (pin.location) lines.push(`入手先: ${pin.location}`)
    lines.push(RULE)
    lines.push(readFileSync(path.join(licenseDir, `${pin.identity}.txt`), 'utf8').trim())
    lines.push('')
    lines.push('')
  }
}

mkdirSync(path.dirname(outFile), { recursive: true })
writeFileSync(outFile, lines.join('\n'))
console.log(`[third-party-notices] ${entries.length + pins.length} 件を ${path.relative(process.cwd(), outFile)} に書き出しました`)
