import { Data, Effect, Schedule, type Duration } from "effect";

/**
 * Registering a document in its workspace catalogue failed. `retryable` is
 * true when trying again might help (exception, timeout, 5xx) and false when
 * it cannot (a 4xx: the request itself was wrong).
 */
export class RegistrationFailed extends Data.TaggedError("RegistrationFailed")<{
  reason: string;
  retryable: boolean;
}> {}

/** How long one registration attempt may take before it counts as failed. */
export const ATTEMPT_TIMEOUT: Duration.Input = "1 second";

/**
 * Sends the registration call (`send`) to the WorkspaceCell, with a time
 * limit per attempt and up to two retries for failures that might be
 * temporary. Registration is idempotent, so repeating it is harmless.
 */
export function registerInCatalogue(
  send: () => Promise<Response>,
  { attemptTimeout = ATTEMPT_TIMEOUT }: { attemptTimeout?: Duration.Input } = {},
): Effect.Effect<void, RegistrationFailed> {
  const attempt = Effect.tryPromise({
    try: send,
    catch: (error) =>
      new RegistrationFailed({ reason: error instanceof Error ? error.message : String(error), retryable: true }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: attemptTimeout,
      orElse: () => Effect.fail(new RegistrationFailed({ reason: "timed out", retryable: true })),
    }),
    Effect.flatMap((response) =>
      response.ok
        ? Effect.void
        : Effect.fail(
            new RegistrationFailed({
              reason: `workspace cell answered ${response.status}`,
              retryable: response.status >= 500,
            }),
          ),
    ),
  );

  return attempt.pipe(
    Effect.retry({
      schedule: Schedule.exponential("50 millis"),
      times: 2,
      while: (error) => error.retryable,
    }),
  );
}
