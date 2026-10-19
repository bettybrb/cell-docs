import { Schema } from "effect";
import * as Result from "effect/Result";
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
 * Parses a JSON request body and checks it against `schema`. Returns the
 * decoded value (unknown extra fields dropped), or a 400 error Response that
 * callers can `return` directly.
 */
export async function readBody<T>(request: Request, schema: Schema.Decoder<T>): Promise<T | Response> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON.");
  }
  const result = Schema.decodeUnknownResult(schema)(parsed);
  if (Result.isFailure(result)) {
    // Effect's messages span lines ("Expected string\n  at [\"title\"]"); keep one line.
    return errorResponse(400, "invalid_body", result.failure.message.replace(/\n\s*/g, " "));
  }
  return result.success;
}
