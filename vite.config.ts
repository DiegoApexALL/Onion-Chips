import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',
  // Um único arquivo JS: a página publicada no Claude é montada como um só HTML
  build: { rollupOptions: { output: { inlineDynamicImports: true } } },
})
