import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage } from 'claude-code'

import type { Limit, Reading, Tokens } from '../types'

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
// What the last fetch of that endpoint came to, for /usage-meter to report.
const modelNote = atom({ plugin: 'usage-meter', key: 'modelNote' } as const, 'not fetched yet')

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
const HOT_AT = 90
const WARN_AT = 75
const tone = (p: number) => (p >= HOT_AT ? C.hot : p >= WARN_AT ? C.warn : C.ok)

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
export function drawConsole(r: Reading, t: Tokens, last: number, now: number, plan: string) {
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
  for (let i = 0; i < 3; i++) out.push(stripe(hx + i * 9, headY - 3.5, 6, 7, 3, C.edge))
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
        const body = JSON.parse(res.text) as { limits?: unknown } | null
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

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    // The countdowns run on while nothing else changes: read the usage again each minute,
    // which also picks up a window that has just reset.
    $.clock.every(60_000, () => void refresh($).catch(() => {}))
    void refreshModels($)
    $.clock.every(300_000, () => void refreshModels($))
    $.command.register({ name: 'usage-meter', description: 'Show or hide the usage meter above the prompt' })
    return result
  })

  on('session.measure', async ($, e, next) => {
    const before = await read($, reading)
    await update($, reading, () => toReading(e))
    // One toast as a limit crosses the red line, not one per percent after it.
    const wasHot = (kind: string) => (before?.limits.find(l => l.kind === kind)?.percentUsed ?? 0) >= HOT_AT
    const hot = e.rateLimits.find(l => l.percentUsed >= HOT_AT && !wasHot(l.kind))
    if (hot) $.ui.toast(`${LABELS[hot.kind] ?? hot.kind} limit at ${Math.round(hot.percentUsed)}%`)
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
    const [session, models, hidden, t, last, now] = await Promise.all([
      read($, reading),
      read($, modelLimits),
      read($, isHidden),
      read($, tokens),
      read($, lastTurn),
      $.clock.now(),
    ])
    if (session === null || hidden || e.props.hasSurvey) return next(e)
    const known = new Set(session.limits.map(l => l.kind))
    const r: Reading = { ...session, limits: [...session.limits, ...models.filter(l => !known.has(l.kind))] }

    // Desktop, mobile and the editor: the band is one drawing, so its frames can have
    // chamfered (octagon) corners, which a Box border cannot.
    const els = $.ui.resolve(e)
    if (e.surface !== 'terminal' && 'Svg' in els) {
      const { svg, alt } = drawConsole(r, t, last, now, plan)
      return <els.Svg source={svg} alt={alt} />
    }

    // The terminal: one line of text.
    const { Box, Text } = els
    const code = (text: string) => <Text weight="bold" color={C.code}>{text}</Text>
    const pct = (p: number) => <Text weight="bold" color={tone(p)}>{Math.round(p)}%</Text>
    const note = (text: string) => <Text color={C.note}>{text}</Text>
    const bar = (p: number) => {
      const lit = filledCells(p)
      return (
        <Text>
          <Text color={tone(p)}>{'▰'.repeat(lit)}</Text>
          <Text color={C.off}>{'▱'.repeat(BAR_CELLS - lit)}</Text>
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
      <Text weight="bold" color={C.ok}>{compact(totalTokens(t))}</Text>,
      ...(last > 0 ? [note(`+${compact(last)}`)] : []),
    ])

    return (
      <Box flexWrap="nowrap" alignItems="center" gap={1} overflow="hidden">
        <Text weight="bold" color={C.hot}>⚠</Text>
        {chips.map((parts, i) => (
          <Box key={`chip${i}`} gap={1} alignItems="center" flexShrink={0}>
            {i > 0 ? <Text color={C.off}>│</Text> : null}
            {parts}
          </Box>
        ))}
      </Box>
    )
  })
}
