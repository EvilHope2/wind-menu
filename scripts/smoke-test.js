const { spawn, spawnSync } = require("child_process");

const BASE = "http://127.0.0.1:4310";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSetCookie(headers) {
  const raw = headers.get("set-cookie");
  if (!raw) return "";
  return raw.split(",").map((part) => part.split(";")[0]).join("; ");
}

async function fetchWithCookie(path, opts = {}, cookie = "") {
  const headers = { ...(opts.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${BASE}${path}`, {
    ...opts,
    headers,
    redirect: "manual",
  });
  const nextCookie = parseSetCookie(response.headers) || cookie;
  return { response, cookie: nextCookie };
}

async function main() {
  const seed = spawnSync("node", ["src/seed.js"], {
    cwd: process.cwd(),
    env: { ...process.env, SUPABASE_RUNTIME_SYNC: "0", SUPABASE_PRIMARY: "0" },
    stdio: "pipe",
  });
  if (seed.status !== 0) {
    throw new Error(`Seed previo a test fallo: ${String(seed.stderr || "").trim()}`);
  }

  const env = {
    ...process.env,
    PORT: "4310",
    SUPABASE_RUNTIME_SYNC: "0",
    SUPABASE_PRIMARY: "0",
  };

  const server = spawn("node", ["server.js"], {
    env,
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let booted = false;
  server.stdout.on("data", (chunk) => {
    const line = String(chunk || "");
    if (line.includes("Windi Menu corriendo")) booted = true;
  });
  server.stderr.on("data", (chunk) => {
    process.stderr.write(String(chunk || ""));
  });

  for (let i = 0; i < 40; i += 1) {
    if (booted) break;
    await sleep(250);
  }
  if (!booted) {
    server.kill("SIGTERM");
    throw new Error("Servidor no inicio para smoke test.");
  }

  try {
    const checks = [];

    checks.push(await fetchWithCookie("/"));
    checks.push(await fetchWithCookie("/login"));
    checks.push(await fetchWithCookie("/register"));
    checks.push(await fetchWithCookie("/forgot-password"));
    checks.push(await fetchWithCookie("/pizzeria9420"));

    let session = "";
    const login = await fetchWithCookie(
      "/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          email: "admin@windi.menu",
          password: "admin1234",
        }),
      },
      session
    );
    session = login.cookie;
    checks.push(login);

    const admin = await fetchWithCookie("/admin", {}, session);
    checks.push(admin);

    const stamp = Date.now();
    let commerceCookie = "";
    const register = await fetchWithCookie(
      "/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          full_name: `QA User ${stamp}`,
          business_name: `QA Biz ${stamp}`,
          whatsapp: "5491100000001",
          email: `qa_${stamp}@example.com`,
          password: "qa123456",
        }),
      },
      commerceCookie
    );
    commerceCookie = register.cookie;
    checks.push(register);
    checks.push(await fetchWithCookie("/onboarding/welcome", {}, commerceCookie));
    checks.push(await fetchWithCookie("/onboarding/plan", {}, commerceCookie));

    const failed = checks.filter(({ response }) => response.status >= 500);
    if (failed.length) {
      throw new Error(`Smoke test fallo: ${failed.length} rutas devolvieron 5xx.`);
    }

    console.log("Smoke test OK");
  } finally {
    server.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
