import { getLiveEnv } from "./env.js";

// Thin wrapper around fetch that:
//   - prefixes baseURL
//   - attaches x-api-key + Basic Auth (admin:ROOT_PASSWORD → root user, bypasses every requireFeature gate)
//   - JSON encodes the body and parses the response
//   - throws with status + body on non-2xx unless `expectError` is true

export interface ApiOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
  /** Don't throw on 4xx/5xx; the caller wants to inspect the error response. */
  expectError?: boolean;
}

export async function apiFetch(path: string, opts: ApiOptions = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const env = getLiveEnv();
  const url = path.startsWith("http") ? path : `${env.baseURL}${path}`;
  const basicAuth = "Basic " + Buffer.from(`admin:${env.rootPassword}`).toString("base64");

  const init: RequestInit = {
    method: opts.method ?? "GET",
    headers: {
      "x-api-key": env.apiKey,
      "Authorization": basicAuth,
      "Content-Type": "application/json",
      ...(opts.headers ?? {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  };

  const resp = await fetch(url, init);
  let body: unknown = null;
  const text = await resp.text();
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!opts.expectError && !resp.ok) {
    const summary = typeof body === "string" ? body : JSON.stringify(body);
    throw new Error(`${init.method} ${path} → ${resp.status} ${summary.slice(0, 500)}`);
  }
  return { status: resp.status, body, headers: resp.headers };
}

/** Convenience for GET. Throws on non-2xx. */
export async function apiGet<T = any>(path: string): Promise<T> {
  const r = await apiFetch(path, { method: "GET" });
  return r.body as T;
}

/** Convenience for POST. Throws on non-2xx. */
export async function apiPost<T = any>(path: string, body?: unknown): Promise<T> {
  const r = await apiFetch(path, { method: "POST", body });
  return r.body as T;
}

/** Convenience for PATCH. Throws on non-2xx. */
export async function apiPatch<T = any>(path: string, body?: unknown): Promise<T> {
  const r = await apiFetch(path, { method: "PATCH", body });
  return r.body as T;
}

/** Convenience for DELETE. Throws on non-2xx. */
export async function apiDelete<T = any>(path: string): Promise<T> {
  const r = await apiFetch(path, { method: "DELETE" });
  return r.body as T;
}
