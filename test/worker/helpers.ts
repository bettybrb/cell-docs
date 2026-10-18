import { exports } from "cloudflare:workers";
import { randomSuffix } from "../../src/shared/dummy-data";

/** Sends a request through the real Worker entry point (the router). */
export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const response = await exports.default.fetch(`https://example.test${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}

/** Unique id per test so tests never depend on each other's stored state. */
export function uniqueId(prefix: string): string {
  return `${prefix}-${randomSuffix()}`;
}
