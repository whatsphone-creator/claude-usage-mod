import { atom, read, update } from 'claude-code'
import type { CommandInfo, EngineInterface, Register, SessionUsage } from 'claude-code'

import type { Hint, Limit, Live, Reading, Tokens } from '../types'

const reading = atom({ plugin: 'usage-meter', key: 'reading' } as const, null)
const isHidden = atom({ plugin: 'usage-meter', key: 'isHidden' } as const, false)
const NO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const tokens = atom({ plugin: 'usage-meter', key: 'tokens' } as const, NO_TOKENS)
// Tokens the last main-conversation turn used (its responses summed).
const lastTurn = atom({ plugin: 'usage-meter', key: 'lastTurn' } as const, 0)

// Per-model weekly windows (Fable, Opus, ...) the account's usage endpoint reports;
// the session's own usage carries only the 5-hour and 7-day windows.
const NO_LIMITS: Limit[] = []
const modelLimits = atom({ plugin: 'usage-meter', key: 'modelLimits' } as const, NO_LIMITS)
// The 5-hour and 7-day windows as that endpoint last gave them, and when. The session's own
// figures only move when this session talks to Claude, so while it sits idle (and the account
// is used elsewhere) the endpoint's are the newer ones.
const NO_LIVE: Live = { at: 0, limits: [] }
const live = atom({ plugin: 'usage-meter', key: 'live' } as const, NO_LIVE)
// When the session last measured its own usage.
const measuredAt = atom({ plugin: 'usage-meter', key: 'measuredAt' } as const, 0)
// The limits already announced as past the red line.
const NO_KINDS: string[] = []
const told = atom({ plugin: 'usage-meter', key: 'told' } as const, NO_KINDS)
// What the last fetch of that endpoint came to, for /usage-meter to report.
const modelNote = atom({ plugin: 'usage-meter', key: 'modelNote' } as const, 'not fetched yet')

// The skin picked with the band's own button; null until then, when the `skin` option decides.
// Kept in the store too, so the pick outlasts the session.
const NO_PICK: 'dark' | 'light' | null = null
const skinPick = atom({ plugin: 'usage-meter', key: 'skinPick' } as const, NO_PICK)

// The skill suggested for the last message. Change the tag when Hint's fields change.
const hint = atom({ plugin: 'usage-meter', key: 'hint' } as const, null as Hint | null, { shape: 'hint-1' })
// Only the newest message's answer is shown; an older one arriving late is dropped.
let asked = 0

// Skills and the commands plugins add; the engine's own commands and MCP prompts are left out.
function isSkill(c: CommandInfo): boolean {
  return c.source !== 'builtin' && c.source !== 'mcp'
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

// The fixed part of the request, cached by the API so later messages only pay for the message.
export function systemText(skills: CommandInfo[]): string {
  const lines = skills.map(s => `- ${s.name}: ${oneLine(s.description, 160)}`).join('\n')
  return [
    'You pick at most one Claude Code skill that clearly fits the user\'s message.',
    'Answer with JSON only: {"skill": "<name from the list>" | null, "why": "<at most 12 Cantonese characters on what it is for>"}.',
    'Answer null unless one skill is plainly the right tool for this message. Small talk, questions about the conversation and quick replies get null.',
    'The user prefers impeccable and design-taste-frontend for UI/UX work, and does not use ui-ux-pro-max.',
    '',
    'Skills:',
    lines,
  ].join('\n')
}

// Reads the model's reply; anything that does not name a listed skill is no hint.
export function parseHint(text: string, names: Set<string>): Hint | null {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const data = JSON.parse(match[0]) as { skill?: unknown; why?: unknown }
    if (typeof data.skill !== 'string' || !names.has(data.skill)) return null
    return { skill: data.skill, why: typeof data.why === 'string' ? oneLine(data.why, 30) : '' }
  } catch {
    return null
  }
}

// What the hint's button sends: the conversation already holds the message it refers to.
export function useSkillText(skill: string): string {
  return `請用 Skill 工具執行 ${skill}，處理我上一個訊息。`
}

async function suggest($: EngineInterface, text: string, ticket: number) {
  const skills = (await $.command.list()).filter(isSkill)
  if (skills.length === 0) return
  const names = new Set(skills.map(s => s.name))
  const reply = await $.model.complete({
    model: 'haiku',
    system: [{ text: systemText(skills), cache: true }],
    prompt: oneLine(text, 2000),
    maxTokens: 120,
    timeoutMs: 20000,
  })
  if (ticket !== asked || !reply.isAnswered) return
  const found = parseHint(reply.text, names)
  // A message that already names the skill needs no hint.
  const next = found && !text.includes(found.skill) ? found : null
  await update($, hint, () => next)
}

function totalTokens(t: Tokens): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite
}

// 950, 12.4k, 860k, 3.21M, 48.6M
function compact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`
  return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`
}

const CODES: Record<string, string> = { five_hour: '5H', seven_day: '7D', spend_limit: 'LIM' }

// Per-model windows (such as a weekly Fable limit) arrive under their own kind when the app passes them.
function codeFor(kind: string): string {
  if (CODES[kind]) return CODES[kind]
  const model = /fable|opus|sonnet|haiku/i.exec(kind)
  if (model) return model[0].toUpperCase()
  // A scoped window the endpoint named some other way: its scope's last word.
  if (kind.includes(':')) return (kind.split(':')[1]?.match(/[a-z0-9]+/gi)?.pop() ?? 'MODEL').toUpperCase().slice(0, 8)
  return kind.toUpperCase()
}
const LABELS: Record<string, string> = { five_hour: '5 小時', seven_day: '7 日', spend_limit: '額度' }

const BAR_CELLS = 7

function toReading(u: Pick<SessionUsage, 'context' | 'rateLimits'>): Reading {
  return {
    contextPercent: u.context.percent,
    contextTokens: u.context.tokens,
    contextWindow: u.context.window,
    limits: u.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
  }
}

function filledCells(percent: number): number {
  if (percent <= 0) return 0
  return Math.max(1, Math.min(BAR_CELLS, Math.round((percent / 100) * BAR_CELLS)))
}

function untilReset(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return ''
  const ms = Date.parse(resetsAt) - now
  if (!Number.isFinite(ms) || ms <= 0) return ''
  // Countdown readout: HH:MM, with a day prefix past 24 hours (4d06:13).
  const mins = Math.round(ms / 60000)
  const d = Math.floor(mins / 1440)
  const hh = String(Math.floor((mins % 1440) / 60)).padStart(2, '0')
  const mm = String(mins % 60).padStart(2, '0')
  return d > 0 ? `${d}d${hh}:${mm}` : `${hh}:${mm}`
}

export type Palette = Record<'frame' | 'panel' | 'edge' | 'code' | 'ok' | 'warn' | 'hot' | 'off' | 'note', string>

// Console palette: dark violet panels, warning-orange edges and codes,
// phosphor green readouts that turn amber then red as a limit fills.
const C: Palette = {
  frame: '#0d0717',
  panel: '#160b26',
  edge: '#ff7a1a',
  code: '#ff7a1a',
  ok: '#3dff8a',
  warn: '#ffb000',
  hot: '#ff2d3f',
  off: '#4a3b63',
  note: '#b48cff',
}
// The daylight skin: the same console on warm paper, its inks darkened to read on a light ground.
const LIGHT: Palette = {
  frame: '#f7f1e6',
  panel: '#fffdf8',
  edge: '#d4500a',
  code: '#d4500a',
  ok: '#0b8043',
  warn: '#b06a00',
  hot: '#d3162b',
  off: '#cdc3dd',
  note: '#6a3fd0',
}

export type Skin = 'auto' | 'dark' | 'light'

// The drawing is made in the dark palette, then dressed: `light` swaps every colour, and `auto`
// keeps the dark colours and adds a stylesheet that swaps them where the surface is in light
// mode (a surface that drops the stylesheet shows the dark skin).
function dress(svg: string, skin: Skin): string {
  if (skin === 'dark') return svg
  const pairs = [...new Map((Object.keys(C) as (keyof Palette)[]).map(k => [C[k], LIGHT[k]])).entries()]
  if (skin === 'light') return pairs.reduce((out, [dark, light]) => out.split(dark).join(light), svg)
  const rules = pairs
    .map(([dark, light]) => `[fill="${dark}"]{fill:${light}}[stroke="${dark}"]{stroke:${light}}`)
    .join('')
  return svg.replace(/(<svg[^>]*>)/, `$1<style>@media (prefers-color-scheme: light){${rules}}</style>`)
}

const HOT_AT = 90
const WARN_AT = 75
const toneIn = (P: Palette) => (p: number) => (p >= HOT_AT ? P.hot : p >= WARN_AT ? P.warn : P.ok)
const tone = toneIn(C)

const FONT = "'SF Mono', Menlo, Monaco, Consolas, monospace"

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Monospaced advance: wide (CJK) characters take a full em, the rest 0.6 em.
function textWidth(text: string, size: number): number {
  let w = 0
  for (const ch of text) w += (ch.codePointAt(0) ?? 0) >= 0x2e80 ? size : size * 0.6
  return w
}

function octagon(x: number, y: number, w: number, h: number, c: number): string {
  const pts: [number, number][] = [
    [x + c, y], [x + w - c, y], [x + w, y + c], [x + w, y + h - c],
    [x + w - c, y + h], [x + c, y + h], [x, y + h - c], [x, y + c],
  ]
  return pts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ')
}

function stripe(x: number, y: number, w: number, h: number, slant: number, fill: string): string {
  return `<polygon points="${x + slant},${y} ${x + w + slant},${y} ${x + w},${y + h} ${x},${y + h}" fill="${fill}"/>`
}

// Windows that reset at the same moment (the 7-day limit and a model's weekly limit) share one
// chip and one countdown.
function groupLimits(limits: Limit[], now: number): { members: Limit[]; left: string }[] {
  const groups: { members: Limit[]; left: string }[] = []
  for (const l of limits) {
    const left = untilReset(l.resetsAt, now)
    const same = left ? groups.find(g => g.left === left) : undefined
    if (same) same.members.push(l)
    else groups.push({ members: [l], left })
  }
  return groups
}

type Seg = { text: string; color: string; weight?: number } | { bar: number }

// The desktop band as one SVG: an octagon frame, a header strip and octagon readout chips.
// `plan` is the label in the header's right corner (the `plan` option); empty draws none.
// `hasSwitch` leaves the header's left stripes out: the skin button is laid over that corner.
export function drawConsole(r: Reading, t: Tokens, last: number, now: number, plan: string, hasSwitch = false) {
  const SIZE = 13
  const PAD = 7
  const CHIP_H = 22
  const CHIP_PAD = 6
  const DIV = 11
  const CELL_W = 6
  const CELL_GAP = 2
  const BAR_W = BAR_CELLS * (CELL_W + CELL_GAP) - CELL_GAP + 2

  const chips: { segs: Seg[] }[] = []
  const altParts: string[] = []
  const pctSeg = (p: number): Seg => ({ text: `${Math.round(p)}%`, color: tone(p), weight: 700 })

  chips.push({
    segs: [
      { text: 'CTX', color: C.code, weight: 700 },
      r.contextPercent !== undefined ? pctSeg(r.contextPercent) : { text: '--', color: C.note },
    ],
  })
  altParts.push(`Context ${r.contextPercent !== undefined ? `${Math.round(r.contextPercent)}%` : 'unknown'}`)

  for (const { members, left } of groupLimits(r.limits, now)) {
    const segs: Seg[] = members.flatMap(l => [
      { text: codeFor(l.kind), color: C.code, weight: 700 },
      { bar: l.percentUsed },
      pctSeg(l.percentUsed),
    ])
    if (left) segs.push({ text: left, color: C.note })
    chips.push({ segs })
    const read = members.map(l => `${codeFor(l.kind)} ${Math.round(l.percentUsed)}%`).join(' and ')
    altParts.push(`${read}${left ? ` resets in ${left}` : ''}`)
  }

  chips.push({
    segs: [
      { text: 'TOK', color: C.code, weight: 700 },
      { text: compact(totalTokens(t)), color: C.ok, weight: 700 },
      ...(last > 0 ? [{ text: `+${compact(last)}`, color: C.note }] : []),
    ],
  })
  altParts.push(`${compact(totalTokens(t))} tokens this session${last > 0 ? `, ${compact(last)} last turn` : ''}`)

  const segW = (s: Seg) => ('bar' in s ? BAR_W : textWidth(s.text, SIZE))
  const chipW = (c: { segs: Seg[] }) =>
    c.segs.reduce((a, s) => a + segW(s), 0) + DIV * (c.segs.length - 1) + CHIP_PAD * 2

  const HS = 9.5
  const headY = PAD + 6
  const rowY = headY + 12
  const ALERT_W = 18

  const rowW = ALERT_W + 6 + chips.reduce((a, c) => a + chipW(c) + 5, -5)
  const leftHead = 3 * 9 + 8 + textWidth('警告 WARNING', HS) + 24 + textWidth('Claude-usage', HS)
  const rightHead = textWidth(plan, HS) + 8 + 2 * 9 + 6 + 3 * 9
  const W = Math.ceil(Math.max(rowW, leftHead + rightHead + 40) + PAD * 2)
  const H = rowY + CHIP_H + PAD

  const out: string[] = []
  out.push(`<polygon points="${octagon(0.75, 0.75, W - 1.5, H - 1.5, 7)}" fill="${C.frame}" stroke="${C.edge}" stroke-width="1.5"/>`)

  const htext = (x: number, text: string, color: string, anchor = 'start', y = headY) =>
    `<text x="${x.toFixed(1)}" y="${y}" fill="${color}" font-size="${HS}" font-weight="700" text-anchor="${anchor}" dominant-baseline="central">${esc(text)}</text>`
  const vline = (x: number) =>
    `<line x1="${x}" y1="${headY - 4}" x2="${x}" y2="${headY + 4}" stroke="${C.edge}" stroke-width="1"/>`

  let hx = PAD
  if (!hasSwitch) for (let i = 0; i < 3; i++) out.push(stripe(hx + i * 9, headY - 3.5, 6, 7, 3, C.edge))
  hx += 3 * 9 + 4
  out.push(vline(hx))
  hx += 6
  out.push(htext(hx, '警告 WARNING', C.edge))
  hx += textWidth('警告 WARNING', HS) + 6
  out.push(vline(hx))
  hx += 6
  out.push(htext(hx, 'Claude-usage', C.note))

  // The right labels sit a step higher, over the raised end of the header line.
  const STEP = 4
  const ry = headY - STEP
  let rx = W - PAD - 3 * 9
  for (let i = 0; i < 3; i++) out.push(stripe(rx + i * 9, ry - 3.5, 6, 7, 3, C.edge))
  rx -= 6 + 2 * 9
  for (let i = 0; i < 2; i++) out.push(stripe(rx + i * 9, ry - 3.5, 6, 7, 3, C.note))
  rx -= 6
  if (plan) out.push(htext(rx, plan, C.note, 'end', ry))

  // Header underline: one line under the whole strip, stepping up at an angle before the right labels.
  const lineY = headY + 7
  const stepX = rx - textWidth(plan, HS) - 14
  out.push(
    `<polyline points="0.75,${lineY} ${(stepX - STEP).toFixed(1)},${lineY} ${stepX.toFixed(1)},${lineY - STEP} ${(W - 0.75).toFixed(1)},${lineY - STEP}" fill="none" stroke="${C.edge}" stroke-width="1.2" stroke-linejoin="miter"/>`,
  )

  const cy = rowY + CHIP_H / 2
  out.push(
    `<polygon points="${PAD + 8},${cy - 7} ${PAD + 16},${cy + 7} ${PAD},${cy + 7}" fill="none" stroke="${C.hot}" stroke-width="1.6" stroke-linejoin="round"/>`,
    `<text x="${PAD + 8}" y="${cy + 2.5}" fill="${C.hot}" font-size="9" font-weight="700" text-anchor="middle" dominant-baseline="central">!</text>`,
  )

  let x = PAD + ALERT_W + 6
  for (const c of chips) {
    const w = chipW(c)
    out.push(`<polygon points="${octagon(x, rowY, w, CHIP_H, 5)}" fill="${C.panel}" stroke="${C.edge}" stroke-width="1.2"/>`)
    let sx = x + CHIP_PAD
    c.segs.forEach((s, i) => {
      if (i > 0) {
        const dx = sx + DIV / 2 - 0.5
        out.push(`<line x1="${dx}" y1="${rowY + 5}" x2="${dx}" y2="${rowY + CHIP_H - 5}" stroke="${C.edge}" stroke-width="1"/>`)
        sx += DIV
      }
      if ('bar' in s) {
        const lit = filledCells(s.bar)
        for (let k = 0; k < BAR_CELLS; k++) {
          const px = sx + k * (CELL_W + CELL_GAP)
          const pts = `${px + 2},${cy - 4.5} ${px + CELL_W + 2},${cy - 4.5} ${px + CELL_W},${cy + 4.5} ${px},${cy + 4.5}`
          out.push(
            k < lit
              ? `<polygon points="${pts}" fill="${tone(s.bar)}"/>`
              : `<polygon points="${pts}" fill="none" stroke="${C.off}" stroke-width="1"/>`,
          )
        }
      } else {
        out.push(
          `<text x="${sx.toFixed(1)}" y="${cy}" fill="${s.color}" font-size="${SIZE}" font-weight="${s.weight ?? 500}" dominant-baseline="central">${esc(s.text)}</text>`,
        )
      }
      sx += segW(s)
    })
    x += w + 5
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">` +
    out.join('') +
    '</svg>'
  return { svg, alt: `Claude usage: ${altParts.join(', ')}` }
}

async function refresh($: EngineInterface) {
  const u = await $.session.usage()
  await update($, reading, () => toReading(u))
}

// One toast as a limit crosses the red line, whichever source saw it: not one per percent after
// it, and not again when the two sources disagree by a point. A limit is told again only after
// it has fallen well back (a reset).
async function announce($: EngineInterface, limits: Limit[]) {
  const stored = await read($, told)
  const before = Array.isArray(stored) ? stored : []
  const still = before.filter(kind => {
    const l = limits.find(x => x.kind === kind)
    return !l || l.percentUsed >= HOT_AT - 5
  })
  const crossed = limits.filter(l => l.percentUsed >= HOT_AT && !still.includes(l.kind))
  if (crossed.length === 0 && still.length === before.length) return
  await update($, told, () => [...still, ...crossed.map(l => l.kind)])
  if (crossed.length > 0) {
    const each = crossed.map(l => `${LABELS[l.kind] ?? codeFor(l.kind)} limit at ${Math.round(l.percentUsed)}%`)
    $.ui.toast(each.join(', '))
  }
}

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

// Asks Anthropic's usage endpoint, with the session's own sign-in (the engine holds the
// credential and adds it to the request), for the windows the session does not pass on.
async function refreshModels($: EngineInterface) {
  let note: string
  try {
    const auth = await $.session.authorize()
    if (!auth || auth.kind !== 'bearer') {
      note = 'no subscription sign-in'
    } else {
      const res = await $.http.fetch(USAGE_URL, {
        auth: auth.handle,
        headers: { 'anthropic-beta': 'oauth-2025-04-20' },
      })
      if (!res.ok) {
        note = `HTTP ${res.status}`
      } else {
        const body = JSON.parse(res.text) as ({ limits?: unknown } & Record<string, unknown>) | null
        // The two windows the session also carries, under the session's own names.
        const base: Limit[] = []
        for (const kind of ['five_hour', 'seven_day']) {
          const w = body?.[kind] as { utilization?: unknown; resets_at?: unknown } | null | undefined
          if (!w || typeof w.utilization !== 'number') continue
          base.push({
            kind,
            percentUsed: w.utilization,
            resetsAt: typeof w.resets_at === 'string' ? w.resets_at : undefined,
          })
        }
        const at = await $.clock.now()
        await update($, live, () => ({ at, limits: base }))
        const found: Limit[] = []
        const seen: string[] = []
        // `limits` lists every window; the scoped ones (a weekly limit for one model, such as
        // Fable) are the ones the session does not pass on. `scope` says what each covers.
        const rows = Array.isArray(body?.limits) ? body.limits : []
        for (const row of rows) {
          if (!row || typeof row !== 'object') continue
          const { kind, percent, resets_at, scope } = row as Record<string, unknown>
          if (typeof kind !== 'string' || typeof percent !== 'number') continue
          const what = scope == null ? '' : typeof scope === 'string' ? scope : JSON.stringify(scope)
          seen.push(`${kind}${what ? ` (${what})` : ''} ${percent}%`)
          if (!what) continue
          found.push({
            kind: `${kind}:${what}`,
            percentUsed: percent,
            resetsAt: typeof resets_at === 'string' ? resets_at : undefined,
          })
        }
        await update($, modelLimits, () => found)
        await announce($, [...base, ...found])
        note = seen.join(', ') || `no windows in the answer: ${res.text.slice(0, 300)}`
      }
    }
  } catch (err) {
    note = `failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200)
  }
  await update($, modelNote, () => note)
}

export const register: Register = (on, options) => {
  // Claude Code does not tell a mod which plan the account is on, so the label is an option.
  const plan = String(options.plan ?? '').trim().slice(0, 24)
  const configured: Skin = options.skin === 'light' || options.skin === 'dark' ? options.skin : 'auto'
  const hintsOn = options.skillHints !== false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    const kept = await $.store.get('skin').catch(() => undefined)
    if (kept === 'dark' || kept === 'light') await update($, skinPick, () => kept)
    // The countdowns run on while nothing else changes: read the usage again each minute,
    // which also picks up a window that has just reset.
    $.clock.every(60_000, () => void refresh($).catch(() => {}))
    void refreshModels($)
    $.clock.every(300_000, () => void refreshModels($))
    $.command.register({ name: 'usage-meter', description: 'Show or hide the usage meter above the prompt' })
    return result
  })

  on('session.measure', async ($, e, next) => {
    await update($, reading, () => toReading(e))
    const at = await $.clock.now()
    await update($, measuredAt, () => at)
    await announce($, e.rateLimits)
    return next(e)
  })

  // Every turn that reached the API reports its token counts, subagents' turns too.
  on('turn.complete', async ($, e, next) => {
    const u = e.usage
    if (u) {
      await update($, tokens, t => ({
        input: t.input + u.input_tokens,
        output: t.output + u.output_tokens,
        cacheRead: t.cacheRead + u.cache_read_input_tokens,
        cacheWrite: t.cacheWrite + u.cache_creation_input_tokens,
      }))
      if (e.agentId === undefined) {
        const used = u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
        await update($, lastTurn, () => used)
      }
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    if (!hintsOn) return result
    const ticket = ++asked
    await update($, hint, () => null)
    const text = e.text.trim()
    // Slash commands, very short replies and prompts plugins send (the hint's button too) are skipped.
    if (e.origin?.kind !== 'plugin' && e.command === undefined && !text.startsWith('/') && text.length >= 8) {
      // A hook's dispatch ends when it returns and cuts a model call it left running,
      // so the lookup starts from a timer, after the dispatch.
      $.clock.after(0, () => {
        void suggest($, text, ticket).catch(() => {})
      })
    }
    return result
  })

  // Once the suggested skill runs, the hint has done its job.
  on('tool.call', async ($, e, next) => {
    if (e.tool === 'Skill') {
      const current = await read($, hint)
      if (current && e.skill === current.skill) await update($, hint, () => null)
    }
    return next(e)
  })

  on('command.run', { command: 'usage-meter' }, async ($, e, next) => {
    const hidden = await update($, isHidden, v => !v)
    if (!hidden) await Promise.all([refresh($), refreshModels($)])
    const r = await read($, reading)
    const kinds = r?.limits.map(l => `${l.kind} ${l.percentUsed}%`).join(', ') || 'none'
    return {
      text: (hidden ? 'Usage meter hidden. Run /usage-meter to show it again.' : 'Usage meter shown.') + `\nLimits from the app: ${kinds}\nUsage endpoint: ${await read($, modelNote)}`,
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [session, models, hidden, t, last, now, pick, fetched, measured] = await Promise.all([
      read($, reading),
      read($, modelLimits),
      read($, isHidden),
      read($, tokens),
      read($, lastTurn),
      $.clock.now(),
      read($, skinPick),
      read($, live),
      read($, measuredAt),
    ])
    const skin: Skin = pick === 'dark' || pick === 'light' ? pick : configured
    if (e.props.hasSurvey) return next(e)
    const els = $.ui.resolve(e)
    const suggested = hintsOn ? await read($, hint) : null
    const hintRow = suggested && (
      <els.Box key="hint" flexDirection="row" gap={1} alignItems="center" flexWrap="nowrap" overflow="hidden">
        <els.Text color="claude">💡 可以用</els.Text>
        <els.Text weight="bold">/{suggested.skill}</els.Text>
        {suggested.why !== '' && <els.Text color="inactive">{suggested.why}</els.Text>}
        <els.Button
          key="use"
          plain
          onPress={async () => {
            await update($, hint, () => null)
            await $.prompt.submit({ text: useSkillText(suggested.skill), asUser: true })
          }}
        >
          <els.Text color="claude" weight="bold">用呢個</els.Text>
        </els.Button>
        <els.Button key="dismiss" plain onPress={() => update($, hint, () => null)}>
          <els.Text color="inactive">✕</els.Text>
        </els.Button>
      </els.Box>
    )
    // The band is one row per plugin, so the hint stacks under the meter inside it.
    const withHint = (band: JSX.Element) =>
      hintRow ? (
        <els.Box flexDirection="column" gap={1} alignItems="flex-start">
          {band}
          {hintRow}
        </els.Box>
      ) : (
        band
      )
    if (session === null || hidden) return hintRow || next(e)
    // Whichever measured the 5-hour and 7-day windows last is shown: the session or the endpoint.
    const fresh = fetched && Array.isArray(fetched.limits) && fetched.at > (Number(measured) || 0) ? fetched.limits : []
    const base = session.limits.map(l => fresh.find(f => f.kind === l.kind) ?? l)
    const known = new Set(base.map(l => l.kind))
    const extra = [...fresh, ...models].filter(l => !known.has(l.kind))
    const r: Reading = { ...session, limits: [...base, ...extra] }

    // Desktop, mobile and the editor: the band is one drawing, so its frames can have
    // chamfered (octagon) corners, which a Box border cannot.
    if (e.surface !== 'terminal' && 'Svg' in els) {
      const { svg, alt } = drawConsole(r, t, last, now, plan, true)
      // The drawing takes no press itself, so the skin switch is a small button laid over its
      // top-left corner, where the header's stripes would be.
      const flip = async () => {
        const to = skin === 'light' ? 'dark' : 'light'
        await update($, skinPick, () => to)
        await $.store.set('skin', to).catch(() => {})
      }
      return withHint(
        <els.Box position="relative" alignSelf="flex-start">
          <els.Svg source={dress(svg, skin)} alt={alt} />
          <els.Box position="absolute" top={0} left={0}>
            <els.Button key="skin" plain onPress={() => void flip()}>
              <els.Text weight="bold" color={(skin === 'light' ? LIGHT : C).edge}>◐</els.Text>
            </els.Button>
          </els.Box>
        </els.Box>,
      )
    }

    // The terminal: one line of text.
    const { Box, Text } = els
    const P = skin === 'light' ? LIGHT : C
    const tone = toneIn(P)
    const code = (text: string) => <Text weight="bold" color={P.code}>{text}</Text>
    const pct = (p: number) => <Text weight="bold" color={tone(p)}>{Math.round(p)}%</Text>
    const note = (text: string) => <Text color={P.note}>{text}</Text>
    const bar = (p: number) => {
      const lit = filledCells(p)
      return (
        <Text>
          <Text color={tone(p)}>{'▰'.repeat(lit)}</Text>
          <Text color={P.off}>{'▱'.repeat(BAR_CELLS - lit)}</Text>
        </Text>
      )
    }

    const chips: JSX.Element[][] = [
      [code('CTX'), r.contextPercent !== undefined ? pct(r.contextPercent) : note('--')],
    ]
    for (const { members, left } of groupLimits(r.limits, now)) {
      chips.push([
        ...members.flatMap(l => [code(codeFor(l.kind)), bar(l.percentUsed), pct(l.percentUsed)]),
        ...(left ? [note(left)] : []),
      ])
    }
    chips.push([
      code('TOK'),
      <Text weight="bold" color={P.ok}>{compact(totalTokens(t))}</Text>,
      ...(last > 0 ? [note(`+${compact(last)}`)] : []),
    ])

    return withHint(
      <Box flexWrap="nowrap" alignItems="center" gap={1} overflow="hidden">
        <Text weight="bold" color={P.hot}>⚠</Text>
        {chips.map((parts, i) => (
          <Box key={`chip${i}`} gap={1} alignItems="center" flexShrink={0}>
            {i > 0 ? <Text color={P.off}>│</Text> : null}
            {parts}
          </Box>
        ))}
      </Box>,
    )
  })
}
