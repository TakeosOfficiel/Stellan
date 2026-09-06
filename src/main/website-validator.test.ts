import { describe, expect, it } from 'vitest'
import { websiteRenderIssues, type WebsiteRenderSnapshot } from './website-render-issues'

const complete: WebsiteRenderSnapshot = {
  bodyTextLength: 500,
  visibleContentRegions: 6,
  visibleInteractiveElements: 5,
  visibleArticles: 3,
  visibleModelElements: 3,
  visibleCanvases: 3,
  visibleModelViewers: 0,
  emptyGalleryIds: [],
  documentWidth: 1280,
  viewportWidth: 1280
}

describe('websiteRenderIssues', () => {
  it('rejects the visually empty 3D gallery that a model falsely described as complete', () => {
    expect(websiteRenderIssues({
      ...complete,
      visibleInteractiveElements: 2,
      visibleArticles: 0,
      visibleModelElements: 0,
      visibleCanvases: 0,
      emptyGalleryIds: ['models']
    }, { requires3dGallery: true })).toEqual(expect.arrayContaining([
      expect.stringContaining('galeries visibles restent vides'),
      expect.stringContaining('aucun canvas'),
      expect.stringContaining('trois éléments visibles'),
      expect.stringContaining('contrôles ou liens interactifs')
    ]))
  })

  it('accepts a populated and interactive 3D gallery', () => {
    expect(websiteRenderIssues(complete, { requires3dGallery: true })).toEqual([])
  })

  it('reports JavaScript errors and horizontal overflow', () => {
    expect(websiteRenderIssues({
      ...complete,
      documentWidth: 1400
    }, { requires3dGallery: false }, ['THREE is not defined'])).toEqual([
      'JavaScript échoue dans le navigateur : THREE is not defined',
      'la page déborde horizontalement dans une fenêtre standard'
    ])
  })
})
