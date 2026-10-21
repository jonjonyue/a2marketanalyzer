import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The site is one page (both tabs). Everything in ../site is copied as-is: data/ (written by
// scripts/fetch_snapshot.py, never committed) and ledger.html (a redirect for old links).
export default defineConfig({
  base: "./",
  plugins: [react()],
  publicDir: "../site",
  build: { outDir: "dist", emptyOutDir: true },
});
