import { defineConfig } from "vite";

const repositoryName = process.env.GITHUB_REPOSITORY?.split("/")[1];
const isProjectPagesBuild = process.env.GITHUB_ACTIONS === "true"
  && repositoryName !== undefined
  && !repositoryName.toLowerCase().endsWith(".github.io");
const base = isProjectPagesBuild
  ? `/${repositoryName}/`
  : "/";

export default defineConfig({
  base,
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
