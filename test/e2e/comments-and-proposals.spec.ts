import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DocState } from "../../src/shared/api-types";
import { dummyDocId, dummyWorkspaceId } from "../../src/shared/dummy-data";
import { startDevServer, type DevServer } from "../integration/dev-server";

/** Comment threads anchored to text, and agent proposals, with two users in separate browsers. */

const PORT = 5197;

let stateDir: string;
let server: DevServer;
const contexts: BrowserContext[] = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "cell-docs-lab-threads-"));
  server = await startDevServer({ port: PORT, stateDir });
});

test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
});

test.afterAll(async () => {
  await server?.stop("SIGTERM");
  await rm(stateDir, { recursive: true, force: true });
});

async function as<T>(user: string, method: string, path: string, body?: unknown) {
  const response = await fetch(server.baseUrl + path, {
    method,
    headers: { "x-test-user": user, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, data: (text ? JSON.parse(text) : null) as T };
}

async function aliceDoc(body: string) {
  const ids = { ws: dummyWorkspaceId(), doc: dummyDocId() };
  expect((await as("alice", "PUT", `/api/workspaces/${ids.ws}/docs/${ids.doc}`, { title: "Notes", body })).status).toBe(201);
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

/** Selects `length` characters starting at `from` in the first line, with the keyboard. */
async function select(page: Page, from: number, length: number): Promise<void> {
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+Home");
  for (let i = 0; i < from; i++) await page.keyboard.press("ArrowRight");
  for (let i = 0; i < length; i++) await page.keyboard.press("Shift+ArrowRight");
}

test("a comment on selected text stays on that text while someone else edits around it", async ({ browser }) => {
  const ids = await aliceDoc("The quick brown fox jumps.");
  const [alice, bob] = [await newBrowser(browser), await newBrowser(browser)];
  await openDoc(alice, ids, "alice");
  await openDoc(bob, ids, "bob");

  await select(alice, 10, 5); // "brown"
  await alice.getByLabel("New comment").fill("Which shade?");
  await alice.getByRole("button", { name: "Comment on selection" }).click();
  await expect(alice.getByTestId("thread-quote")).toContainText("On “brown”");
  await expect(alice.locator(".cm-comment")).toHaveText("brown");
  await expect(bob.locator(".cm-comment")).toHaveText("brown"); // shown live to bob too

  // Bob types before and after the highlighted word.
  await editor(bob).click();
  await bob.keyboard.press("ControlOrMeta+Home");
  await bob.keyboard.type("Look: ");
  await bob.keyboard.press("ControlOrMeta+End");
  await bob.keyboard.type(" Again.");
  await expectText(alice, "Look: The quick brown fox jumps. Again.");
  await expect(alice.locator(".cm-comment")).toHaveText("brown");
  await expect(bob.locator(".cm-comment")).toHaveText("brown");
});

test("replies and resolving reach the other browser without reloading", async ({ browser }) => {
  const ids = await aliceDoc("Release on Monday.");
  await as("alice", "POST", `/api/workspaces/${ids.ws}/docs/${ids.doc}/comments`, { body: "Is Monday confirmed?" });
  const [alice, bob] = [await newBrowser(browser), await newBrowser(browser)];
  await openDoc(alice, ids, "alice");
  await openDoc(bob, ids, "bob");

  await bob.getByLabel("Reply to alice").fill("Yes, confirmed.");
  await bob.getByRole("button", { name: "Reply" }).click();
  await expect(alice.getByTestId("reply")).toContainText("Yes, confirmed.");

  await bob.getByRole("button", { name: "Resolve" }).click();
  await expect(alice.getByTestId("thread")).toHaveCount(0); // resolved threads are hidden by default
  await alice.getByLabel("Show resolved").check();
  await expect(alice.getByTestId("thread")).toContainText("Resolved by bob");
});

test("an agent proposal is previewed, then applied without overwriting another user's edit", async ({ browser }) => {
  const ids = await aliceDoc("Line one.\nLine two has a typo: teh.\nLine three.");
  const [alice, bob] = [await newBrowser(browser), await newBrowser(browser)];
  await openDoc(alice, ids, "alice");
  await openDoc(bob, ids, "bob");

  await alice.getByLabel("Find").fill("teh");
  await alice.getByLabel("Replace with").fill("the");
  await alice.getByRole("button", { name: "Ask agent: replace" }).click();
  await expect(alice.getByTestId("proposal-message")).toHaveText("The agent proposed 1 change.");
  const diff = alice.getByTestId("proposal-diff");
  await expect(diff.locator("del")).toHaveText("Line two has a typo: teh.\n");
  await expect(diff.locator("ins")).toHaveText("Line two has a typo: the.\n");
  await expectText(alice, "Line one.\nLine two has a typo: teh.\nLine three."); // not applied yet

  // Meanwhile bob edits another line.
  await editor(bob).click();
  await bob.keyboard.press("ControlOrMeta+End");
  await bob.keyboard.type(" Bob's addition.");
  await expectText(alice, "Line one.\nLine two has a typo: teh.\nLine three. Bob's addition.");

  await alice.getByRole("button", { name: "Apply" }).click();
  const expected = "Line one.\nLine two has a typo: the.\nLine three. Bob's addition.";
  await expectText(alice, expected);
  await expectText(bob, expected); // bob's edit kept, and he sees the fix live
  await expect(bob.getByTestId("proposal")).toHaveAttribute("data-status", "applied");
  await alice.getByText("Versions", { exact: true }).click();
  await expect(alice.getByTestId("version").first()).toContainText("Before an agent proposal");
});

test("a proposal whose lines were edited meanwhile cannot be applied, only discarded", async ({ browser }) => {
  const ids = await aliceDoc("Line one.\nLine two has a typo: teh.\nLine three.");
  await as("alice", "POST", `/api/workspaces/${ids.ws}/docs/${ids.doc}/proposals`, { action: "replace", find: "teh", replace: "the" });
  const [alice, bob] = [await newBrowser(browser), await newBrowser(browser)];
  await openDoc(alice, ids, "alice");
  await openDoc(bob, ids, "bob");
  await expect(alice.getByRole("button", { name: "Apply" })).toBeEnabled();

  // Bob edits the very line the proposal would replace.
  await select(bob, 0, 0);
  await bob.keyboard.press("ArrowDown");
  await bob.keyboard.press("End");
  await bob.keyboard.type(" (bob)");
  await expect(alice.getByTestId("proposal-stale")).toContainText("1 of 1 change(s) no longer fit");
  await expect(alice.getByRole("button", { name: "Apply" })).toBeDisabled();

  await alice.getByRole("button", { name: "Discard" }).click();
  await expect(alice.getByTestId("proposal")).toHaveAttribute("data-status", "discarded");
  const saved = await as<DocState>("alice", "GET", `/api/workspaces/${ids.ws}/docs/${ids.doc}`);
  expect(saved.data.body).toBe("Line one.\nLine two has a typo: teh. (bob)\nLine three.");
});

test("a commenter may ask the agent but not apply its proposal", async ({ browser }) => {
  const ids = await aliceDoc("hello  world .");
  await as("alice", "PUT", `/api/workspaces/${ids.ws}/docs/${ids.doc}/permissions`, {
    defaultRole: "edit",
    users: { carol: "comment" },
  });
  const carol = await newBrowser(browser);
  await openDoc(carol, ids, "carol");
  await carol.getByRole("button", { name: "Ask agent: tidy up" }).click();
  await expect(carol.getByTestId("proposal")).toHaveAttribute("data-status", "pending");
  await expect(carol.getByRole("button", { name: "Apply" })).toBeDisabled();
  await expect(carol.getByRole("button", { name: "Discard" })).toBeEnabled(); // she asked for it
});
