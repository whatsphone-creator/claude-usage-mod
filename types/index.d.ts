export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Reading = {
  contextPercent?: number
  contextTokens?: number
  contextWindow: number
  limits: Limit[]
  usd?: number
}
// Tokens this session's turns have used, summed from each turn's reported usage.
export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

declare module 'claude-code' {
  interface PluginState {
    'usage-meter': { reading: Reading | null; isHidden: boolean; tokens: Tokens; lastTurn: number }
  }
}
