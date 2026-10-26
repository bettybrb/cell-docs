/**
 * Document permissions, shared by DocCell (which enforces them), the
 * WorkspaceCell (which filters lists and search with a copy) and the client
 * (which adapts the UI; it never decides anything on its own).
 */

/** What a user may do with a document, weakest first. */
export const ROLES = ["none", "read", "comment", "edit"] as const;
export type Role = (typeof ROLES)[number];
/** A user's role on one document; the owner can also manage permissions. */
export type EffectiveRole = Role | "owner";

export interface DocPermissions {
  /** The user who created the document; null for documents older than permissions. */
  owner: string | null;
  /** Role of everyone not listed in `users`. "none" makes the document private. */
  defaultRole: Role;
  /** Roles given to specific users. */
  users: Record<string, Role>;
}

/** Documents created before permissions existed: everyone may edit, nobody owns them. */
export const OPEN_PERMISSIONS: DocPermissions = { owner: null, defaultRole: "edit", users: {} };

const RANK: Record<EffectiveRole, number> = { none: 0, read: 1, comment: 2, edit: 3, owner: 4 };

export function roleOf(user: string, permissions: DocPermissions): EffectiveRole {
  if (permissions.owner === user) return "owner";
  return permissions.users[user] ?? permissions.defaultRole;
}

/** True when `role` allows at least `needed`. */
export function allows(role: EffectiveRole, needed: Exclude<Role, "none">): boolean {
  return RANK[role] >= RANK[needed];
}

/**
 * Who may change permissions: the owner, or, for a document without an owner,
 * anyone who may edit it (who then becomes its owner).
 */
export function canManage(user: string, permissions: DocPermissions): boolean {
  const role = roleOf(user, permissions);
  return role === "owner" || (permissions.owner === null && allows(role, "edit"));
}
