import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { parseHint, systemText, useSkillText } from '../hooks/register'

const BAND = {
  plugin: 'usage-meter',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

const READING = { contextPercent: 38, contextWindow: 200000, limits: [] }
const HINT = { shape: 'hint-1', value: { skill: 'impeccable', why: '整 UI' } }

const DEFAULTS: Record<string, unknown> = {
  reading: null,
  isHidden: false,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  lastTurn: 0,
  modelLimits: [],
  skinPick: null,
  live: { at: 0, limits: [] },
  measuredAt: 0,
  hint: { shape: 'hint-1', value: null },
}

// The values the band reads, held so a press can change them.
function seed(on: Parameters<TestBody>[1], values: Record<string, unknown>) {
  const stored = { ...DEFAULTS, ...values }
  let version = 1
  on('clock.now', () => ({ value: Date.parse('2098-12-31T21:30:00Z') }))
  on('state.get', (_, e) => ({ value: { value: stored[e.key], version } }))
  on('state.set', (_, e) => {
    stored[e.key] = e.value
    version += 1
    return { value: { isSet: true, version } }
  })
  return stored
}

test('a hint draws under the meter on every surface', async ($, on) => {
  seed(on, { reading: READING, hint: HINT })
  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /^\/impeccable$/ }))?.text).toBe('/impeccable')
    expect((await ui.find({ type: 'Text', text: /^整 UI$/ }))?.text).toBe('整 UI')
    if (surface === 'terminal') expect((await ui.find({ type: 'Text', text: /^38%$/ }))?.text).toBe('38%')
    else expect(String((await ui.find({ type: 'Svg' }))?.props.source).includes('>38%<')).toBe(true)
    await ui.unmount()
  }
})

test('the hint still shows while the meter is hidden', async ($, on) => {
  seed(on, { reading: READING, isHidden: true, hint: HINT })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^\/impeccable$/ }))?.text).toBe('/impeccable')
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  await ui.unmount()
})

test('with no hint the meter draws alone', async ($, on) => {
  seed(on, { reading: READING })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /可以用/ })).toBeUndefined()
  await ui.unmount()
})

test('the skillHints option turns the hint off', { options: { skillHints: false } }, async ($, on) => {
  seed(on, { reading: READING, hint: HINT })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /可以用/ })).toBeUndefined()
  await ui.unmount()
})

test('the button clears the hint and asks for the skill', async ($, on) => {
  const stored = seed(on, { reading: READING, hint: HINT })
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'use' })
  expect(sent).toEqual([useSkillText('impeccable')])
  expect((stored.hint as { value: unknown }).value).toBeNull()
  await ui.unmount()
})

test('the reply is read only when it names a listed skill', () => {
  const names = new Set(['impeccable', 'pdf'])
  expect(parseHint('{"skill": "pdf", "why": "讀 PDF"}', names)).toEqual({ skill: 'pdf', why: '讀 PDF' })
  expect(parseHint('Sure: {"skill":"impeccable","why":"整 UI"}', names)?.skill).toBe('impeccable')
  expect(parseHint('{"skill": "ui-ux-pro-max", "why": "x"}', names)).toBeNull()
  expect(parseHint('{"skill": null}', names)).toBeNull()
  expect(parseHint('no json here', names)).toBeNull()
})

test('the cached list carries each skill and the UI preference', () => {
  const text = systemText([{ name: 'impeccable', description: 'Design and polish a frontend', source: 'plugin' }])
  expect(text).toContain('- impeccable: Design and polish a frontend')
  expect(text).toContain('ui-ux-pro-max')
})
