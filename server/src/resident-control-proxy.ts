import net from "node:net";
import readline from "node:readline";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { windowsRuntimeFileIsPrivate } from "./harness-runtime/windows-resident.js";
import { controlRequestTimeoutMs } from "./control-request-lifetime.js";

const MAX_LINE_BYTES = 1024 * 1024;

type JsonRpcRequest = {
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

interface FrontdoorConfiguration {
  token: string;
  host?: string;
  port?: number;
  path?: string;
}

interface FrontdoorResponse {
  ok?: unknown;
  response?: unknown;
  error?: unknown;
}

async function configurationFromFile(): Promise<FrontdoorConfiguration> {
  const configurationPath = process.argv[2];
  if (!configurationPath || !path.isAbsolute(configurationPath)) {
    throw new Error("resident control frontdoor configuration is missing");
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(configurationPath, fsConstants.O_RDONLY | noFollow);
  let raw: string;
  try {
    const stat = await handle.stat();
    const privatePermissions = process.platform === "win32"
      ? await windowsRuntimeFileIsPrivate(configurationPath)
      : (stat.mode & 0o077) === 0;
    if (!stat.isFile() || stat.nlink !== 1 || !privatePermissions || stat.size > 16 * 1024) {
      throw new Error("resident control frontdoor configuration is not private");
    }
    raw = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (parsed.schemaVersion !== 1) {
    throw new Error("resident control frontdoor configuration version is invalid");
  }
  if (typeof parsed.token !== "string" || !parsed.token.trim() || parsed.token.includes("\0")) {
    throw new Error("resident control frontdoor token is invalid");
  }
  if (parsed.path !== undefined) {
    if (typeof parsed.path !== "string" || !parsed.path.startsWith("/")) {
      throw new Error("resident control frontdoor path is invalid");
    }
    return { token: parsed.token, path: parsed.path };
  }
  if (parsed.host !== "127.0.0.1" || !Number.isSafeInteger(parsed.port) ||
    (parsed.port as number) <= 0 || (parsed.port as number) > 65_535) {
    throw new Error("resident control frontdoor endpoint is invalid");
  }
  return { token: parsed.token, host: "127.0.0.1", port: parsed.port as number };
}

function rpcError(id: JsonRpcRequest["id"], message: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    ...(id !== undefined ? { id } : {}),
    error: { code: -32000, message: message.slice(0, 1_000) }
  };
}

async function forward(
  configuration: FrontdoorConfiguration,
  request: JsonRpcRequest
): Promise<Record<string, unknown> | undefined> {
  const response = await new Promise<FrontdoorResponse>((resolve, reject) => {
    const socket = configuration.path
      ? net.createConnection(configuration.path)
      : net.createConnection({ host: configuration.host!, port: configuration.port! });
    let buffered = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("resident control frontdoor did not respond"));
    }, controlRequestTimeoutMs(request.method, true));
    timer.unref();
    const cleanup = () => clearTimeout(timer);
    socket.setEncoding("utf8");
    socket.once("error", (error) => {
      cleanup();
      reject(new Error(`resident control frontdoor is unavailable: ${error.message}`));
    });
    socket.once("end", () => {
      cleanup();
      reject(new Error("resident control frontdoor ended before returning the current result"));
    });
    socket.once("close", () => {
      cleanup();
      reject(new Error("resident control frontdoor closed before returning the current result"));
    });
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      if (Buffer.byteLength(buffered, "utf8") > MAX_LINE_BYTES) {
        cleanup();
        socket.destroy();
        reject(new Error("resident control frontdoor response is too large"));
        return;
      }
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      socket.end();
      try {
        resolve(JSON.parse(buffered.slice(0, newline)) as FrontdoorResponse);
      } catch {
        reject(new Error("resident control frontdoor returned invalid JSON"));
      }
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({
        capability: configuration.token,
        request
      })}\n`);
    });
  });
  if (response.ok !== true) {
    throw new Error(typeof response.error === "string"
      ? response.error
      : "resident control frontdoor rejected the request");
  }
  if (request.id === undefined) return undefined;
  if (!response.response || typeof response.response !== "object" ||
    Array.isArray(response.response)) {
    throw new Error("resident control frontdoor omitted the JSON-RPC response");
  }
  return response.response as Record<string, unknown>;
}

async function main(): Promise<void> {
  const configuration = await configurationFromFile();
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queue: Promise<void> = Promise.resolve();
  input.on("line", (line) => {
    queue = queue.then(async () => {
      let request: JsonRpcRequest | undefined;
      try {
        if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
          throw new Error("resident control request is too large");
        }
        const parsed = JSON.parse(line) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("resident control request is invalid");
        }
        request = parsed as JsonRpcRequest;
        const response = await forward(configuration, request);
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      } catch (error) {
        if (request?.id !== undefined) {
          process.stdout.write(`${JSON.stringify(rpcError(
            request.id,
            error instanceof Error ? error.message : String(error)
          ))}\n`);
        } else {
          process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
    });
  });
  await new Promise<void>((resolve) => input.once("close", resolve));
  await queue;
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
