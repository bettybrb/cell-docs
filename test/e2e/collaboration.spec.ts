import { expect, test, type Browser, type BrowserContext, type Page, type WebSocketRoute } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DocState } from "../../src/shared/api-types";
import { dummyDocId, dummyWorkspaceId } from "../../src/shared/dummy-data";
import { request, startDevServer, type DevServer } from "../integration/dev-server";

/**
 * Two independent browser contexts (separate "browsers": no shared storage
 * or connections) editing the same document through the real dev server.
 */

const PORT = 5193;

let stateDir: string;
let server: DevServer;
const contexts: BrowserContext[] = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "cell-docs-lab-e2e-"));
  server = await startDevServer({ port: PORT, stateDir });
});

test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
});

test.afterAll(async () => {
  await server?.stop("SIGTERM");
  await rm(stateDir, { recursive: true, force: true });
});

/** Creates a document through the REST API and returns its ids. */
async function createDoc(body: string) {
  const ws = dummyWorkspaceId();
  const doc = dummyDocId();
  const created = await request(server.baseUrl, "PUT", `/api/workspaces/${ws}/docs/${doc}`, { title: "Shared", body });
  expect(created.status).toBe(201);
  return { ws, doc };
}

/** Opens a new, independent browser context. */
async function newBrowser(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  return context.newPage();
}

/** Opens the document by its URL; resolves once it is live-synced. */
async function openDoc(page: Page, ids: { ws: string; doc: string }): Promise<void> {
  await page.goto(`${server.baseUrl}/?workspace=${ids.ws}&doc=${ids.doc}`);
  await expect(status(page)).toHaveAttribute("data-status", "connected");
  await expect(editor(page)).toBeVisible();
}

const editor = (page: Page) => page.locator(".cm-content");

/** The document text in the editor, without other people's cursor labels. */
const docText = (page: Page) =>
  editor(page).evaluate((element) => {
    const copy = element.cloneNode(true) as HTMLElement;
    copy.querySelectorAll(".cm-ySelectionCaret").forEach((caret) => caret.remove());
    return [...copy.querySelectorAll(".cm-line")]
      .map((line) => line.textContent ?? "")
      .join("\n")
      .replace(/\u2060/g, ""); // word joiners CodeMirror puts around widgets
  });

/** Waits until the editor shows exactly `text`. */
const expectText = (page: Page, text: string) => expect.poll(() => docText(page)).toBe(text);

/** Waits until the editor's text contains `text`. */
const expectContains = (page: Page, text: string) => expect.poll(() => docText(page)).toContain(text);
const status = (page: Page) => page.getByTestId("connection-status");
const collaboratorCount = (page: Page) => page.getByTestId("collaborator-count");
const saveStatus = (page: Page) => page.getByTestId("save-status");

/** Types at the end of the document, like a user would. */
async function typeAtEnd(page: Page, text: string): Promise<void> {
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(text);
}

test("edits in one browser appear in the other without saving", async ({ browser }) => {
  const ids = await createDoc("Shared start.");
  const [a, b] = [await newBrowser(browser), await newBrowser(browser)];
  await openDoc(a, ids);
  await openDoc(b, ids);
  await expectText(b, "Shared start.");

  await typeAtEnd(a, " Typed in A.");
  await expectText(b, "Shared start. Typed in A.");

  await typeAtEnd(b, " Typed in B.");
  await expectText(a, "Shared start. Typed in A. Typed in B.");
});

test("presence shows collaborators joining and leaving", async ({ browser }) => {
  const ids = await createDoc("Presence.");
  const a = await newBrowser(browser);
  await openDoc(a, ids);
  await expect(collaboratorCount(a)).toHaveText("1");

  const b = await newBrowser(browser);
  await openDoc(b, ids);
  await expect(collaboratorCount(a)).toHaveText("2");
  await expect(collaboratorCount(b)).toHaveText("2");
  await expect(a.getByTestId("collaborator").filter({ hasText: /^(, )?Guest-\d+$/ })).toHaveCount(1);

  // B closes its browser: A sees it leave.
  await b.context().close();
  await expect(collaboratorCount(a)).toHaveText("1");

  // Someone else joins: A sees them.
  const c = await newBrowser(browser);
  await openDoc(c, ids);
  await expect(collaboratorCount(a)).toHaveText("2");
});

test("a browser that loses its connection reconnects and keeps every edit", async ({ browser }) => {
  const ids = await createDoc("Start.");
  const a = await newBrowser(browser);

  // Route A's sync socket through Playwright so the test can cut it.
  let blocked = false;
  const routes: WebSocketRoute[] = [];
  await a.routeWebSocket(/\/sync$/, (ws) => {
    if (blocked) {
      ws.close({ code: 1006, reason: "test: offline" });
      return;
    }
    routes.push(ws, ws.connectToServer());
  });

  const goOffline = async () => {
    blocked = true;
    await Promise.all(routes.splice(0).map((route) => route.close({ code: 1006, reason: "test: offline" })));
    await expect(status(a)).toHaveAttribute("data-status", "disconnected");
  };

  const b = await newBrowser(browser);
  await openDoc(a, ids);
  await openDoc(b, ids);
  await expect(collaboratorCount(b)).toHaveText("2");

  // A drops and comes back without touching anything: B sees it leave and return.
  await goOffline();
  await expect(collaboratorCount(b)).toHaveText("1");
  blocked = false;
  await expect(status(a)).toHaveAttribute("data-status", "connected");
  await expect(collaboratorCount(b)).toHaveText("2", { timeout: 5_000 });

  // Cut A off again and keep it off.
  await goOffline();
  await expect(collaboratorCount(b)).toHaveText("1");

  // Both keep editing while A is offline.
  await typeAtEnd(a, " A offline.");
  await typeAtEnd(b, " B meanwhile.");
  expect(await docText(b)).not.toContain("A offline.");

  // A comes back: both edits are in both browsers, and A is present again.
  blocked = false;
  await expect(status(a)).toHaveAttribute("data-status", "connected");
  await expectContains(b, "A offline.");
  await expectContains(a, "B meanwhile.");
  await expectText(a, await docText(b));
  await expect(collaboratorCount(b)).toHaveText("2");
});

test("shows whether edits are saved and warns before closing with unsaved edits", async ({ browser }) => {
  const ids = await createDoc("Start.");
  const page = await newBrowser(browser);
  let blocked = false;
  const routes: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/sync$/, (ws) => {
    if (blocked) {
      ws.close({ code: 1006, reason: "test: offline" });
      return;
    }
    routes.push(ws, ws.connectToServer());
  });
  await openDoc(page, ids);
  await expect(saveStatus(page)).toHaveAttribute("data-state", "saved");

  // Online: "All changes saved" means the server really has the edit.
  await typeAtEnd(page, " One.");
  await expect(saveStatus(page)).toHaveAttribute("data-state", "saving"); // not a leftover "saved"
  await expect(saveStatus(page)).toHaveAttribute("data-state", "saved");
  const body = async () =>
    (await request<DocState>(server.baseUrl, "GET", `/api/workspaces/${ids.ws}/docs/${ids.doc}`)).data.body;
  expect(await body()).toBe("Start. One.");

  // Offline: edits are reported as not saved, and closing the tab asks first.
  blocked = true;
  await Promise.all(routes.splice(0).map((route) => route.close({ code: 1006, reason: "test: offline" })));
  await expect(status(page)).toHaveAttribute("data-status", "disconnected");
  await typeAtEnd(page, " Two.");
  await expect(saveStatus(page)).toHaveAttribute("data-state", "unsaved");
  await expect(saveStatus(page)).toHaveText("Not saved yet, will sync when back online");

  const dialog = page.waitForEvent("dialog");
  await page.close({ runBeforeUnload: true });
  const warning = await dialog;
  expect(warning.type()).toBe("beforeunload");
  await warning.dismiss(); // stay on the page

  // Back online: saved again, and the server has the offline edit.
  blocked = false;
  await expect(saveStatus(page)).toHaveAttribute("data-state", "saved");
  expect(await body()).toBe("Start. One. Two.");
});

test("the Go offline toggle simulates a lost connection for demos", async ({ browser }) => {
  const ids = await createDoc("Demo.");
  const [a, b] = [await newBrowser(browser), await newBrowser(browser)];
  await openDoc(a, ids);
  await openDoc(b, ids);
  await expect(collaboratorCount(b)).toHaveText("2");

  await a.getByTestId("offline-toggle").click();
  await expect(status(a)).toHaveText("○ Offline (simulated)");
  await expect(collaboratorCount(b)).toHaveText("1");
  await typeAtEnd(a, " Written offline.");
  await expect(saveStatus(a)).toHaveAttribute("data-state", "unsaved");
  expect(await docText(b)).toBe("Demo.");

  // Closing the tab now asks first; stay on the page.
  const dialog = a.waitForEvent("dialog");
  await a.close({ runBeforeUnload: true });
  const warning = await dialog;
  expect(warning.type()).toBe("beforeunload");
  await warning.dismiss();

  await a.getByTestId("offline-toggle").click(); // "Go back online"
  await expect(status(a)).toHaveAttribute("data-status", "connected");
  await expect(saveStatus(a)).toHaveAttribute("data-state", "saved");
  await expectText(b, "Demo. Written offline.");
  await expect(collaboratorCount(b)).toHaveText("2");
});

test("refreshing the page reopens the same document with its latest content", async ({ browser }) => {
  const ids = await createDoc("Saved.");
  const page = await newBrowser(browser);
  // Open it the way a user does: type the ids and click "Load doc".
  await page.goto(server.baseUrl);
  await page.getByLabel("Workspace id").fill(ids.ws);
  await page.getByLabel("Doc id").fill(ids.doc);
  await page.getByRole("button", { name: "Load doc" }).click();
  await expect(status(page)).toHaveAttribute("data-status", "connected");
  await typeAtEnd(page, " Edited live.");
  await expect(page).toHaveURL(new RegExp(`workspace=${ids.ws}&doc=${ids.doc}`));

  // Wait until the server has the edit, then reload: no clicking needed.
  await expect
    .poll(async () => (await request<DocState>(server.baseUrl, "GET", `/api/workspaces/${ids.ws}/docs/${ids.doc}`)).data.body)
    .toBe("Saved. Edited live.");
  await page.reload();
  await expect(status(page)).toHaveAttribute("data-status", "connected");
  await expectText(page, "Saved. Edited live.");
  await expect(page.getByLabel("Doc id")).toHaveValue(ids.doc);
  await expect(page.getByLabel("Title")).toHaveValue("Shared");
});

test("the start page opens the saved sample document, not a stale draft", async ({ browser }) => {
  const path = "/api/workspaces/sample-workspace/docs/welcome";
  await request(server.baseUrl, "PUT", path, { title: "Welcome (edited)", body: "Newest welcome text." });
  const page = await newBrowser(browser);
  await page.goto(server.baseUrl);
  await expect(status(page)).toHaveAttribute("data-status", "connected");
  await expectText(page, "Newest welcome text.");
  await expect(page.getByLabel("Title")).toHaveValue("Welcome (edited)");
});

test("content survives a backend restart, including edits made during the outage", async ({ browser }) => {
  const ids = await createDoc("Before restart.");
  const [a, b] = [await newBrowser(browser), await newBrowser(browser)];
  await openDoc(a, ids);
  await openDoc(b, ids);
  await typeAtEnd(a, " Live edit.");
  await expectText(b, "Before restart. Live edit.");

  await server.stop("SIGTERM");
  await expect(status(a)).toHaveAttribute("data-status", "disconnected");
  await typeAtEnd(a, " During outage.");

  server = await startDevServer({ port: PORT, stateDir });
  await expect(status(a)).toHaveAttribute("data-status", "connected");
  await expect(status(b)).toHaveAttribute("data-status", "connected");
  const expected = "Before restart. Live edit. During outage.";
  await expectText(b, expected);

  // A brand-new browser loads the same content from the restarted backend.
  const c = await newBrowser(browser);
  await openDoc(c, ids);
  await expectText(c, expected);
  const saved = await request<DocState>(server.baseUrl, "GET", `/api/workspaces/${ids.ws}/docs/${ids.doc}`);
  expect(saved.data.body).toBe(expected);
});
