import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { latestOnly } from "./doc-session";

/** Wait this long after the last keystroke before saving the title. */
const SAVE_DELAY_MS = 1_000;
/** Wait this long before trying again after a network error or 5xx. */
const RETRY_DELAY_MS = 3_000;

export type TitleSaveState =
  | { kind: "saved" }
  | { kind: "saving" }
  | { kind: "retrying" }
  | { kind: "rejected"; message: string };

interface DocRef {
  workspaceId: string;
  docId: string;
}

/**
 * Saves the title of the open document shortly after the user stops typing,
 * through the normal PUT (title only, so the live-synced body is untouched).
 *
 * Only `changed()` triggers a save, so loading a document does not save its
 * title back. Switching documents saves a pending title right away.
 */
export function useTitleAutosave(open: DocRef | null, onSaved: () => void) {
  const [state, setState] = useState<TitleSaveState>({ kind: "saved" });
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const pending = useRef<{ doc: DocRef; title: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const requests = useRef(latestOnly());

  const flush = async () => {
    const job = pending.current;
    if (!job) return;
    const isLatest = requests.current.start();
    let retry = false;
    try {
      const r = await api.putDoc(job.doc.workspaceId, job.doc.docId, { title: job.title });
      if (!isLatest()) return; // a newer save or a document switch took over
      if (r.ok) {
        if (pending.current === job) pending.current = null;
        if (!pending.current) setState({ kind: "saved" });
        onSavedRef.current();
        return;
      }
      if (r.status >= 500) retry = true;
      else {
        if (pending.current === job) pending.current = null;
        setState({ kind: "rejected", message: r.error.message });
      }
    } catch {
      if (!isLatest()) return;
      retry = true; // network error
    }
    if (retry && pending.current === job) {
      setState({ kind: "retrying" });
      timer.current = setTimeout(flush, RETRY_DELAY_MS);
    }
  };

  // On switching documents: save the previous one's pending title now.
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      void flush();
      setState({ kind: "saved" });
    },
    [open?.workspaceId, open?.docId],
  );

  return {
    state,
    /** Call when the user edits the title. */
    changed(title: string) {
      if (!open) return; // an unsaved draft: the Save button creates it
      pending.current = { doc: open, title };
      setState({ kind: "saving" });
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, SAVE_DELAY_MS);
    },
    /** True while a title edit has not been saved. */
    unsaved: () => pending.current !== null,
  };
}
