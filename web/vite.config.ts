import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const webPort = 5173;
const apiTarget =
  process.env.SCIENCEEVOLVE_API_URL || "http://127.0.0.1:4311";

function notebookProxyUrl(): URL | undefined {
  const template = process.env.VSCODE_PROXY_URI?.trim();
  if (!template) return undefined;

  try {
    return new URL(template.replace("{{port}}", String(webPort)));
  } catch {
    return undefined;
  }
}

function normalizeBase(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "./";
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function strippedProxyBasePlugin(base: string) {
  const mount = base.startsWith("/") ? base.replace(/\/$/, "") : "";
  const restoreUrl = (req: { url?: string }) => {
    // Inspire strips /.../proxy/<port>/ before forwarding the request to the
    // container. Vite still needs to see its configured base so that its own
    // base middleware can normalize the request without redirecting it.
    if (
      mount &&
      req.url &&
      !req.url.startsWith(mount) &&
      !req.url.startsWith("/api")
    ) {
      req.url = `${mount}${req.url.startsWith("/") ? "" : "/"}${req.url}`;
    }
  };
  const restoreMount = (
    req: { url?: string },
    _res: unknown,
    next: () => void
  ) => {
    restoreUrl(req);
    next();
  };

  return {
    name: "scienceevolve-inspire-proxy-base",
    configureServer(server: {
      middlewares: { use: (handler: typeof restoreMount) => void };
      httpServer: {
        prependListener: (
          event: "upgrade",
          listener: (req: { url?: string }) => void
        ) => void;
      } | null;
    }) {
      // WebSocket upgrades bypass Connect middleware, so restore the stripped
      // base before Vite compares the request path with its HMR endpoint.
      server.httpServer?.prependListener("upgrade", restoreUrl);
      server.middlewares.use(restoreMount);
    },
    configurePreviewServer(server: { middlewares: { use: (handler: typeof restoreMount) => void } }) {
      server.middlewares.use(restoreMount);
    }
  };
}

export default defineConfig(({ command }) => {
  const proxyUrl = notebookProxyUrl();
  const configuredBase = process.env.SCIENCEEVOLVE_WEB_BASE?.trim();
  // Vite's development-only clients use root-absolute module URLs unless the
  // full Notebook proxy prefix is configured. A relative `./` base is enough
  // for production assets, but not for /@vite/client or /@react-refresh.
  const base =
    command === "serve"
      ? normalizeBase(configuredBase || proxyUrl?.pathname || "./")
      : "./";
  const allowedHosts = [
    "nat2-notebook-inspire.sii.edu.cn",
    proxyUrl?.hostname
  ].filter((host, index, hosts): host is string =>
    Boolean(host) && hosts.indexOf(host) === index
  );

  return {
    base,
    plugins: [strippedProxyBasePlugin(base), react()],
    server: {
      port: webPort,
      strictPort: true,
      host: process.env.SCIENCEEVOLVE_WEB_HOST || "0.0.0.0",
      // Workspace previews terminate on a generated reverse-proxy hostname.
      // Vite's default host allowlist rejects that request with 403, which the
      // preview shell presents as an empty page.
      allowedHosts,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true
        }
      }
    },
    preview: {
      port: webPort,
      strictPort: true,
      host: process.env.SCIENCEEVOLVE_WEB_HOST || "0.0.0.0",
      allowedHosts,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true
        }
      }
    }
  };
});
