import { defineConfig } from 'vite';
export default defineConfig({ base: './', root: 'src/renderer', build: { outDir: '../../dist/renderer', emptyOutDir: true } });
