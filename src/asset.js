// Resolves a public/ asset against Vite's base URL, so the game works both
// at the domain root (dev) and under a subpath (GitHub Pages /fablerace/).
export function asset(path) {
  return import.meta.env.BASE_URL + path.replace(/^\//, '');
}
