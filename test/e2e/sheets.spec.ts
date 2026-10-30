import { expect, test, type BrowserContext } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDevServer, type DevServer } from "../integration/dev-server";

const PORT = 5194;
let stateDir: string;
let server: DevServer;
const contexts: BrowserContext[] = [];

test.beforeAll(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "cell-docs-lab-e2e-sheets-"));
  server = await startDevServer({ port: PORT, stateDir });
});
test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((c) => c.close()));
});
test.afterAll(async () => {
  await server?.stop("SIGTERM");
  await rm(stateDir, { recursive: true, force: true });
});

test("two users edit one sheet live; formulas and charts follow the data; AI suggests a chart", async ({ browser }) => {
  const sheet = `s${Date.now()}`;
  const open = async (user: string) => {
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
    await page.goto(`${server.baseUrl}/?user=${user}&workspace=ws-sheet-e2e&sheet=${sheet}`);
    return page;
  };
  const { request } = await import("../integration/dev-server");
  await request(server.baseUrl, "PUT", `/api/workspaces/ws-sheet-e2e/sheets/${sheet}`, {
    title: "Sales",
    cells: { A1: "Month", B1: "Revenue", A2: "Jan", B2: "10", A3: "Feb", B3: "20" },
  });
  const alice = await open("alice");
  const bob = await open("bob");
  const cell = (page: typeof alice, ref: string) => page.locator(`[data-ref="${ref}"]`);
  const setCell = async (page: typeof alice, ref: string, raw: string) => {
    await cell(page, ref).getByRole("gridcell").click();
    await page.getByLabel(`Cell ${ref}`).fill(raw);
    await page.keyboard.press("Enter");
  };

  await expect(cell(bob, "B3")).toHaveText("20");
  await setCell(alice, "B4", "=SUM(B2:B3)");
  await expect(cell(alice, "B4")).toHaveText("30");
  await expect(cell(bob, "B4")).toHaveText("30"); // live, no reload

  // AI suggests a chart; reviewed and added by a person.
  await alice.getByLabel("AI chart request").fill("bar chart of revenue");
  await alice.getByRole("button", { name: "Ask AI: suggest chart" }).click();
  await expect(alice.getByTestId("chart-suggestion")).toBeVisible();
  await alice.getByRole("button", { name: "Add this chart" }).click();
  await expect(bob.getByTestId("chart-svg").first()).toBeVisible();

  // The chart follows the data on both screens.
  await setCell(bob, "B2", "100");
  await expect(alice.getByTestId("chart-svg").first()).toHaveAttribute("data-values", /100/);
  await expect(bob.getByTestId("chart-svg").first()).toHaveAttribute("data-values", /100/);
});
