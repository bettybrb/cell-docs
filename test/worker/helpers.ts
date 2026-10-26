import { exports } from "cloudflare:workers";
import { randomSuffix } from "../../src/shared/dummy-data";
import { TEST_USER_HEADER } from "../../src/shared/users";

/** Sends a request through the real Worker entry point (the router), as test user `user` if given. */
export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  user?: string,
): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (user) headers[TEST_USER_HEADER] = user;
  const response = await exports.default.fetch(`https://example.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text(); // empty for 204 No Content
  return { status: response.status, data: (text ? JSON.parse(text) : null) as T };
}

/** Unique id per test so tests never depend on each other's stored state. */
export function uniqueId(prefix: string): string {
  return `${prefix}-${randomSuffix()}`;
}
