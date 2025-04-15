import { defineConfig } from 'vite'

export default defineConfig({
  base: '/oracle-frontend/', // Replace 'oracle-frontend' if your repo name is different
  build: {
    outDir: 'dist' // Ensure the output directory is 'dist'
  }
}) 