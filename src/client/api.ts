import type {
  ApiError,
  DocState,
  HealthResponse,
  UpdateDocRequest,
  UpdateWorkspaceRequest,
  WorkspaceState,
} from "../shared/api-types";

/** Result of an API call: either data or the server's structured error. */
export type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; error: ApiError["error"] };

async function call<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  return response.ok
    ? { ok: true, status: response.status, data: payload as T }
    : { ok: false, status: response.status, error: (payload as ApiError).error };
}

const enc = encodeURIComponent;

export const api = {
  health: () => call<HealthResponse>("GET", "/api/health"),

  getWorkspace: (workspaceId: string) =>
    call<WorkspaceState>("GET", `/api/workspaces/${enc(workspaceId)}`),

  putWorkspace: (workspaceId: string, update: UpdateWorkspaceRequest) =>
    call<WorkspaceState>("PUT", `/api/workspaces/${enc(workspaceId)}`, update),

  getDoc: (workspaceId: string, docId: string) =>
    call<DocState>("GET", `/api/workspaces/${enc(workspaceId)}/docs/${enc(docId)}`),

  putDoc: (workspaceId: string, docId: string, update: UpdateDocRequest) =>
    call<DocState>("PUT", `/api/workspaces/${enc(workspaceId)}/docs/${enc(docId)}`, update),
};
