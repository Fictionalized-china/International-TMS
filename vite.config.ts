import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const mysqlRuntime = process.env.TMS_RUNTIME === "mysql";

export default defineConfig({
  build: {
    target: ["chrome87", "edge88", "firefox78"],
  },
  server: {
    host: "127.0.0.1",
    port: 5188,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 4188,
    strictPort: true,
  },
  plugins: [
    ...(mysqlRuntime ? [] : [cloudflare({ viteEnvironment: { name: "ssr" } })]),
    tailwindcss(),
    reactRouter(),
  ],
  resolve: {
    tsconfigPaths: true,
    alias: mysqlRuntime
      ? {
          "cloudflare:workers": fileURLToPath(new URL(
            "./app/runtime/mysql-env.server.ts",
            import.meta.url,
          )),
        }
      : undefined,
  },
  ssr: mysqlRuntime ? { external: ["mysql2", "mysql2/promise"] } : undefined,
});
