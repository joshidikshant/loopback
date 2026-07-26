import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// Built output is COMMITTED (public/dashboard) so `npx loopback-mcp-server`
// never needs React, Tailwind or a build step — the hub just serves files.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/dashboard/",
  build: { outDir: "../public/dashboard", emptyOutDir: true },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
