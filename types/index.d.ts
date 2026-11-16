export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Reading = {
  contextPercent?: number
  contextTokens?: number
  contextWindow: number
  limits: Limit[]
}
// The 5-hour and 7-day windows as the account's usage endpoint gave them at `at` (ms since the epoch).
export type Live = { at: number; limits: Limit[] }
// Tokens this session's turns have used, summed from each turn's reported usage.
export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

declare module 'claude-code' {
  interface PluginState {
    'usage-meter': { reading: Reading | null; isHidden: boolean; tokens: Tokens; lastTurn: number; modelLimits: Limit[]; modelNote: string; skinPick: 'dark' | 'light' | null; live: Live; measuredAt: number }
  }
}
