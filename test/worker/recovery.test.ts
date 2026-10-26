import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type * as Y from "yjs";
import type { DocState } from "../../src/shared/api-types";
import { docCellName } from "../../src/worker/addressing";
import { COMPACT_AFTER_UPDATES, type DocCell } from "../../src/worker/cells/doc-cell";
import { api, uniqueId } from "./helpers";

const docPath = (ws: string, doc: string) => `/api/workspaces/${ws}/docs/${doc}`;

async function newDoc(body: string) {
  const [ws, doc] = [uniqueId("ws"), uniqueId("doc")];
  expect((await api("PUT", docPath(ws, doc), { body })).status).toBe(201);
  const stub = env.DOC_CELL.get(env.DOC_CELL.idFromName(docCellName(ws, doc)));
  return { ws, doc, stub };
}

/** Runs `fn` inside the cell with its live Yjs text (loading it like a connection would). */
const inCell = <T>(stub: DurableObjectStub<DocCell>, fn: (text: Y.Text, sql: SqlStorage) => T) =>
  runInDurableObject(stub, (instance, state) => {
    const ydoc = (instance as unknown as { loadYDoc(): Y.Doc }).loadYDoc();
    return fn(ydoc.getText("body"), state.storage.sql);
  });

const count = (sql: SqlStorage, table: string) =>
  sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;

describe("update log merging while running", () => {
  it(`keeps the log below ${COMPACT_AFTER_UPDATES + 1} rows during long editing, without changing the text`, async () => {
    const { ws, doc, stub } = await newDoc("");
    const rows = await inCell(stub, (text, sql) => {
      for (let i = 0; i < 1_200; i++) text.insert(text.length, String(i % 10));
      return count(sql, "yjs_updates");
    });
    expect(rows).toBeLessThanOrEqual(COMPACT_AFTER_UPDATES);

    const expected = Array.from({ length: 1_200 }, (_, i) => i % 10).join("");
    expect((await api<DocState>("GET", docPath(ws, doc))).data.body).toBe(expected);
    await evictDurableObject(stub);
    expect(await inCell(stub, (text) => text.toString())).toBe(expected);
  });

  it("can merge in the middle of a manual save", async () => {
    const { ws, doc, stub } = await newDoc("a");
    // Fill the log up to the limit; the save's update then triggers merging.
    await inCell(stub, (text, sql) => {
      while (count(sql, "yjs_updates") < COMPACT_AFTER_UPDATES) text.insert(text.length, "a");
    });
    const saved = await api<DocState>("PUT", docPath(ws, doc), { body: "replaced by a save" });
    expect(saved.status).toBe(200);
    expect(saved.data.body).toBe("replaced by a save");
    expect(await inCell(stub, (_text, sql) => count(sql, "yjs_updates"))).toBe(1);
  });
});

describe("recovery from damaged storage", () => {
  it("quarantines an unreadable update and keeps the document loadable", async () => {
    const { ws, doc, stub } = await newDoc("Hello");
    await inCell(stub, (text, sql) => {
      text.insert(5, " world");
      sql.exec("INSERT INTO yjs_updates (data) VALUES (?)", new Uint8Array([1, 2, 3, 250, 99]));
    });
    await evictDurableObject(stub);

    const result = await inCell(stub, (text, sql) => ({
      text: text.toString(),
      updates: count(sql, "yjs_updates"),
      quarantined: count(sql, "yjs_quarantine"),
    }));
    expect(result).toEqual({ text: "Hello world", updates: 2, quarantined: 1 });
    expect((await api<DocState>("GET", docPath(ws, doc))).data.body).toBe("Hello world");
  });

  it("repairs the text from the saved copy when an update is missing", async () => {
    const { stub } = await newDoc("Hello");
    await inCell(stub, (text, sql) => {
      text.insert(5, " world");
      text.insert(11, "!");
      text.delete(0, 1);
      // Lose a middle update: later ones depend on it, and Yjs gives no error.
      const { seq } = sql.exec<{ seq: number }>("SELECT seq FROM yjs_updates ORDER BY seq LIMIT 1 OFFSET 1").one();
      sql.exec("DELETE FROM yjs_updates WHERE seq = ?", seq);
    });
    await evictDurableObject(stub);
    expect(await inCell(stub, (text) => text.toString())).toBe("ello world!");
  });

  it("rebuilds the document from the saved copy when no update is readable", async () => {
    const { stub } = await newDoc("Everything was here.");
    await inCell(stub, (text, sql) => {
      text.insert(text.length, " And more.");
      sql.exec("UPDATE yjs_updates SET data = ?", new Uint8Array([9, 9, 9]));
    });
    await evictDurableObject(stub);

    const result = await inCell(stub, (text, sql) => ({
      text: text.toString(),
      quarantined: count(sql, "yjs_quarantine"),
    }));
    expect(result.text).toBe("Everything was here. And more.");
    expect(result.quarantined).toBe(2);
    // The repair is stored like any edit, so the next load needs no repair.
    await evictDurableObject(stub);
    expect(await inCell(stub, (text, sql) => [text.toString(), count(sql, "yjs_quarantine")])).toEqual([
      "Everything was here. And more.",
      2,
    ]);
  });
});
