import { Schema } from "effect";
import type { DocState } from "../shared/api-types";
import { ROLES } from "../shared/permissions";

/**
 * What a WorkspaceCell keeps about each document, copied from the DocCell
 * (which stays the authority). The catalogue uses it to list documents,
 * search them, show the Recycle Bin, and hide what a user may not read.
 *
 * It is sent by the router after every successful document request, and by
 * the DocCell itself shortly after live edits, which do not pass the router.
 */
export const CatalogueCopy = Schema.Struct({
  createdAt: Schema.NonEmptyString,
  updatedAt: Schema.String,
  title: Schema.String,
  body: Schema.String,
  permissions: Schema.Struct({
    owner: Schema.NullOr(Schema.String),
    defaultRole: Schema.Literals(ROLES),
    users: Schema.Record(Schema.String, Schema.Literals(ROLES)),
  }),
  deletedAt: Schema.NullOr(Schema.String),
  deletedBy: Schema.NullOr(Schema.String),
  purgeAt: Schema.NullOr(Schema.String),
});
export type CatalogueCopy = typeof CatalogueCopy.Type;

export function catalogueCopy(doc: DocState): CatalogueCopy {
  return {
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    title: doc.title,
    body: doc.body,
    permissions: doc.permissions,
    deletedAt: doc.deletedAt,
    deletedBy: doc.deletedBy,
    purgeAt: doc.purgeAt,
  };
}
