import { defineConfig } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  plugins: [
    nodePolyfills(),
  ],
  base: '/oracle-frontend/', // Replace 'oracle-frontend' if your repo name is different
  build: {
    outDir: 'dist' // Ensure the output directory is 'dist'
  }
}) 