import { Effect } from "effect";
import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";
import { registerInCatalogue } from "../../src/worker/register-doc";

/** A fake WorkspaceCell call that plays back one outcome per attempt. */
function fakeCell(outcomes: Array<number | "throw" | "hang">) {
  let calls = 0;
  const send = () => {
    const outcome = outcomes[Math.min(calls++, outcomes.length - 1)];
    if (outcome === "throw") return Promise.reject(new Error("connection reset"));
    if (outcome === "hang") return new Promise<Response>(() => {});
    return Promise.resolve(new Response(null, { status: outcome }));
  };
  return { send, calls: () => calls };
}

const run = (send: () => Promise<Response>) =>
  Effect.runPromise(Effect.result(registerInCatalogue(send, { attemptTimeout: "50 millis" })));

describe("registerInCatalogue", () => {
  it("succeeds on the first attempt without retrying", async () => {
    const cell = fakeCell([201]);
    expect(Result.isSuccess(await run(cell.send))).toBe(true);
    expect(cell.calls()).toBe(1);
  });

  it("retries a temporary failure and then succeeds", async () => {
    const cell = fakeCell(["throw", 503, 204]);
    expect(Result.isSuccess(await run(cell.send))).toBe(true);
    expect(cell.calls()).toBe(3);
  });

  it("gives up after three attempts and says why", async () => {
    const cell = fakeCell([500]);
    const result = await run(cell.send);
    expect(cell.calls()).toBe(3);
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      _tag: "RegistrationFailed",
      reason: "workspace cell answered 500",
      retryable: true,
    });
  });

  it("does not retry a 4xx, which another attempt cannot fix", async () => {
    const cell = fakeCell([400, 201]);
    const result = await run(cell.send);
    expect(cell.calls()).toBe(1);
    expect(Result.isFailure(result) && result.failure).toMatchObject({ retryable: false });
  });

  it("times out a stuck call instead of waiting forever", async () => {
    const cell = fakeCell(["hang"]);
    const result = await run(cell.send);
    expect(cell.calls()).toBe(3);
    expect(Result.isFailure(result) && result.failure).toMatchObject({ reason: "timed out" });
  });
});
