import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MotionConfig } from 'motion/react'
import './styles/tokens.css'
import './styles/fonts.css'
import './styles/base.css'
import { inktideStore } from './data/store.ts'
import { InkProvider } from './ink/InkProvider.tsx'
import { App } from './App.tsx'

inktideStore.applyThemeToDocument()
inktideStore.initSystemListeners()

const rootElement = document.getElementById('root')
if (rootElement !== null) {
  createRoot(rootElement).render(
    <StrictMode>
      <MotionConfig reducedMotion="user">
        <InkProvider>
          <App />
        </InkProvider>
      </MotionConfig>
    </StrictMode>,
  )
}
