export type WebsiteValidationRequirements = {
  requires3dGallery: boolean
}

export type WebsiteRenderSnapshot = {
  bodyTextLength: number
  visibleContentRegions: number
  visibleInteractiveElements: number
  visibleArticles: number
  visibleModelElements: number
  visibleCanvases: number
  visibleModelViewers: number
  emptyGalleryIds: string[]
  documentWidth: number
  viewportWidth: number
}

export function websiteRenderIssues(
  snapshot: WebsiteRenderSnapshot,
  requirements: WebsiteValidationRequirements,
  consoleErrors: readonly string[] = []
): string[] {
  const issues: string[] = []
  if (consoleErrors.length > 0) {
    issues.push(`JavaScript échoue dans le navigateur : ${consoleErrors.slice(0, 3).join(' ; ')}`)
  }
  if (snapshot.bodyTextLength < 120 || snapshot.visibleContentRegions < 3) {
    issues.push('le rendu reste presque vide et ne présente pas assez de zones de contenu visibles')
  }
  if (snapshot.documentWidth > snapshot.viewportWidth + 2) {
    issues.push('la page déborde horizontalement dans une fenêtre standard')
  }
  if (snapshot.emptyGalleryIds.length > 0) {
    issues.push(`les galeries visibles restent vides : ${snapshot.emptyGalleryIds.join(', ')}`)
  }
  if (requirements.requires3dGallery) {
    const visualizers = snapshot.visibleCanvases + snapshot.visibleModelViewers
    const galleryItems = Math.max(snapshot.visibleArticles, snapshot.visibleModelElements)
    if (visualizers === 0) {
      issues.push('aucun canvas ni visualiseur 3D visible n’est réellement rendu')
    }
    if (galleryItems < 3) {
      issues.push('la galerie 3D ne contient pas au moins trois éléments visibles')
    }
    if (snapshot.visibleInteractiveElements < 3) {
      issues.push('la galerie 3D ne propose pas assez de contrôles ou liens interactifs visibles')
    }
  }
  return issues
}
