import { expect, test } from 'claude-code/testing'

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

test('the band draws context, limits and tokens on every surface', async ($, on) => {
  on('clock.now', () => ({ value: Date.parse('2098-12-31T21:30:00Z') }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('state.get', (_, e) =>
    e.key === 'reading'
      ? {
          value: {
            value: {
              contextPercent: 38,
              contextTokens: 76000,
              contextWindow: 200000,
              limits: [
                { kind: 'five_hour', percentUsed: 82, resetsAt: '2099-01-01T00:00:00Z' },
                { kind: 'seven_day', percentUsed: 8 },
              ],
            },
            version: 1,
          },
        }
      : e.key === 'tokens'
        ? { value: { value: { input: 1000, output: 85000, cacheRead: 12000000, cacheWrite: 200000 }, version: 1 } }
        : e.key === 'lastTurn'
          ? { value: { value: 215000, version: 1 } }
          : { value: { value: false, version: 1 } },
  )

  // Terminal: the text row.
  const term = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await term.find({ type: 'Text', text: /^38%$/ }))?.text).toBe('38%')
  expect(await term.find({ type: 'Text', text: /200k/ })).toBeUndefined()
  expect((await term.find({ type: 'Text', text: /^82%$/ }))?.text).toBe('82%')
  expect((await term.find({ type: 'Text', text: /^12\.3M$/ }))?.text).toBe('12.3M')
  expect(await term.find({ type: 'Text', text: /OUT/ })).toBeUndefined()
  expect((await term.find({ type: 'Text', text: /^\+215k$/ }))?.text).toBe('+215k')
  expect(await term.find({ type: 'Text', text: /\$/ })).toBeUndefined()
  expect((await term.find({ type: 'Text', text: /^02:30$/ }))?.text).toBe('02:30')
  await term.unmount()

  // Desktop and mobile: one SVG with octagon frames carrying the same readouts.
  for (const surface of ['desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const svg = await ui.find({ type: 'Svg' })
    const source = String(svg?.props.source ?? '')
    for (const shown of ['>38%<', '>82%<', '>TOK<', '>12.3M<', '>+215k<', '>02:30<', '>Claude-usage<', '>ULTRA PLAN<']) {
      expect(source.includes(shown)).toBe(true)
    }
    expect(source.includes('200k')).toBe(false)
    expect(source.includes('$')).toBe(false)
    expect(source.includes('OUT')).toBe(false)
    expect(String(svg?.props.alt ?? '')).toContain('Context 38%')
    await ui.unmount()
  }
})
