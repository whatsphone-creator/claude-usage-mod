import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage } from 'claude-code'

import type { Limit, Reading, Tokens } from '../types'

const reading = atom({ plugin: 'usage-meter', key: 'reading' } as const, null)
const isHidden = atom({ plugin: 'usage-meter', key: 'isHidden' } as const, false)
const NO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const tokens = atom({ plugin: 'usage-meter', key: 'tokens' } as const, NO_TOKENS)
// Tokens the last main-conversation turn used (its responses summed).
const lastTurn = atom({ plugin: 'usage-meter', key: 'lastTurn' } as const, 0)

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
  if (/fable/i.test(kind)) return 'FABLE'
  return kind.toUpperCase()
}
const LABELS: Record<string, string> = { five_hour: '5 小時', seven_day: '7 日', spend_limit: '額度' }

// The account's plan, shown in the header's right corner. The mod API does not expose it, so it is set here.
const PLAN = 'ULTRA PLAN'

const BAR_CELLS = 7

function toReading(u: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>): Reading {
  return {
    contextPercent: u.context.percent,
    contextTokens: u.context.tokens,
    contextWindow: u.context.window,
    limits: u.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
    usd: u.cost?.usd,
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

export type Palette = Record<'frame' | 'panel' | 'edge' | 'code' | 'ok' | 'warn' | 'hot' | 'off' | 'note' | 'value', string>

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

type Seg = { text: string; color: string; weight?: number } | { bar: number }

// The desktop band as one SVG: an octagon frame, a header strip and octagon readout chips.
export function drawConsole(r: Reading, t: Tokens, last: number, now: number, C: Palette, tone: (p: number) => string) {
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

  for (const l of r.limits) {
    const segs: Seg[] = [{ text: codeFor(l.kind), color: C.code, weight: 700 }, { bar: l.percentUsed }, pctSeg(l.percentUsed)]
    const left = untilReset(l.resetsAt, now)
    if (left) segs.push({ text: left, color: C.note })
    chips.push({ segs })
    altParts.push(`${codeFor(l.kind)} ${Math.round(l.percentUsed)}%${left ? ` resets in ${left}` : ''}`)
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
  const rightHead = textWidth(PLAN, HS) + 8 + 2 * 9 + 6 + 3 * 9
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
  out.push(htext(rx, PLAN, C.note, 'end', ry))

  // Header underline: one line under the whole strip, stepping up at an angle before the right labels.
  const lineY = headY + 7
  const stepX = rx - textWidth(PLAN, HS) - 14
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    $.command.register({ name: 'usage-meter', description: 'Show or hide the usage meter above the prompt' })
    return result
  })

  on('session.measure', async ($, e, next) => {
    await update($, reading, () => toReading(e))
    const hot = e.rateLimits.find(l => l.percentUsed >= 90)
    if (hot && e.changed.includes('rateLimits')) {
      $.ui.toast(`${LABELS[hot.kind] ?? hot.kind} limit at ${hot.percentUsed}%`)
    }
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
    if (!hidden) await refresh($)
    const r = await read($, reading)
    const kinds = r?.limits.map(l => `${l.kind} ${l.percentUsed}%`).join(', ') || 'none'
    return {
      text: (hidden ? 'Usage meter hidden. Run /usage-meter to show it again.' : 'Usage meter shown.') + `\nLimits from the app: ${kinds}`,
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const r = await read($, reading)
    if (r === null || e.props.hasSurvey || (await read($, isHidden))) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const t = await read($, tokens)
    const last = await read($, lastTurn)
    const isTerminal = e.surface === 'terminal'

    // Console palette: dark violet panels, warning-orange edges and codes,
    // phosphor green readouts that turn amber then red as a limit fills.
    const C = {
      frame: '#0d0717',
      panel: '#160b26',
      edge: '#ff7a1a',
      code: '#ff7a1a',
      ok: '#3dff8a',
      warn: '#ffb000',
      hot: '#ff2d3f',
      off: '#4a3b63',
      note: '#b48cff',
      value: '#e9fff0',
    }
    const tone = (p: number) => (p >= 90 ? C.hot : p >= 75 ? C.warn : C.ok)

    // Desktop, mobile and the editor: the band is one drawing, so its frames can have
    // chamfered (octagon) corners, which a Box border cannot.
    if (!isTerminal) {
      const els = $.ui.resolve(e)
      if ('Svg' in els) {
        const { svg, alt } = drawConsole(r, t, last, now, C, tone)
        return <els.Svg source={svg} alt={alt} />
      }
    }

    const big = isTerminal ? undefined : ('body' as const)
    const pipe = (key: string) => <Text key={key} color={C.edge}>│</Text>

    // Each section: an orange frame, its parts split by thin dividers.
    const chip = (key: string, children: JSX.Element[]) => {
      const parts: JSX.Element[] = []
      children.forEach((c, i) => {
        if (i > 0 && !isTerminal) parts.push(pipe(`${key}p${i}`))
        parts.push(c)
      })
      return isTerminal ? (
        <Box key={key} gap={1} alignItems="center" flexShrink={0}>{parts}</Box>
      ) : (
        <Box
          key={key}
          gap="xs"
          alignItems="center"
          flexShrink={0}
          borderStyle="round"
          borderColor={C.edge}
          backgroundColor={C.panel}
          paddingX="xs"
        >
          {parts}
        </Box>
      )
    }

    const code = (text: string) => (
      <Text mono size={big} weight="bold" color={C.code}>{text}</Text>
    )

    const bar = (percent: number) => {
      const lit = filledCells(percent)
      return (
        <Text mono size={big}>
          <Text color={tone(percent)}>{'▰'.repeat(lit)}</Text>
          <Text color={C.off}>{'▱'.repeat(BAR_CELLS - lit)}</Text>
        </Text>
      )
    }

    const pct = (percent: number) => (
      <Text mono size={big} weight="bold" tabular color={tone(percent)}>{Math.round(percent)}%</Text>
    )

    const note = (text: string) => <Text mono size={big} color={C.note} tabular>{text}</Text>

    const chips: JSX.Element[] = []

    chips.push(
      chip('ctx', [code('CTX'), r.contextPercent !== undefined ? pct(r.contextPercent) : note('--')]),
    )

    for (const l of r.limits as Limit[]) {
      const parts = [code(codeFor(l.kind)), bar(l.percentUsed), pct(l.percentUsed)]
      const left = untilReset(l.resetsAt, now)
      if (left) parts.push(note(left))
      chips.push(chip(l.kind, parts))
    }

    chips.push(
      chip('tok', [
        code('TOK'),
        <Text mono size={big} weight="bold" tabular color={C.ok}>{compact(totalTokens(t))}</Text>,
        ...(last > 0 ? [note(`+${compact(last)}`)] : []),
      ]),
    )

    const alert = <Text key="alert" size={isTerminal ? undefined : 'heading'} weight="bold" color={C.hot}>⚠</Text>

    if (isTerminal) {
      const row: JSX.Element[] = [alert]
      chips.forEach((c, i) => {
        if (i > 0) row.push(<Text key={`sep${i}`} color={C.off}>│</Text>)
        row.push(c)
      })
      return (
        <Box flexWrap="nowrap" alignItems="center" gap={1} overflow="hidden">{row}</Box>
      )
    }

    // Desktop and mobile: a framed console with a header strip over the readouts.
    const cap = (text: string, color: string) => (
      <Text mono size="caption" weight="bold" color={color}>{text}</Text>
    )
    const stripe = (text: string, color: string) => (
      <Text mono size="footnote" weight="bold" italic color={color}>{text}</Text>
    )
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={C.edge}
        backgroundColor={C.frame}
        paddingX="xs"
        paddingY={0}
        gap="xs"
        overflow="hidden"
      >
        <Box justifyContent="space-between" alignItems="center" flexWrap="nowrap">
          <Box gap="xs" alignItems="center" flexShrink={0}>
            {stripe('///', C.edge)}
            {cap('|', C.edge)}
            {cap('警告 WARNING', C.edge)}
            {cap('|', C.edge)}
            {cap('Claude-usage', C.note)}
          </Box>
          <Box gap="xs" alignItems="center" flexShrink={0}>
            {cap(PLAN, C.note)}
            {stripe('//', C.note)}
            {stripe('///', C.edge)}
          </Box>
        </Box>
        <Box gap="xs" alignItems="center" flexWrap="nowrap" overflow="hidden">
          {alert}
          {chips}
        </Box>
      </Box>
    )
  })
}
