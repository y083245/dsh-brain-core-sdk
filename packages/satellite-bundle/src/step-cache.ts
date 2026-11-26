/**
 * Shares one surface lookup across every tool's `when` within a single model step.
 *
 * DSH creates a new `modelSelection` object for each step. Its `signal` does not work
 * as a key: one signal spans the whole turn, which would freeze the surface after the
 * first step and silently break activation.
 *
 * The load gets the arguments of the call that started it, so a step's request carries
 * that step's own signal instead of one captured when the cache was made.
 */
export function stepCache<T, A extends unknown[] = []>(load: (stepKey: object, ...args: A) => Promise<T>): (stepKey: object, ...args: A) => Promise<T> {
  const entries = new WeakMap<object, Promise<T>>()
  return (stepKey, ...args) => {
    let entry = entries.get(stepKey)
    if (entry === undefined) {
      entry = load(stepKey, ...args)
      entries.set(stepKey, entry)
    }
    return entry
  }
}
