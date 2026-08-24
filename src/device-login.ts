/**
 * Device-code login (plans/base.md §7).
 *
 * `/rc login` runs this: ask the relay for a code, show the user a URL to open
 * in an already-logged-in browser, then poll until the browser approves and the
 * relay hands back a machine token. The token is written to ~/.pi/pietin.json,
 * which `/rc` reads before falling back to PIETIN_TOKEN.
 *
 * No browser copy-paste, no PIETIN_TOKEN needed after the first login.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Where the machine token is persisted. PIETIN_TOKEN_FILE overrides the default
 * (~/.pi/pietin.json) — used by scripts/e2e.py to isolate the test's token from
 * the developer's real one.
 */
export function tokenFilePath(): string {
  return process.env.PIETIN_TOKEN_FILE ?? path.join(os.homedir(), ".pi", "pietin.json");
}

/** Reads the stored machine token, or undefined if none/unreadable. */
export function loadStoredToken(): string | undefined {
  try {
    const raw = fs.readFileSync(tokenFilePath(), "utf8");
    const parsed = JSON.parse(raw) as { token?: unknown };
    if (typeof parsed.token === "string" && parsed.token) return parsed.token;
  } catch {
    // No file yet, or malformed — treat as "not logged in".
  }
  return undefined;
}

/** Persists the machine token (0600) alongside the relay it belongs to. */
export function saveToken(token: string, relay: string): void {
  const p = tokenFilePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ token, relay }, null, 2) + "\n", {
    mode: 0o600,
  });
}

/** Derives the HTTP API base from the extension's WebSocket URL. */
export function httpBase(wsUrl: string): string {
  try {
    const u = new URL(wsUrl);
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    u.pathname = "";
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return "https://pietin.sh";
  }
}

export interface DeviceLoginUI {
  /** Show the user where to approve this machine. Must not throw. */
  onVerificationUri: (uri: string, userCode: string) => void;
}

export interface DeviceLoginResult {
  token: string;
  relay: string;
}

interface CodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval?: number;
  expires_in?: number;
}

interface TokenResponse {
  status: string;
  token?: string;
}

/**
 * Runs the device-code flow against the relay derived from `wsUrl`. Resolves
 * with the token (already saved to disk), or rejects on expiry/timeout/failure.
 */
export async function deviceLogin(
  wsUrl: string,
  ui: DeviceLoginUI,
): Promise<DeviceLoginResult> {
  const base = httpBase(wsUrl);

  const codeRes = await fetch(`${base}/api/device/code`, { method: "POST" });
  if (!codeRes.ok) {
    throw new Error(`relay refused a device code (${codeRes.status})`);
  }
  const code = (await codeRes.json()) as CodeResponse;

  ui.onVerificationUri(code.verification_uri, code.user_code);
  // The harness reads the URL from here instead of scraping the rendered TUI.
  echoForHarness(code.verification_uri);

  const intervalMs = Math.max(1, code.interval ?? 2) * 1000;
  const deadline = Date.now() + (code.expires_in ?? 600) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    let res: Response;
    try {
      res = await fetch(`${base}/api/device/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_code: code.device_code }),
      });
    } catch {
      continue; // transient network blip; keep polling until the deadline
    }
    if (!res.ok) continue;
    const body = (await res.json()) as TokenResponse;
    if (body.status === "approved" && body.token) {
      saveToken(body.token, base);
      return { token: body.token, relay: base };
    }
    if (body.status === "expired") {
      throw new Error("the login code expired — run /rc login again");
    }
    // "pending" — keep polling.
  }
  throw new Error("login timed out — run /rc login again");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Writes the verification URL to a file when PIETIN_LOGIN_ECHO_FILE is set. Used
 * only by scripts/e2e.py to learn the code without scraping the rendered TUI;
 * unset in normal use, so this is a no-op in production.
 */
function echoForHarness(uri: string): void {
  const file = process.env.PIETIN_LOGIN_ECHO_FILE;
  if (!file) return;
  try {
    fs.writeFileSync(file, uri + "\n");
  } catch {
    // best-effort; the harness will time out and report if it never appears
  }
}
