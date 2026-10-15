/**
 * Boot smoke test: install this package into a real dsh profile that also
 * carries dsh-base, boot the headless app against a scripted local LLM, and
 * check that the plugin mounted, registered its tools, contributed its prompt
 * section, executed define/assert/query with inference, and persisted.
 *
 * This is the test the unit suite cannot be: it exercises cordis.patch.yml,
 * the storage stack dsh-base ships, and the tool pipeline end to end, with no
 * network and no API key.
 *
 * Environment:
 *   DSH_VERSION        dsh CLI version to install (default: latest `next`)
 *   DSH_BIN            path to an already-installed dsh bin (skips the install)
 *   SMOKE_PLUGIN_SPEC  install this spec instead of packing the checkout
 *                      (e.g. `dsh-ontology@0.1.0`, to prove the test catches a
 *                      known-bad release)
 *   SMOKE_KEEP=1       keep the temp directory for inspection
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const registry = 'https://registry.npmjs.org'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ontology-smoke-'))
const dshHome = path.join(tmp, 'home')
const profile = 'smoke'
fs.mkdirSync(dshHome)

const log = (...args) => console.log('[smoke]', ...args)
const fail = (message) => { console.error('[smoke] FAIL:', message); process.exitCode = 1; return false }
const run = (cmd, args, opts = {}) => {
  log('$', cmd, ...args)
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...opts })
}
const env = { ...process.env, DSH_HOME: dshHome }

try {
  // 1. The dsh CLI.
  let dshBin = process.env.DSH_BIN
  if (!dshBin) {
    const version = process.env.DSH_VERSION ?? 'next'
    const cliDir = path.join(tmp, 'cli')
    fs.mkdirSync(cliDir)
    fs.writeFileSync(path.join(cliDir, 'package.json'), '{"name":"smoke-cli","private":true}')
    run('npm', ['install', '--no-audit', '--no-fund', `--registry=${registry}`, `@deepseek-ai/dsh@${version}`], { cwd: cliDir, stdio: ['ignore', 'inherit', 'inherit'] })
    dshBin = path.join(cliDir, 'node_modules', '.bin', 'dsh')
  }
  const dshVersion = run(dshBin, ['--version'], { env }).trim()
  log('dsh', dshVersion)

  // 2. This package, exactly as it would be published (or a named release).
  let pluginSpec = process.env.SMOKE_PLUGIN_SPEC
  if (!pluginSpec) {
    const packOut = run('pnpm', ['pack', '--pack-destination', tmp], { cwd: repo })
    const tgz = fs.readdirSync(tmp).find(f => f.startsWith('dsh-ontology-') && f.endsWith('.tgz'))
    if (!tgz) throw new Error(`pack produced no tarball: ${packOut}`)
    pluginSpec = path.join(tmp, tgz)
  }
  log('plugin under test:', pluginSpec)

  // 3. A profile from the shipped headless template (dsh-base + dsh-headless), plus us.
  //    `--profile <name>` is the spelling every supported dsh accepts.
  run(dshBin, ['--profile', profile, '--from-default-profile', 'headless', '--dump-config'], { env, cwd: tmp })
  run(dshBin, ['plugin', '--profile', profile, 'add', pluginSpec], { env, cwd: tmp, stdio: ['ignore', 'inherit', 'inherit'] })
  const composed = run(dshBin, ['--profile', profile, '--dump-config'], { env, cwd: tmp })
  if (!/^- id: ontology$/m.test(composed)) throw new Error('composed profile has no ontology row')
  const storageRows = composed.match(/^- id: storage$/mg)?.length ?? 0
  log('composed profile: ontology row present, storage rows =', storageRows)

  /**
   * Boot the profile once against the scripted LLM.
   * @param {number} phase - Mock script phase.
   * @returns {{ status: number | null, stdout: string, stderr: string, agentRequests: any[] }}
   */
  const bootOnce = async (phase) => {
    const capture = path.join(tmp, `capture-${phase}.jsonl`)
    const mock = spawn(process.execPath, [path.join(here, 'mock-llm.mjs'), capture, String(phase)], { stdio: ['ignore', 'pipe', 'inherit'] })
    const port = await new Promise((resolve, reject) => {
      mock.stdout.on('data', chunk => { const m = /PORT (\d+)/.exec(String(chunk)); if (m) resolve(Number(m[1])) })
      mock.on('exit', code => reject(new Error(`mock exited early (${code})`)))
    })
    log(`boot ${phase}: mock LLM on port ${port}`)
    const boot = spawnSync(dshBin, ['--profile', profile, `smoke test task ${phase}`], {
      cwd: tmp,
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...env, DEEPSEEK_API_KEY: 'sk-smoke', DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}` },
    })
    mock.kill()
    fs.writeFileSync(path.join(tmp, `boot-${phase}.stdout`), boot.stdout ?? '')
    fs.writeFileSync(path.join(tmp, `boot-${phase}.stderr`), boot.stderr ?? '')
    const requests = fs.existsSync(capture) ? fs.readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l).body) : []
    return {
      status: boot.status,
      stdout: boot.stdout ?? '',
      stderr: boot.stderr ?? '',
      agentRequests: requests.filter(r => Array.isArray(r.tools) && r.tools.length > 0),
    }
  }
  /** The system prompt of one request, in either wire format. */
  const systemOf = (request) => {
    if (request === undefined) return ''
    const anthropic = request.system ?? request.messages?.find(m => m.role === 'system')?.content ?? ''
    return typeof anthropic === 'string' ? anthropic : JSON.stringify(anthropic)
  }
  /** Tool names of one request, in either wire format. */
  const toolNamesOf = (request) => (request?.tools ?? []).map(t => t.function?.name ?? t.name)
  let ok = true
  const checkBoot = (boot, marker) => {
    if (/duplicate loader entry id|plugin tree failed to load/.test(boot.stderr)) ok = fail(`plugin tree failed to mount:\n${boot.stderr}`)
    if (boot.status !== 0) ok = fail(`boot exited ${boot.status}\n${boot.stderr.slice(-2000)}`)
    if (!boot.stdout.includes(marker)) ok = fail(`final answer missing ${marker}: ${boot.stdout.slice(-300)}`)
  }

  // 4. First boot: empty graph → define → assert → query with inference.
  const first = await bootOnce(1)
  checkBoot(first, 'SMOKE_OK')
  if (first.agentRequests.length < 4) ok = fail(`expected ≥4 agent requests, saw ${first.agentRequests.length}`)
  const opening = first.agentRequests[0]
  if (opening) {
    const toolNames = toolNamesOf(opening)
    for (const name of ['ontology_define', 'ontology_assert', 'ontology_query', 'ontology_retract']) {
      if (!toolNames.includes(name)) ok = fail(`tool ${name} not registered; tools = ${toolNames.join(',')}`)
    }
    if (!systemOf(opening).includes('# Ontology')) ok = fail('system prompt lacks the ontology section')
    if (!systemOf(opening).includes('currently EMPTY')) ok = fail('system prompt should describe an empty graph on first boot')
  }
  const transcript = JSON.stringify(first.agentRequests.at(-1)?.messages ?? [])
  if (!transcript.includes('defined 1 class(es), 1 relation(s)')) ok = fail('ontology_define result not in transcript')
  if (!transcript.includes('asserted 3 entity(ies), 2 fact(s)')) ok = fail('ontology_assert result not in transcript')
  if (!transcript.includes('smoke_a smoke_rel smoke_c (inferred: transitive)')) ok = fail('transitive inference missing from ontology_query result')

  const stored = path.join(dshHome, 'storages', 'ontology.json')
  if (!fs.existsSync(stored)) ok = fail(`nothing persisted at ${stored}`)
  else {
    const text = fs.readFileSync(stored, 'utf8')
    if (!text.includes('SmokeClass') || !text.includes('smoke_a|smoke_rel|smoke_b')) ok = fail('persisted domain lacks the defined class or asserted fact')
  }

  // 5. Second boot over the same DSH_HOME: the graph survived, and the
  //    standing prompt section now carries its vocabulary.
  const second = await bootOnce(2)
  checkBoot(second, 'SMOKE_OK2')
  const reopened = systemOf(second.agentRequests[0])
  if (reopened.includes('currently EMPTY')) ok = fail('second boot still describes an empty graph')
  if (!reopened.includes('class SmokeClass')) ok = fail('second boot prompt section lacks the persisted class')
  if (!reopened.includes('rel smoke_rel: SmokeClass -> SmokeClass [transitive]')) ok = fail(`second boot prompt section lacks the persisted relation:\n${reopened.slice(reopened.indexOf('# Ontology'), reopened.indexOf('# Ontology') + 600)}`)

  if (ok) log(`PASS on dsh ${dshVersion}: mounted, 4 tools, prompt section, define/assert/query with inference, persisted across boots`)
  else log('artifacts in', tmp)
} finally {
  if (process.exitCode && process.exitCode !== 0) { /* keep for inspection */ }
  else if (!process.env.SMOKE_KEEP) fs.rmSync(tmp, { recursive: true, force: true })
  else log('kept', tmp)
}
