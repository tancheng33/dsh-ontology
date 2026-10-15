/**
 * A scripted stand-in for the DeepSeek endpoint, for the boot smoke test. It
 * speaks just enough of both wire formats the harness has used — Anthropic
 * Messages (`/v1/messages`, dsh ≥ 0.2) and OpenAI chat completions
 * (`/chat/completions`, dsh 0.1.x) — as SSE streams, to drive the harness
 * through a fixed tool-call sequence against the ontology plugin. Every
 * request body is recorded so the runner can assert on what the harness
 * actually sent (tool list, system prompt, tool results).
 *
 * Usage: node mock-llm.mjs <capture.jsonl> <phase>
 *   phase 1: define → assert → query → "SMOKE_OK" (a fresh graph)
 *   phase 2: "SMOKE_OK2" straight away (a second boot over the same DSH_HOME;
 *            the runner checks the prompt section now carries the vocabulary)
 * Prints `PORT <n>` once listening. Exits after 5 minutes on its own.
 */
import http from 'node:http'
import fs from 'node:fs'

const captureFile = process.argv[2]
const phase = Number(process.argv[3] ?? 1)
if (!captureFile) throw new Error('usage: mock-llm.mjs <capture.jsonl> <phase>')

/** Script: one entry per agent step (requests that carry tools). */
const script = phase === 2 ? [{ text: 'SMOKE_OK2' }] : [
  { tool: 'ontology_define', input: {
    classes: [{ id: 'SmokeClass', comment: 'created by the boot smoke test' }],
    relations: [{ id: 'smoke_rel', domain: ['SmokeClass'], range: ['SmokeClass'], characteristics: ['transitive'] }],
  } },
  { tool: 'ontology_assert', input: {
    entities: [{ id: 'smoke_a', classes: ['SmokeClass'] }, { id: 'smoke_b', classes: ['SmokeClass'] }, { id: 'smoke_c', classes: ['SmokeClass'] }],
    facts: [
      { subject: 'smoke_a', predicate: 'smoke_rel', object: 'smoke_b' },
      { subject: 'smoke_b', predicate: 'smoke_rel', object: 'smoke_c' },
    ],
  } },
  { tool: 'ontology_query', input: { mode: 'facts', subject: 'smoke_a', includeInferred: true } },
  { text: 'SMOKE_OK' },
]
let turn = 0

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  res.end()
}

/** OpenAI chat-completions streaming: `data:` lines, closed by `[DONE]`. */
function replyOpenAI(res, step, id) {
  const chunk = (delta, finish) => ({
    id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock',
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(finish === null ? {} : { usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }),
  })
  const chunks = step.text !== undefined
    ? [chunk({ role: 'assistant', content: step.text }, null), chunk({}, 'stop')]
    : [
        chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call_${id}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.input) } }] }, null),
        chunk({}, 'tool_calls'),
      ]
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

/** Anthropic Messages streaming: named events. */
function reply(res, step, id) {
  const usage = { input_tokens: 10, output_tokens: 10 }
  const start = ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', content: [], model: 'mock', stop_reason: null, stop_sequence: null, usage } }]
  if (step.text !== undefined) {
    sse(res, [
      start,
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step.text } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }],
      ['message_stop', { type: 'message_stop' }],
    ])
    return
  }
  sse(res, [
    start,
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${id}`, name: step.tool, input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.input) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage }],
    ['message_stop', { type: 'message_stop' }],
  ])
}

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    let body
    try { body = JSON.parse(raw) } catch { body = { parseError: raw.slice(0, 200) } }
    fs.appendFileSync(captureFile, JSON.stringify({ url: req.url, body }) + '\n')
    const id = `msg_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
    const answer = req.url?.endsWith('/chat/completions') ? replyOpenAI : reply
    // Side requests (session title etc.) carry no tools: answer with plain text.
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      answer(res, { text: 'smoke' }, id)
      return
    }
    const step = script[Math.min(turn, script.length - 1)]
    turn += 1
    answer(res, step, id)
  })
})

server.listen(0, '127.0.0.1', () => {
  console.log(`PORT ${server.address().port}`)
})
setTimeout(() => process.exit(0), 5 * 60_000).unref()
