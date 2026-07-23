import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import path from "node:path";

const isWindows = process.platform === "win32";
const backendPython = path.join(
  "backend",
  ".venv",
  isWindows ? "Scripts" : "bin",
  isWindows ? "python.exe" : "python",
);
const viteEntry = path.join("frontend", "node_modules", "vite", "bin", "vite.js");
const backendHost = process.env.MTG_HOST ?? "127.0.0.1";
const backendPort = parsePort(process.env.MTG_PORT ?? "43127", "MTG_PORT");
const frontendOrigin = new URL(
  process.env.MTG_FRONTEND_ORIGIN ?? "http://127.0.0.1:41737",
);
const frontendPort = parsePort(
  frontendOrigin.port || defaultPort(frontendOrigin.protocol),
  "MTG_FRONTEND_ORIGIN",
);
const apiBaseUrl =
  process.env.VITE_API_BASE_URL ??
  `http://${backendHost}:${backendPort}/api/v1`;
const children = new Set();
let shuttingDown = false;

validateFrontendOrigin(frontendOrigin);

await Promise.all([
  assertPortAvailable(backendHost, backendPort, "backend"),
  assertPortAvailable(frontendOrigin.hostname, frontendPort, "frontend"),
]);

const backend = start(
  "backend",
  backendPython,
  [
    "-m",
    "uvicorn",
    "mtg_deck_builder.main:app",
    "--reload",
    "--host",
    backendHost,
    "--port",
    String(backendPort),
  ],
  {
    MTG_HOST: backendHost,
    MTG_PORT: String(backendPort),
    MTG_FRONTEND_ORIGIN: frontendOrigin.origin,
  },
);

const frontend = start(
  "frontend",
  process.execPath,
  [
    path.resolve(viteEntry),
    "--host",
    frontendOrigin.hostname,
    "--port",
    String(frontendPort),
    "--strictPort",
  ],
  { VITE_API_BASE_URL: apiBaseUrl },
  path.resolve("frontend"),
);

console.log(`Backend:  http://${backendHost}:${backendPort}`);
console.log(`Frontend: ${frontendOrigin.origin}`);
console.log("Press Ctrl+C to stop both services.");

for (const [name, child] of [
  ["backend", backend],
  ["frontend", frontend],
]) {
  child.once("error", (error) => {
    console.error(`Failed to start ${name}: ${error.message}`);
    void shutdown(1);
  });
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!shuttingDown) {
      const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
      console.error(`${name} stopped unexpectedly (${detail}).`);
      void shutdown(code && code > 0 ? code : 1);
    }
  });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => void shutdown(0));
}
process.once("exit", terminateChildren);

function start(name, command, args, extraEnv, cwd = process.cwd()) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
  });
  child.serviceName = name;
  children.add(child);
  return child;
}

async function shutdown(exitCode) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  await Promise.allSettled([...children].map(stop));
  process.exit(exitCode);
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  if (isWindows) {
    const killer = spawn(
      "taskkill",
      ["/pid", String(child.pid), "/T", "/F"],
      { stdio: "ignore" },
    );
    await once(killer, "exit");
    return;
  }

  const exitPromise = once(child, "exit").then(() => true);
  child.kill("SIGTERM");
  const exited = await Promise.race([
    exitPromise,
    delay(5_000).then(() => false),
  ]);

  if (!exited) {
    child.kill("SIGKILL");
  }
}

function terminateChildren() {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }
}

function assertPortAvailable(host, port, serviceName) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        reject(
          new Error(
            `${serviceName} port ${host}:${port} is already in use; stop that service or choose another port in .env.`,
          ),
        );
        return;
      }
      reject(error);
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close(resolve);
    });
  });
}

function parsePort(value, variableName) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${variableName} must contain a valid TCP port.`);
  }
  return port;
}

function defaultPort(protocol) {
  if (protocol === "http:") {
    return "80";
  }
  throw new Error("MTG_FRONTEND_ORIGIN must use http for local development.");
}

function validateFrontendOrigin(origin) {
  if (origin.protocol !== "http:") {
    throw new Error("MTG_FRONTEND_ORIGIN must use http for local development.");
  }
  if (
    origin.pathname !== "/" ||
    origin.search.length > 0 ||
    origin.hash.length > 0
  ) {
    throw new Error("MTG_FRONTEND_ORIGIN must be an origin without a path.");
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
