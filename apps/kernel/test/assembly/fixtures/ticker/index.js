export async function apply(ctx) {
  const state = (globalThis.__brainTicker ??= { runs: 0 })
  ctx.scheduler.every(60_000, () => { state.runs += 1 })
}
