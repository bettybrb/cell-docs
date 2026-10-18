import { useEffect, useState } from "react";
import type { Awareness } from "y-protocols/awareness";
import type { Collaborator, ConnectedDocSession, ConnectionStatus } from "./doc-session";

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connecting: "○ Connecting…",
  connected: "● Connected",
  disconnected: "○ Offline, reconnecting… (edits are kept)",
};

/** Connection status plus the people connected to the open document. */
export function PresenceBar({ session }: { session: ConnectedDocSession }) {
  const [status, setStatus] = useState(session.status());
  const [people, setPeople] = useState(() => collaborators(session.awareness));

  useEffect(() => {
    const update = () => setPeople(collaborators(session.awareness));
    session.awareness.on("change", update);
    const stop = session.onStatus(setStatus);
    update();
    setStatus(session.status());
    return () => {
      session.awareness.off("change", update);
      stop();
    };
  }, [session]);

  return (
    <p className="presence" data-testid="presence">
      <span data-testid="connection-status" data-status={status}>
        {STATUS_TEXT[status]}
      </span>
      {" · "}
      <span data-testid="collaborator-count">{people.length}</span> here:{" "}
      {people.map((person, i) => (
        <span key={person.id} className="collaborator" data-testid="collaborator">
          {i > 0 && ", "}
          <span className="dot" style={{ background: person.color }} />
          {person.self ? `You (${person.name})` : person.name}
        </span>
      ))}
    </p>
  );
}

function collaborators(awareness: Awareness) {
  return [...awareness.getStates()]
    .filter(([, state]) => state.user)
    .map(([id, state]) => ({ id, ...(state.user as Collaborator), self: id === awareness.clientID }))
    .sort((a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name));
}
