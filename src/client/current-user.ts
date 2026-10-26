import { DEFAULT_USER, isTestUser, USER_COLORS, type TestUser } from "../shared/users";
import type { Collaborator } from "./doc-session";

/**
 * The test user this tab acts as: `?user=` in the page URL, else the default.
 * Each tab can be a different user (open a second tab with `?user=bob`).
 * This is a test setup, not a login: the server simply trusts it.
 */
export function currentUser(): TestUser {
  const user = new URLSearchParams(location.search).get("user");
  return isTestUser(user) ? user : DEFAULT_USER;
}

/** How the current user appears to collaborators (presence and cursor colour). */
export function currentCollaborator(): Collaborator {
  const name = currentUser();
  return { name, color: USER_COLORS[name], colorLight: `${USER_COLORS[name]}33` };
}
