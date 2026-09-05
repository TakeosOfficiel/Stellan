const menuButton = document.querySelector('[data-menu-button]')
const menu = document.querySelector('[data-menu]')

menuButton?.addEventListener('click', () => {
  const open = menu?.classList.toggle('open') ?? false
  menuButton.setAttribute('aria-expanded', String(open))
})

document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return
  if (event.target.closest('[data-menu-button], [data-menu]')) return
  menu?.classList.remove('open')
  menuButton?.setAttribute('aria-expanded', 'false')
})

const docsTrigger = document.querySelector('[data-docs-trigger]')
const docsSidebar = document.querySelector('[data-docs-sidebar]')
docsTrigger?.addEventListener('click', () => {
  const open = docsSidebar?.classList.toggle('open') ?? false
  docsTrigger.setAttribute('aria-expanded', String(open))
})

const search = document.querySelector('[data-docs-search]')
const searchableLinks = [...document.querySelectorAll('[data-search-label]')]
const emptyState = document.querySelector('[data-search-empty]')
const searchWords = (value) => value
  .toLocaleLowerCase('fr')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .match(/[a-z0-9]+/g) ?? []
search?.addEventListener('input', () => {
  const query = searchWords(search.value)
  let visible = 0
  for (const link of searchableLinks) {
    const label = searchWords(link.dataset.searchLabel)
    const matches = query.every((needle) => label.some((word) => word.startsWith(needle) || needle.startsWith(word)))
    link.classList.toggle('hidden', !matches)
    if (matches) visible += 1
  }
  emptyState?.classList.toggle('visible', visible === 0)
})

for (const link of document.querySelectorAll('.sidebar-nav a')) {
  link.addEventListener('click', () => docsSidebar?.classList.remove('open'))
}

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const code = button.parentElement?.querySelector('code')?.textContent ?? ''
    await navigator.clipboard.writeText(code)
    const previous = button.textContent
    button.textContent = 'Copié'
    window.setTimeout(() => { button.textContent = previous }, 1400)
  })
}

const observedSections = [...document.querySelectorAll('.doc-section[id]')]
if (observedSections.length && 'IntersectionObserver' in window) {
  const links = [...document.querySelectorAll('.sidebar-nav a, .toc a')]
  const observer = new IntersectionObserver((entries) => {
    const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
    if (!visible) return
    for (const link of links) link.classList.toggle('active', link.getAttribute('href') === `#${visible.target.id}`)
  }, { rootMargin: '-20% 0px -65%', threshold: [0, .2, .6] })
  for (const section of observedSections) observer.observe(section)
}

const primaryDownload = document.querySelector('[data-primary-download]')
if (primaryDownload && /Linux/i.test(navigator.userAgent)) {
  primaryDownload.href = 'https://update.stellan.takeos.fr/linux/Stellan-0.1.15-linux-x86_64.AppImage'
  primaryDownload.querySelector('span').textContent = 'Télécharger pour Linux'
}
