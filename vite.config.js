import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  // GitHub Pages serves the site under /<repo>/ — dev stays at the root
  base: command === 'build' ? '/fablerace/' : '/',
}));
