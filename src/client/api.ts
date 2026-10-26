import type {
  AddCommentRequest,
  ApiError,
  CatalogueEntry,
  CommentList,
  CreateFolderRequest,
  DocCatalogue,
  DocComment,
  DocState,
  DocVersionDetail,
  DocVersionList,
  Folder,
  HealthResponse,
  SearchResults,
  TrashList,
  UpdateDocMetaRequest,
  UpdateDocRequest,
  UpdatePermissionsRequest,
  UpdateWorkspaceRequest,
  WorkspaceState,
} from "../shared/api-types";
import { TEST_USER_HEADER } from "../shared/users";
import { currentUser } from "./current-user";

/** Result of an API call: either data or the server's structured error. */
export type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; error: ApiError["error"] };

async function call<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { [TEST_USER_HEADER]: currentUser() };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text(); // empty for 204 No Content
  const payload: unknown = text ? JSON.parse(text) : null;
  return response.ok
    ? { ok: true, status: response.status, data: payload as T }
    : { ok: false, status: response.status, error: (payload as ApiError).error };
}

const enc = encodeURIComponent;
const ws = (workspaceId: string) => `/api/workspaces/${enc(workspaceId)}`;
const doc = (workspaceId: string, docId: string) => `${ws(workspaceId)}/docs/${enc(docId)}`;

export const api = {
  health: () => call<HealthResponse>("GET", "/api/health"),

  getWorkspace: (workspaceId: string) => call<WorkspaceState>("GET", ws(workspaceId)),

  putWorkspace: (workspaceId: string, update: UpdateWorkspaceRequest) =>
    call<WorkspaceState>("PUT", ws(workspaceId), update),

  // Catalogue: documents, folders, tags, search, Recycle Bin
  listDocs: (workspaceId: string) => call<DocCatalogue>("GET", `${ws(workspaceId)}/docs`),

  search: (workspaceId: string, query: { q?: string; tag?: string; folder?: string }) => {
    const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value) as [string, string][]);
    return call<SearchResults>("GET", `${ws(workspaceId)}/search?${params}`);
  },

  createFolder: (workspaceId: string, folder: CreateFolderRequest) =>
    call<Folder>("POST", `${ws(workspaceId)}/folders`, folder),

  deleteFolder: (workspaceId: string, folderId: string) =>
    call<null>("DELETE", `${ws(workspaceId)}/folders/${enc(folderId)}`),

  setDocMeta: (workspaceId: string, docId: string, meta: UpdateDocMetaRequest) =>
    call<CatalogueEntry>("PUT", `${doc(workspaceId, docId)}/meta`, meta),

  listTrash: (workspaceId: string) => call<TrashList>("GET", `${ws(workspaceId)}/trash`),

  // One document
  getDoc: (workspaceId: string, docId: string) => call<DocState>("GET", doc(workspaceId, docId)),

  putDoc: (workspaceId: string, docId: string, update: UpdateDocRequest) =>
    call<DocState>("PUT", doc(workspaceId, docId), update),

  /** Moves the document to the Recycle Bin. */
  deleteDoc: (workspaceId: string, docId: string) => call<DocState>("DELETE", doc(workspaceId, docId)),

  /** Takes the document out of the Recycle Bin. */
  restoreDoc: (workspaceId: string, docId: string) => call<DocState>("POST", `${doc(workspaceId, docId)}/restore`),

  /** Deletes a document in the Recycle Bin for good. */
  purgeDoc: (workspaceId: string, docId: string) => call<{ purged: true }>("POST", `${doc(workspaceId, docId)}/purge`),

  setPermissions: (workspaceId: string, docId: string, permissions: UpdatePermissionsRequest) =>
    call<DocState>("PUT", `${doc(workspaceId, docId)}/permissions`, permissions),

  listComments: (workspaceId: string, docId: string) => call<CommentList>("GET", `${doc(workspaceId, docId)}/comments`),

  addComment: (workspaceId: string, docId: string, comment: AddCommentRequest) =>
    call<DocComment>("POST", `${doc(workspaceId, docId)}/comments`, comment),

  listVersions: (workspaceId: string, docId: string) => call<DocVersionList>("GET", `${doc(workspaceId, docId)}/versions`),

  getVersion: (workspaceId: string, docId: string, versionId: number) =>
    call<DocVersionDetail>("GET", `${doc(workspaceId, docId)}/versions/${versionId}`),

  restoreVersion: (workspaceId: string, docId: string, versionId: number) =>
    call<DocState>("POST", `${doc(workspaceId, docId)}/versions/${versionId}/restore`),
};
