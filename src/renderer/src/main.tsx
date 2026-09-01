import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

const root = document.getElementById('root')

if (!root) throw new Error("L'élément racine est introuvable.")

createRoot(root).render(
  <StrictMode>
    {window.localAgent ? (
      <App />
    ) : (
      <main className="startup-error">
        <h1>Local Agent n’a pas pu démarrer</h1>
        <p>Le composant sécurisé Electron n’a pas été chargé. Redémarrez l’application.</p>
      </main>
    )}
  </StrictMode>
)
