/**
 * Test users. This project has no login: a request names its user (the
 * `x-test-user` header, or `?user=` on the sync WebSocket) and the router
 * trusts it. That is enough to exercise permissions end to end, and it must
 * never be mistaken for authentication.
 */
export const TEST_USERS = ["alice", "bob", "carol"] as const;
export type TestUser = (typeof TEST_USERS)[number];

/** Requests that name no user act as this one, so older clients and tests keep working. */
export const DEFAULT_USER: TestUser = "alice";

/** Header a client uses to name its test user (HTTP requests). */
export const TEST_USER_HEADER = "x-test-user";

export const USER_COLORS: Record<TestUser, string> = {
  alice: "#d1495b",
  bob: "#00798c",
  carol: "#8d5a97",
};

export function isTestUser(value: unknown): value is TestUser {
  return typeof value === "string" && (TEST_USERS as readonly string[]).includes(value);
}
