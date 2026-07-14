import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, "public"),
    emptyOutDir: true,
  },
});
