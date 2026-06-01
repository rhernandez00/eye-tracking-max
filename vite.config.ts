import { defineConfig } from "vite";

export default defineConfig({
  // Static SPA; deployed as-is to Cloudflare Pages.
  build: {
    target: "es2020",
    outDir: "dist",
  },
});
