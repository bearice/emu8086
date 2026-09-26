import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: 8080,
    strictPort: true,
    allowedHosts: [process.env.RAILWAY_PUBLIC_DOMAIN].filter(Boolean),
    hmr: process.env.RAILWAY_PUBLIC_DOMAIN
      ? { protocol: "wss", host: process.env.RAILWAY_PUBLIC_DOMAIN, clientPort: 443 }
      : undefined,
  },
});
