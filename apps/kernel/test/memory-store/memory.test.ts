import { createMemoryRecordStore } from '../../src/memory-store/index.ts'
import { recordStoreSuite } from './suite.ts'

recordStoreSuite('in-memory record store', async (clock) => {
  const store = createMemoryRecordStore({ clock })
  return { store, cleanup: async () => { /* nothing on disk */ } }
})
