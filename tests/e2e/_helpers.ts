import "dotenv/config";

export interface E2EEnv {
  baseURL: string;
  apiKey: string;
  username: string;
  password: string;
}

/**
 * Reads the env vars the existing system tests use. Fails loudly if any are
 * missing. Tests should call this in beforeAll so they fail clearly rather
 * than mid-test when an undefined header gets sent.
 *
 * Username: defaults to `sam_admin` (the super_admin DB user). Override via
 * `E2E_USER` env var. Either user "admin" + ROOT_PASSWORD, or any DB
 * user + their actual password, will authenticate the server-side middleware.
 */
export function getEnv(): E2EEnv {
  const baseURL = process.env.SYSTEM_TEST_URL || process.env.BASE_URL;
  const apiKey = process.env.API_KEY;
  const password = process.env.ROOT_PASSWORD || process.env.ADMIN_PASSWORD;
  const username = process.env.E2E_USER || "sam_admin";

  if (!baseURL || !apiKey || !password) {
    throw new Error(
      "E2E env missing — need SYSTEM_TEST_URL (or BASE_URL), API_KEY, and ROOT_PASSWORD (or ADMIN_PASSWORD).",
    );
  }
  return { baseURL: baseURL.replace(/\/$/, ""), apiKey, username, password };
}

export function basicAuthHeader(env: E2EEnv): string {
  return "Basic " + Buffer.from(`${env.username}:${env.password}`).toString("base64");
}

/** Apply session-cookie-style Basic Auth to the browser context so the
 *  native browser auth dialog never appears. Used for `apiFetch` (outside
 *  the browser) where we manually attach headers. */
export function authHeaders(env: E2EEnv): Record<string, string> {
  return {
    Authorization: basicAuthHeader(env),
  };
}

/** Playwright-native Basic Auth credentials. Pass to `test.use({ httpCredentials })`
 *  so the browser navigates with HTTP Basic Auth without prompting. This is the
 *  canonical way to pre-auth in Playwright; raw `extraHTTPHeaders` doesn't reliably
 *  attach to navigations. */
export function httpCredentials(env: E2EEnv): { username: string; password: string } {
  return { username: env.username, password: env.password };
}

/** Server-side fetch (outside browser context) for arrange/assert helpers. */
export async function apiFetch(
  env: E2EEnv,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "x-api-key": env.apiKey,
    Authorization: basicAuthHeader(env),
    "Content-Type": "application/json",
    ...((init.headers as Record<string, string>) ?? {}),
  };
  return fetch(env.baseURL + path, { ...init, headers });
}

/** Convenience: GET + parse JSON, throws on non-2xx. */
export async function apiGet<T>(env: E2EEnv, path: string): Promise<T> {
  const resp = await apiFetch(env, path);
  if (!resp.ok) {
    throw new Error(`apiGet ${path} failed: ${resp.status} ${await resp.text()}`);
  }
  return (await resp.json()) as T;
}

/** Convenience: PATCH JSON body. */
export async function apiPatch<T>(
  env: E2EEnv,
  path: string,
  body: unknown,
): Promise<T> {
  const resp = await apiFetch(env, path, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`apiPatch ${path} failed: ${resp.status} ${await resp.text()}`);
  }
  return (await resp.json()) as T;
}

/** Demo Meter is the canonical test agent across system + e2e tests. */
export const DEMO_METER = {
  slug: "demo-meter",
  agentId: "agent_27340aa43ebbc5f4822a35225a",
} as const;
