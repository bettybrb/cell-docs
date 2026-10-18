/**
 * End-to-end demo against a running dev server (`npm run dev` first).
 *
 *   npm run demo                 # uses http://localhost:5180
 *   BASE_URL=http://... npm run demo
 *
 * Writes generated dummy data to one workspace cell and two doc cells, reads it
 * back, and shows which cell answered each request. Run it twice, or restart
 * the server in between with the same ids (DEMO_WS / DEMO_DOC), to see
 * persistence.
 */
import type { DocState, WorkspaceState } from "../src/shared/api-types.ts";
import { dummyBody, dummyDocId, dummyTitle, dummyWorkspaceId } from "../src/shared/dummy-data.ts";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:5180";

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const response = await fetch(BASE_URL + path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}

function check(label: string, ok: boolean): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) process.exitCode = 1;
}

const ws = process.env.DEMO_WS ?? dummyWorkspaceId();
const docA = process.env.DEMO_DOC ?? dummyDocId();
const docB = dummyDocId();

try {
  await call("GET", "/api/health");
} catch {
  console.error(`Cannot reach ${BASE_URL}. Start the app with \`npm run dev\` first.`);
  process.exit(1);
}

console.log(`Server: ${BASE_URL}\nWorkspace: ${ws}\nDocs: ${docA}, ${docB}\n`);

const existing = await call<DocState>("GET", `/api/workspaces/${ws}/docs/${docA}`);
if (existing.status === 200) {
  console.log(`Doc ${docA} already exists at revision ${existing.data.revision} (persisted from an earlier run).\n`);
}

const wsWrite = await call<WorkspaceState>("PUT", `/api/workspaces/${ws}`, { displayName: `Demo ${ws}` });
const contentA = { title: dummyTitle(), body: dummyBody() };
const contentB = { title: dummyTitle(), body: dummyBody() };
const writeA = await call<DocState>("PUT", `/api/workspaces/${ws}/docs/${docA}`, contentA);
const writeB = await call<DocState>("PUT", `/api/workspaces/${ws}/docs/${docB}`, contentB);

const readWs = await call<WorkspaceState>("GET", `/api/workspaces/${ws}`);
const readA = await call<DocState>("GET", `/api/workspaces/${ws}/docs/${docA}`);
const readB = await call<DocState>("GET", `/api/workspaces/${ws}/docs/${docB}`);
const elsewhere = await call("GET", `/api/workspaces/${dummyWorkspaceId()}/docs/${docA}`);

console.table(
  [readWs, readA, readB].map(({ data }) => ({
    cell: data.cell.name,
    id: data.cell.id.slice(0, 16) + "…",
    sqliteBytes: data.cell.sqliteBytes,
    revision: "revision" in data ? data.revision : "-",
  })),
);

check("workspace reads back its display name", readWs.data.displayName === wsWrite.data.displayName);
check("doc A reads back its own body", readA.data.body === contentA.body);
check("doc B reads back its own body", readB.data.body === contentB.body);
check("doc A and doc B are different cells", readA.data.cell.id !== readB.data.cell.id);
check("write and read reached the same cell", writeA.data.cell.id === readA.data.cell.id && writeB.data.cell.id === readB.data.cell.id);
check("same doc id in another workspace is a different, empty cell (404)", elsewhere.status === 404);

console.log(`\nTo see persistence: restart the server, then run\n  DEMO_WS=${ws} DEMO_DOC=${docA} npm run demo`);
