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
  await alice.getByRole("button", { name: "Add comment" }).click();
  await alice.getByLabel("New comment").fill("Which shade?");
  await alice.getByRole("button", { name: "Submit" }).click();
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

/** Selects `length` characters starting at `from` on line `line` (0-based), with the keyboard. */
async function selectOnLine(page: Page, line: number, from: number, length: number): Promise<void> {
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+Home");
  for (let i = 0; i < line; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Home");
  for (let i = 0; i < from; i++) await page.keyboard.press("ArrowRight");
  for (let i = 0; i < length; i++) await page.keyboard.press("Shift+ArrowRight");
}

async function commentOnSelection(page: Page, body: string): Promise<void> {
  await page.getByRole("button", { name: "Add comment" }).click();
  await page.getByLabel("New comment").fill(body);
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByTestId("draft")).toHaveCount(0);
}

const top = async (locator: ReturnType<Page["locator"]>) => (await locator.boundingBox())!.y;

test("cards sit beside their text without overlapping, and a highlight and its card pick each other", async ({ browser }) => {
  const lines = Array.from({ length: 14 }, (_, i) => `Line ${i} words here.`);
  const ids = await aliceDoc(lines.join("\n"));
  const alice = await newBrowser(browser);
  await openDoc(alice, ids, "alice");

  await selectOnLine(alice, 0, 0, 4);
  await commentOnSelection(alice, "First");
  await selectOnLine(alice, 1, 0, 4);
  await commentOnSelection(alice, "Second, on the very next line");
  await selectOnLine(alice, 12, 8, 5);
  await commentOnSelection(alice, "Far below");

  const cards = alice.getByTestId("thread");
  await expect(cards).toHaveCount(3);
  // In text order, none overlapping.
  await expect(cards.nth(0)).toContainText("First");
  await expect(cards.nth(2)).toContainText("Far below");
  await expect
    .poll(async () => {
      const boxes = await Promise.all([0, 1, 2].map(async (i) => (await cards.nth(i).boundingBox())!));
      return boxes.every((box, i) => i === 0 || boxes[i - 1]!.y + boxes[i - 1]!.height <= box.y);
    })
    .toBe(true);
  // A card with room is level with its text.
  const far = alice.locator(".cm-comment", { hasText: "words" });
  await expect.poll(async () => Math.abs((await top(cards.nth(2))) - (await top(far)))).toBeLessThan(6);

  // Clicking a highlight picks its card.
  await alice.locator(".cm-comment").first().click();
  await expect(cards.nth(0)).toHaveClass(/active-thread/);
  // Clicking a card picks it and selects its text.
  await cards.nth(2).getByText("Far below").click();
  await expect(cards.nth(2)).toHaveClass(/active-thread/);
  await expect(alice.locator(".cm-comment-active")).toHaveText("words");
  expect(await alice.evaluate(() => getSelection()?.toString())).toBe("words");

  // The margin can be hidden; the highlights stay.
  await alice.getByRole("button", { name: "Hide comments" }).click();
  await expect(alice.getByTestId("comment-margin")).toHaveCount(0);
  await expect(alice.locator(".cm-comment")).toHaveCount(3);
  await alice.getByRole("button", { name: "Show comments" }).click();
  await expect(cards).toHaveCount(3);
});

test("a draft comment can be cancelled", async ({ browser }) => {
  const ids = await aliceDoc("Draft me.");
  const alice = await newBrowser(browser);
  await openDoc(alice, ids, "alice");
  await select(alice, 0, 5);
  await alice.getByRole("button", { name: "Add comment" }).click();
  await expect(alice.getByTestId("draft")).toContainText("On “Draft”");
  await expect(alice.locator(".cm-comment")).toHaveText("Draft"); // the draft's text is highlighted
  await alice.getByLabel("New comment").fill("Never mind");
  await alice.getByRole("button", { name: "Cancel" }).click();
  await expect(alice.getByTestId("draft")).toHaveCount(0);
  await expect(alice.locator(".cm-comment")).toHaveCount(0);
  await expect(alice.getByTestId("thread")).toHaveCount(0);
});

test("a resolved thread can be reopened from history with its messages, live for others", async ({ browser }) => {
  const ids = await aliceDoc("Ship it on Friday.");
  const [alice, bob] = [await newBrowser(browser), await newBrowser(browser)];
  await openDoc(alice, ids, "alice");
  await openDoc(bob, ids, "bob");
  await select(alice, 11, 6); // "Friday"
  await commentOnSelection(alice, "Too soon?");
  await bob.getByLabel("Reply to alice").fill("It is fine.");
  await bob.getByRole("button", { name: "Reply" }).click();
  await expect(alice.getByTestId("reply")).toContainText("bob");

  await alice.getByRole("button", { name: "Resolve" }).click();
  for (const page of [alice, bob]) {
    await expect(page.getByTestId("thread")).toHaveCount(0);
    await expect(page.locator(".cm-comment")).toHaveCount(0);
  }

  await bob.getByLabel("Show resolved").check();
  await bob.getByRole("button", { name: "Reopen" }).click();
  for (const page of [alice, bob]) {
    await expect(page.locator(".cm-comment")).toHaveText("Friday");
    await expect(page.getByTestId("comment")).toContainText("Too soon?");
    await expect(page.getByTestId("reply")).toContainText("It is fine.");
  }
});

test("a thread whose text was deleted stays, marked as missing its text", async ({ browser }) => {
  const ids = await aliceDoc("Keep this. Remove that.");
  const [alice, bob] = [await newBrowser(browser), await newBrowser(browser)];
  await openDoc(alice, ids, "alice");
  await openDoc(bob, ids, "bob");
  await select(alice, 11, 6); // "Remove"
  await commentOnSelection(alice, "Why remove?");
  await expect(bob.locator(".cm-comment")).toHaveText("Remove");

  await select(bob, 11, 7);
  await bob.keyboard.press("Backspace");
  await expectText(alice, "Keep this. that.");
  for (const page of [alice, bob]) {
    await expect(page.locator(".cm-comment")).toHaveCount(0);
    await expect(page.getByTestId("anchor-deleted")).toBeVisible();
    await expect(page.getByTestId("thread-quote")).toContainText("“Remove”");
    await expect(page.getByTestId("comment")).toContainText("Why remove?");
  }
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
