import descriptorTreeShake from "@polkadot-api/rollup-plugin-descriptor-treeshake"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [descriptorTreeShake()],
  build: {
    target: "esnext",
    rollupOptions: {
      shimMissingExports: true,
    },
  },
  optimizeDeps: {
    esbuildOptions: { target: "esnext" },
  },
})
