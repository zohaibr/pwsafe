import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ApiProvider } from './api'
import { App } from './App'
import { selectApi } from './selectApi'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root')

void selectApi().then(({ api, generate, mockControls }) => {
  if (mockControls) (window as unknown as { __psafeMock: unknown }).__psafeMock = mockControls
  createRoot(root).render(
    <StrictMode>
      <ApiProvider api={api} generate={generate}>
        <App />
      </ApiProvider>
    </StrictMode>,
  )
})
