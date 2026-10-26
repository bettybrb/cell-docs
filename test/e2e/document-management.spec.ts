import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DocState } from "../../src/shared/api-types";
import { dummyDocId, dummyWorkspaceId } from "../../src/shared/dummy-data";
import { request, startDevServer, type DevServer } from "../integration/dev-server";

/**
 * Permissions, the Recycle Bin, folders/tags/search and version history,
 * driven through the page by several test users in separate browsers.
 */

const PORT = 5194;

let stateDir: string;
let server: DevServer;
const contexts: BrowserContext[] = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "cell-docs-lab-docmgmt-"));
  server = await startDevServer({ port: PORT, stateDir });
});

test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
});

test.afterAll(async () => {
  await server?.stop("SIGTERM");
  await rm(stateDir, { recursive: true, force: true });
});

/** Sends an API request as a test user. */
async function as<T>(user: string, method: string, path: string, body?: unknown) {
  const response = await fetch(server.baseUrl + path, {
    method,
    headers: { "x-test-user": user, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, data: (text ? JSON.parse(text) : null) as T };
}

/** A document owned by alice. */
async function aliceDoc(body: string, title = "Plan") {
  const ids = { ws: dummyWorkspaceId(), doc: dummyDocId() };
  const created = await as<DocState>("alice", "PUT", `/api/workspaces/${ids.ws}/docs/${ids.doc}`, { title, body });
  expect(created.status).toBe(201);
  return ids;
}

async function newBrowser(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  return context.newPage();
}

async function openDoc(page: Page, ids: { ws: string; doc: string }, user: string): Promise<void> {
  await page.goto(`${server.baseUrl}/?workspace=${ids.ws}&doc=${ids.doc}&user=${user}`);
  await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
}

const editor = (page: Page) => page.locator(".cm-content");
const docText = (page: Page) =>
  editor(page).evaluate((element) => {
    const copy = element.cloneNode(true) as HTMLElement;
    copy.querySelectorAll(".cm-ySelectionCaret").forEach((caret) => caret.remove());
    return [...copy.querySelectorAll(".cm-line")].map((line) => line.textContent ?? "").join("\n").replace(/⁠/g, "");
  });
const expectText = (page: Page, text: string) => expect.poll(() => docText(page)).toBe(text);

async function typeAtEnd(page: Page, text: string): Promise<void> {
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(text);
}

async function setRole(owner: Page, user: string, label: string): Promise<void> {
  await owner.getByText("Permissions", { exact: true }).click();
  await owner.getByLabel(`Role for ${user}`).selectOption({ label });
  await owner.getByRole("button", { name: "Save permissions" }).click();
  await expect(owner.getByText("Permissions saved.")).toBeVisible();
}

test("taking away edit rights while someone is typing makes their editor read-only at once", async ({ browser }) => {
  const ids = await aliceDoc("Shared draft.");
  const [alice, bob] = [await newBrowser(browser), await newBrowser(browser)];
  await openDoc(alice, ids, "alice");
  await openDoc(bob, ids, "bob");
  await expect(bob.getByTestId("your-role")).toHaveText("Can edit");

  await typeAtEnd(bob, " Bob was here.");
  await expectText(alice, "Shared draft. Bob was here.");

  await setRole(alice, "bob", "Read only");
  await expect(bob.getByTestId("your-role")).toHaveText("Read only");
  await expect(bob.getByTestId("markdown-editor")).toHaveAttribute("data-readonly", "true");
  await typeAtEnd(bob, " Not allowed.");
  expect(await docText(bob)).toBe("Shared draft. Bob was here."); // the editor refused the keys

  // Bob still follows alice's edits live, and the server text is unchanged by bob.
  await typeAtEnd(alice, " Alice continues.");
  await expectText(bob, "Shared draft. Bob was here. Alice continues.");

  // Removing access entirely disconnects bob with an explanation.
  await alice.getByLabel("Default role").selectOption({ label: "No access (private)" });
  await alice.getByLabel("Role for bob").selectOption({ label: "Same as everyone" });
  await alice.getByRole("button", { name: "Save permissions" }).click();
  await expect(bob.getByTestId("connection-closed")).toHaveText("Your access to this document was removed.");
});

test("a private document is hidden from other users and refused if opened directly", async ({ browser }) => {
  const ids = await aliceDoc("Secret.", "Private notes");
  await as("alice", "PUT", `/api/workspaces/${ids.ws}/docs/${ids.doc}/permissions`, { defaultRole: "none", users: {} });

  const bob = await newBrowser(browser);
  await bob.goto(`${server.baseUrl}/?workspace=${ids.ws}&doc=${ids.doc}&user=bob`);
  await expect(bob.getByText("No documents here yet.")).toBeVisible();
  await bob.getByRole("button", { name: "Load doc" }).click();
  await expect(bob.getByTestId("explorer-output")).toContainText('"status": 403');

  const alice = await newBrowser(browser);
  await openDoc(alice, ids, "alice");
  await expect(alice.getByTestId("doc-list")).toContainText("Private notes");
});

test("a commenter can comment but not edit", async ({ browser }) => {
  const ids = await aliceDoc("Please review.");
  await as("alice", "PUT", `/api/workspaces/${ids.ws}/docs/${ids.doc}/permissions`, {
    defaultRole: "edit",
    users: { carol: "comment" },
  });
  const carol = await newBrowser(browser);
  await openDoc(carol, ids, "carol");
  await expect(carol.getByTestId("your-role")).toHaveText("Can comment (read-only text)");
  await expect(carol.getByTestId("markdown-editor")).toHaveAttribute("data-readonly", "true");
  await expect(carol.getByRole("button", { name: "Save doc" })).toBeDisabled();

  await carol.getByText(/^Comments/).click();
  await carol.getByLabel("New comment").fill("Section 2 needs numbers.");
  await carol.getByRole("button", { name: "Add comment" }).click();
  await expect(carol.getByTestId("comment")).toContainText("carol");
  await expect(carol.getByTestId("comment")).toContainText("Section 2 needs numbers.");
});

test("a deleted document goes to the Recycle Bin and comes back with its history", async ({ browser }) => {
  const ids = await aliceDoc("Keep me.", "Important");
  await as("alice", "PUT", `/api/workspaces/${ids.ws}/docs/${ids.doc}`, { body: "Keep me. Version two." });
  const [alice, bob] = [await newBrowser(browser), await newBrowser(browser)];
  await openDoc(alice, ids, "alice");
  await openDoc(bob, ids, "bob");

  await alice.getByRole("button", { name: "Move to Recycle Bin" }).click();
  await expect(bob.getByTestId("connection-closed")).toHaveText("This document was moved to the Recycle Bin.");
  await expect(alice.getByTestId("recycle-bin")).toContainText("Recycle Bin (1)");
  await alice.getByText(/^Recycle Bin/).click();
  const entry = alice.getByTestId("trash-entry");
  await expect(entry).toContainText("Important");
  await expect(entry).toContainText("by alice");
  await expect(entry).toContainText("erased for good on");

  await entry.getByRole("button", { name: "Restore" }).click();
  await expect(alice.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
  await expectText(alice, "Keep me. Version two.");
  await alice.getByText("Versions", { exact: true }).click();
  await expect(alice.getByTestId("version")).toHaveCount(2); // the history came back too
  await expect(alice.getByTestId("doc-list")).toContainText("Important");
});

test("folders, tags and search organise documents without changing their ids", async ({ browser }) => {
  const ids = await aliceDoc("Travel costs went up in March.", "Budget");
  const page = await newBrowser(browser);
  await openDoc(page, ids, "alice");

  await page.getByLabel("New folder name").fill("Finance");
  await page.getByRole("button", { name: "Create folder" }).click();
  await expect(page.getByText("Created folder Finance.")).toBeVisible();

  await page.getByLabel("Move to folder").selectOption({ label: "Finance" });
  await page.getByLabel("Tags", { exact: true }).fill("Budget, 2026");
  await page.getByRole("button", { name: "Save folder and tags" }).click();
  await expect(page.getByTestId("doc-entry")).toContainText("in Finance");
  await expect(page.getByTestId("doc-entry").locator(".tag")).toHaveText(["2026", "budget"]);

  await page.getByLabel("Search").fill("march");
  await expect(page.getByTestId("doc-entry")).toContainText("matched in content");
  await expect(page.getByTestId("doc-entry")).toContainText("Travel costs went up in March.");
  await page.getByLabel("Search").fill("");
  await page.getByLabel("Filter by tag").selectOption("2026");
  await expect(page.getByTestId("doc-entry")).toHaveCount(1);
  await expect(page).toHaveURL(new RegExp(`doc=${ids.doc}`)); // the id did not change
});

test("version history shows who saved and edited, previews old text, and restores without losing history", async ({
  browser,
}) => {
  const ids = await aliceDoc("Version one.");
  await as("bob", "PUT", `/api/workspaces/${ids.ws}/docs/${ids.doc}`, { body: "Version two by bob." });
  const page = await newBrowser(browser);
  await openDoc(page, ids, "alice");
  await page.getByText("Versions", { exact: true }).click();

  const versions = page.getByTestId("version");
  await expect(versions).toHaveCount(2);
  await expect(versions.first()).toContainText("by bob");
  await expect(versions.first().getByTestId("version-editors")).toHaveText("Edited since the previous version by bob");
  await versions.last().getByRole("button", { name: "Preview" }).click();
  await expect(page.getByTestId("version-preview")).toHaveText("Version one.");

  await versions.last().getByRole("button", { name: "Restore" }).click();
  await expectText(page, "Version one.");
  await expect(versions).toHaveCount(3); // the replaced text was kept as a version
  await expect(versions.first()).toContainText("Before a restore");
  const saved = await request<DocState>(server.baseUrl, "GET", `/api/workspaces/${ids.ws}/docs/${ids.doc}`);
  expect(saved.data.body).toBe("Version one.");
});
