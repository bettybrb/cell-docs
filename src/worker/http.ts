import type { ApiError } from "../shared/api-types";

/** Header the router uses to tell a cell which name it was addressed by. */
export const CELL_NAME_HEADER = "x-cell-name";

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function errorResponse(status: number, code: string, message: string): Response {
  const body: ApiError = { error: { code, message } };
  return json(body, status);
}

/**
 * Parses a JSON object request body. Returns an error Response instead of
 * throwing so callers can `return` it directly.
 */
export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown> | Response> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return errorResponse(400, "invalid_body", "Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}
