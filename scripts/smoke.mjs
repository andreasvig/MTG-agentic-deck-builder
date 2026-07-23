import { spawn } from "node:child_process";
import { once } from "node:events";

const backendPort = 43_128;
const frontendPort = 41_738;
const backendUrl = `http://127.0.0.1:${backendPort}`;
const frontendUrl = `http://127.0.0.1:${frontendPort}`;
const logs = [];

await assertRejectsHttpsOrigin();

const runner = spawn(process.execPath, ["scripts/dev.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    MTG_HOST: "127.0.0.1",
    MTG_PORT: String(backendPort),
    MTG_FRONTEND_ORIGIN: frontendUrl,
    VITE_API_BASE_URL: `${backendUrl}/api/v1`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

runner.stdout.on("data", (chunk) => logs.push(chunk.toString()));
runner.stderr.on("data", (chunk) => logs.push(chunk.toString()));

try {
  const [frontendResponse, healthResponse] = await Promise.all([
    waitForResponse(`${frontendUrl}/`),
    waitForResponse(`${backendUrl}/api/v1/health`),
  ]);

  const frontendHtml = await frontendResponse.text();
  const health = await healthResponse.json();

  if (!frontendHtml.includes('<div id="root"></div>')) {
    throw new Error("Frontend smoke response did not contain the React root.");
  }
  if (
    health.status !== "ok" ||
    health.service !== "mtg-agentic-deck-builder-api"
  ) {
    throw new Error("Backend smoke response did not match the health contract.");
  }
} catch (error) {
  runner.kill("SIGTERM");
  await waitForExit(runner);
  process.stderr.write(logs.join(""));
  throw error;
}

runner.kill("SIGTERM");
const exit = await waitForExit(runner);
if (exit.code !== 0) {
  process.stderr.write(logs.join(""));
  throw new Error(`Development runner exited with code ${exit.code}.`);
}

await Promise.all([
  assertStopped(`${frontendUrl}/`),
  assertStopped(`${backendUrl}/api/v1/health`),
]);

console.log("Paired development server smoke test passed.");

async function assertRejectsHttpsOrigin() {
  const child = spawn(process.execPath, ["scripts/dev.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MTG_FRONTEND_ORIGIN: "https://127.0.0.1:41738",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const exit = await waitForExit(child);
  if (
    exit.code === 0 ||
    !stderr.includes("must use http for local development")
  ) {
    throw new Error("Development runner accepted an unsupported HTTPS origin.");
  }
}

async function waitForResponse(url) {
  const deadline = Date.now() + 20_000;
  let lastError;

  while (Date.now() < deadline) {
    if (runner.exitCode !== null || runner.signalCode !== null) {
      throw new Error(`Development runner stopped before ${url} became ready.`);
    }

    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }
      lastError = new Error(`${url} returned ${response.status}.`);
    } catch (error) {
      lastError = error;
    }

    await delay(150);
  }

  throw new Error(
    `${url} did not become ready: ${lastError?.message ?? "unknown error"}`,
  );
}

async function assertStopped(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1_000) });
  } catch {
    return;
  }

  throw new Error(`${url} still responded after runner shutdown.`);
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }

  const [code, signal] = await once(child, "exit");
  return { code, signal };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
