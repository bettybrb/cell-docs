import { useEffect, useState } from "react";
import type { Awareness } from "y-protocols/awareness";
import type { EffectiveRole } from "../shared/permissions";
import type { ClosedReason, Collaborator, ConnectedDocSession, ConnectionStatus } from "./doc-session";

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connecting: "○ Connecting…",
  connected: "● Connected",
  disconnected: "○ Offline, reconnecting…",
};

export const ROLE_TEXT: Record<EffectiveRole, string> = {
  owner: "Owner",
  edit: "Can edit",
  comment: "Can comment (read-only text)",
  read: "Read only",
  none: "No access",
};

const CLOSED_TEXT: Record<ClosedReason, string> = {
  access_revoked: "Your access to this document was removed.",
  edit_rejected:
    "Your last change was refused: you may no longer edit this document. It was not saved. Reload the document to keep reading.",
  document_deleted: "This document was moved to the Recycle Bin.",
};

type SaveState = "saved" | "saving" | "unsaved";

const SAVE_TEXT: Record<SaveState, string> = {
  saved: "All changes saved",
  saving: "Saving…",
  unsaved: "Not on the server yet, kept on this device until back online",
};

/** Connection and save status plus the people connected to the open document. */
export function PresenceBar({ session }: { session: ConnectedDocSession }) {
  const [status, setStatus] = useState(session.status());
  const [unsaved, setUnsaved] = useState(session.unsavedChanges());
  const [offline, setOffline] = useState(session.offline());
  const [role, setRole] = useState(session.role());
  const [closed, setClosed] = useState(session.closedReason());
  const [people, setPeople] = useState(() => collaborators(session.awareness));

  useEffect(() => {
    const updatePeople = () => setPeople(collaborators(session.awareness));
    const updateStatus = () => {
      setStatus(session.status());
      setUnsaved(session.unsavedChanges());
      setOffline(session.offline());
      setRole(session.role());
      setClosed(session.closedReason());
    };
    session.awareness.on("change", updatePeople);
    const stop = session.subscribe(updateStatus);
    updatePeople();
    updateStatus();
    return () => {
      session.awareness.off("change", updatePeople);
      stop();
    };
  }, [session]);

  const saveState: SaveState = unsaved === 0 ? "saved" : status === "connected" ? "saving" : "unsaved";

  if (closed) {
    return (
      <p className="presence notice" data-testid="connection-closed" data-reason={closed}>
        {CLOSED_TEXT[closed]}
      </p>
    );
  }

  return (
    <p className="presence" data-testid="presence">
      {role && (
        <>
          <span className="role" data-testid="your-role" data-role={role}>
            {ROLE_TEXT[role]}
          </span>
          {" · "}
        </>
      )}
      <span data-testid="connection-status" data-status={status}>
        {offline ? "○ Offline (simulated)" : STATUS_TEXT[status]}
      </span>
      {" · "}
      <span data-testid="save-status" data-state={saveState}>
        {SAVE_TEXT[saveState]}
      </span>
      {" · "}
      <span data-testid="collaborator-count">{people.length}</span> here:{" "}
      {people.map((person, i) => (
        <span key={person.id} className="collaborator" data-testid="collaborator">
          {i > 0 && ", "}
          <span className="dot" style={{ background: person.color }} />
          {person.self ? `You (${person.name})` : person.name}
        </span>
      ))}{" "}
      {/* For demos: drop the connection without stopping the server. */}
      <button data-testid="offline-toggle" onClick={() => session.setOffline(!offline)}>
        {offline ? "Go back online" : "Go offline"}
      </button>
    </p>
  );
}

function collaborators(awareness: Awareness) {
  return [...awareness.getStates()]
    .filter(([, state]) => state.user)
    .map(([id, state]) => ({ id, ...(state.user as Collaborator), self: id === awareness.clientID }))
    .sort((a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name));
}
