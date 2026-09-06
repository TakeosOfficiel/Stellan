import { BrowserWindow } from 'electron'
import {
  websiteRenderIssues,
  type WebsiteRenderSnapshot,
  type WebsiteValidationRequirements
} from './website-render-issues'

export async function inspectRenderedWebsite(
  url: string,
  requirements: WebsiteValidationRequirements
): Promise<string[]> {
  const validationWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: `website-validation-${Date.now()}-${Math.random().toString(36).slice(2)}`
    }
  })
  const consoleErrors: string[] = []
  validationWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  validationWindow.webContents.on('will-navigate', (event, destination) => {
    if (destination !== url) event.preventDefault()
  })
  validationWindow.webContents.on('console-message', (details) => {
    if (details.level === 'error' && details.message.trim() && !consoleErrors.includes(details.message.trim())) {
      consoleErrors.push(details.message.trim().slice(0, 300))
    }
  })
  validationWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))

  try {
    await Promise.race([
      validationWindow.loadURL(url),
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error('le chargement du rendu a dépassé 15 secondes')),
        15_000
      ))
    ])
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    const snapshot = await validationWindow.webContents.executeJavaScript(`(() => {
      const visible = (element) => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && rect.width > 8 && rect.height > 8
      }
      const count = (selector) => [...document.querySelectorAll(selector)].filter(visible).length
      const emptyGalleryIds = [...document.querySelectorAll('[id]')]
        .filter((element) => /(?:gallery|galerie|models?|modeles?|products?|produits?)/i.test(element.id))
        .filter(visible)
        .filter((element) => element.children.length === 0 && !(element.textContent || '').trim())
        .map((element) => element.id)
      return {
        bodyTextLength: (document.body?.innerText || '').trim().length,
        visibleContentRegions: count('header, nav, main, section, footer'),
        visibleInteractiveElements: count('a[href], button, input, select, textarea, [role="button"]'),
        visibleArticles: count('article'),
        visibleModelElements: count('[data-model], [class~="card"], [class*="-card"], .model-item, .model-viewer'),
        visibleCanvases: count('canvas'),
        visibleModelViewers: count('model-viewer, [data-3d-viewer]'),
        emptyGalleryIds,
        documentWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
        viewportWidth: document.documentElement.clientWidth
      }
    })()`) as WebsiteRenderSnapshot
    return websiteRenderIssues(snapshot, requirements, consoleErrors)
  } catch (error) {
    return [`le site ne charge pas correctement dans le navigateur : ${error instanceof Error ? error.message : 'erreur inconnue'}`]
  } finally {
    validationWindow.destroy()
  }
}
