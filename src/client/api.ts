import type {
  AddCommentRequest,
  ApiError,
  CatalogueEntry,
  CommentList,
  CreateFolderRequest,
  DocCatalogue,
  DocComment,
  Proposal,
  SheetList,
  SheetState,
  ProposalList,
  ProposalRequest,
  ReplyRequest,
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
import type { ChartConfig } from "../shared/sheet";
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

const sheet = (workspaceId: string, sheetId: string) => `${ws(workspaceId)}/sheets/${enc(sheetId)}`;

export const api = {
  listSheets: (workspaceId: string) => call<SheetList>("GET", `${ws(workspaceId)}/sheets`),
  getSheet: (workspaceId: string, sheetId: string) => call<SheetState>("GET", sheet(workspaceId, sheetId)),
  putSheet: (workspaceId: string, sheetId: string, body: { title: string; cells?: Record<string, string> }) =>
    call<SheetState>("PUT", sheet(workspaceId, sheetId), body),
  addChart: (workspaceId: string, sheetId: string, chart: Omit<ChartConfig, "id">) =>
    call<ChartConfig>("POST", `${sheet(workspaceId, sheetId)}/charts`, chart),
  deleteChart: (workspaceId: string, sheetId: string, chartId: string) =>
    call<SheetState>("DELETE", `${sheet(workspaceId, sheetId)}/charts/${chartId}`),
  suggestChart: (workspaceId: string, sheetId: string, instruction: string) =>
    call<Omit<ChartConfig, "id">>("POST", `${sheet(workspaceId, sheetId)}/charts/suggest`, { instruction }),

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

  /** Starts a thread, on the whole document or (with an anchor) on a range of text. */
  addComment: (workspaceId: string, docId: string, comment: AddCommentRequest) =>
    call<DocComment>("POST", `${doc(workspaceId, docId)}/comments`, comment),

  reply: (workspaceId: string, docId: string, threadId: number, reply: ReplyRequest) =>
    call<DocComment>("POST", `${doc(workspaceId, docId)}/comments/${threadId}/replies`, reply),

  resolveThread: (workspaceId: string, docId: string, threadId: number, resolved: boolean) =>
    call<CommentList>("POST", `${doc(workspaceId, docId)}/comments/${threadId}/resolve`, { resolved }),

  listProposals: (workspaceId: string, docId: string) => call<ProposalList>("GET", `${doc(workspaceId, docId)}/proposals`),

  /** Asks the simulated agent for a change; it is stored as a pending proposal. */
  propose: (workspaceId: string, docId: string, request: ProposalRequest) =>
    call<Proposal>("POST", `${doc(workspaceId, docId)}/proposals`, request),

  applyProposal: (workspaceId: string, docId: string, proposalId: number) =>
    call<DocState>("POST", `${doc(workspaceId, docId)}/proposals/${proposalId}/apply`),

  discardProposal: (workspaceId: string, docId: string, proposalId: number) =>
    call<Proposal>("POST", `${doc(workspaceId, docId)}/proposals/${proposalId}/discard`),

  listVersions: (workspaceId: string, docId: string) => call<DocVersionList>("GET", `${doc(workspaceId, docId)}/versions`),

  getVersion: (workspaceId: string, docId: string, versionId: number) =>
    call<DocVersionDetail>("GET", `${doc(workspaceId, docId)}/versions/${versionId}`),

  restoreVersion: (workspaceId: string, docId: string, versionId: number) =>
    call<DocState>("POST", `${doc(workspaceId, docId)}/versions/${versionId}/restore`),
};
