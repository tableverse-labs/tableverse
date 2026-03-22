import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist-lite",
    rollupOptions: {
      input: "index-lite.html",
    },
  },
  optimizeDeps: {
    exclude: ["@duckdb/duckdb-wasm"],
  },
  worker: {
    format: "es",
  },
});
