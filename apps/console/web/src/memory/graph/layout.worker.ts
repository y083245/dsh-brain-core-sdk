import { computeLayout, type LayoutInput } from './layout.ts'

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<LayoutInput>) => void) | null
  postMessage: (positions: Float32Array, transfer: Transferable[]) => void
}

scope.onmessage = (event) => {
  const positions = computeLayout(event.data)
  scope.postMessage(positions, [positions.buffer])
}
