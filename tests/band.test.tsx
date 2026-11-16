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

test('the band draws context, limits and tokens on every surface', { options: { plan: 'ULTRA PLAN' } }, async ($, on) => {
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
                { kind: 'seven_day', percentUsed: 8, resetsAt: '2099-01-03T00:00:00Z' },
              ],
            },
            version: 1,
          },
        }
      : e.key === 'tokens'
        ? { value: { value: { input: 1000, output: 85000, cacheRead: 12000000, cacheWrite: 200000 }, version: 1 } }
        : e.key === 'modelLimits'
          ? { value: { value: [{ kind: 'weekly_scoped:claude-fable-5', percentUsed: 41, resetsAt: '2099-01-03T00:00:00Z' }], version: 1 } }
          : e.key === 'modelNote'
            ? { value: { value: '', version: 1 } }
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
  expect((await term.find({ type: 'Text', text: /^FABLE$/ }))?.text).toBe('FABLE')
  expect((await term.find({ type: 'Text', text: /^41%$/ }))?.text).toBe('41%')
  await term.unmount()

  // Desktop and mobile: one SVG with octagon frames carrying the same readouts.
  for (const surface of ['desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const svg = await ui.find({ type: 'Svg' })
    const source = String(svg?.props.source ?? '')
    for (const shown of ['>38%<', '>82%<', '>TOK<', '>12.3M<', '>+215k<', '>02:30<', '>Claude-usage<', '>ULTRA PLAN<', '>FABLE<', '>41%<', '>2d02:30<', '>7D<', '>8%<']) {
      expect(source.includes(shown)).toBe(true)
    }
    // 7D and FABLE reset together, so they share one chip and one countdown.
    expect(source.split('>2d02:30<').length - 1).toBe(1)
    expect(source.includes('200k')).toBe(false)
    expect(source.includes('$')).toBe(false)
    expect(source.includes('OUT')).toBe(false)
    expect(String(svg?.props.alt ?? '')).toContain('Context 38%')
    await ui.unmount()
  }
})

test('with no plan option the header shows no plan label', async ($, on) => {
  on('clock.now', () => ({ value: Date.parse('2098-12-31T21:30:00Z') }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('state.get', (_, e) =>
    e.key === 'reading'
      ? { value: { value: { contextPercent: 38, contextWindow: 200000, limits: [] }, version: 1 } }
      : e.key === 'tokens'
        ? { value: { value: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, version: 1 } }
        : e.key === 'modelLimits'
          ? { value: { value: [], version: 1 } }
          : e.key === 'lastTurn'
            ? { value: { value: 0, version: 1 } }
            : { value: { value: false, version: 1 } },
  )
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const source = String((await ui.find({ type: 'Svg' }))?.props.source ?? '')
  expect(source.includes('>Claude-usage<')).toBe(true)
  expect(source.includes('PLAN')).toBe(false)
  await ui.unmount()
})

for (const [skin, has, hasNot] of [
  ['light', '#f7f1e6', '#0d0717'],
  ['dark', '#0d0717', 'prefers-color-scheme'],
  ['auto', 'prefers-color-scheme: light', '>undefined<'],
] as const) {
  test(`the ${skin} skin dresses the drawing`, { options: { skin } }, async ($, on) => {
    on('clock.now', () => ({ value: Date.parse('2098-12-31T21:30:00Z') }))
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    on('state.get', (_, e) =>
      e.key === 'reading'
        ? { value: { value: { contextPercent: 38, contextWindow: 200000, limits: [{ kind: 'five_hour', percentUsed: 82 }] }, version: 1 } }
        : e.key === 'tokens'
          ? { value: { value: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, version: 1 } }
          : e.key === 'modelLimits'
            ? { value: { value: [], version: 1 } }
            : e.key === 'lastTurn'
              ? { value: { value: 0, version: 1 } }
              : { value: { value: false, version: 1 } },
    )
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    const source = String((await ui.find({ type: 'Svg' }))?.props.source ?? '')
    expect(source.includes(has)).toBe(true)
    expect(source.includes(hasNot)).toBe(false)
    expect(source.includes('>82%<')).toBe(true)
    await ui.unmount()
  })
}

test('the button beside the band flips the skin', { options: { skin: 'dark' } }, async ($, on) => {
  on('clock.now', () => ({ value: Date.parse('2098-12-31T21:30:00Z') }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('state.get', (_, e, next) =>
    e.key === 'skinPick'
      ? next(e)
      : e.key === 'reading'
        ? { value: { value: { contextPercent: 38, contextWindow: 200000, limits: [] }, version: 1 } }
        : e.key === 'tokens'
          ? { value: { value: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, version: 1 } }
          : e.key === 'modelLimits'
            ? { value: { value: [], version: 1 } }
            : e.key === 'lastTurn'
              ? { value: { value: 0, version: 1 } }
              : { value: { value: false, version: 1 } },
  )
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const drawn = async () => String((await ui.find({ type: 'Svg' }))?.props.source ?? '')
  expect((await drawn()).includes('#0d0717')).toBe(true)
  await ui.press({ key: 'skin' })
  expect((await drawn()).includes('#f7f1e6')).toBe(true)
  await ui.press({ key: 'skin' })
  expect((await drawn()).includes('#0d0717')).toBe(true)
  await ui.unmount()
})
