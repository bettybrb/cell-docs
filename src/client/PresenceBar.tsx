import { useEffect, useState } from "react";
import type { Awareness } from "y-protocols/awareness";
import type { Collaborator, ConnectedDocSession, ConnectionStatus } from "./doc-session";

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connecting: "○ Connecting…",
  connected: "● Connected",
  disconnected: "○ Offline, reconnecting…",
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
  const [people, setPeople] = useState(() => collaborators(session.awareness));

  useEffect(() => {
    const updatePeople = () => setPeople(collaborators(session.awareness));
    const updateStatus = () => {
      setStatus(session.status());
      setUnsaved(session.unsavedChanges());
      setOffline(session.offline());
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

  return (
    <p className="presence" data-testid="presence">
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
