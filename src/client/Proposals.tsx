import { useEffect, useState } from "react";
import type { DocState, Proposal, ProposalRequest } from "../shared/api-types";
import { allows, type EffectiveRole } from "../shared/permissions";
import { api } from "./api";
import { AiModelPicker, useAiChoice } from "./AiModelPicker";
import { currentUser } from "./current-user";
import type { ConnectedDocSession } from "./doc-session";

const STATUS_TEXT: Record<Proposal["status"], string> = {
  pending: "Waiting for review",
  applied: "Applied",
  discarded: "Discarded",
};

/**
 * Proposals from the simulated agent. Anyone who may comment can ask for
 * one; the change is stored for review, not made. Reviewers preview each
 * changed part (removed and added text, with context) and Apply or Discard.
 * Applying needs edit rights and changes only the proposed parts of the
 * current text, keeping everyone's other edits; if a part's text was edited
 * meanwhile, nothing is applied.
 */
export function Proposals({
  doc,
  session,
  role,
  onApplied,
}: {
  doc: DocState;
  session: ConnectedDocSession | null;
  role: EffectiveRole | null;
  onApplied: (doc: DocState) => void;
}) {
  const [proposals, setProposals] = useState<Proposal[] | "error">([]);
  const [open, setOpen] = useState<number | null>(null);
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const aiChoice = useAiChoice();
  const canAsk = role !== null && allows(role, "comment");
  const canApply = role !== null && allows(role, "edit");

  const load = async () => {
    const r = await api.listProposals(doc.workspaceId, doc.docId);
    setProposals(r.ok ? r.data.proposals : "error");
  };

  // Reload when anyone changes proposals, and when the text changes (a
  // pending proposal may stop fitting once someone edits its lines).
  useEffect(() => {
    void load();
    if (!session) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onText = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 500);
    };
    session.text.observe(onText);
    const stop = session.onChanged((topic) => {
      if (topic === "proposals") void load();
    });
    return () => {
      clearTimeout(timer);
      session.text.unobserve(onText);
      stop();
    };
  }, [doc.workspaceId, doc.docId, session]);

  const ask = async (request: ProposalRequest) => {
    setBusy(true);
    const r = await api.propose(doc.workspaceId, doc.docId, request);
    setMessage(r.ok ? `The agent proposed ${r.data.summary}.` : r.error.message);
    if (r.ok) setOpen(r.data.id);
    setBusy(false);
    await load();
  };

  const apply = async (proposal: Proposal) => {
    const r = await api.applyProposal(doc.workspaceId, doc.docId, proposal.id);
    setMessage(r.ok ? "Applied." : r.error.message);
    if (r.ok) onApplied(r.data);
    await load();
  };

  const discard = async (proposal: Proposal) => {
    const r = await api.discardProposal(doc.workspaceId, doc.docId, proposal.id);
    setMessage(r.ok ? "Discarded." : r.error.message);
    await load();
  };

  const pending = proposals === "error" ? 0 : proposals.filter((p) => p.status === "pending").length;

  return (
    <details className="wide panel" data-testid="proposals" open>
      <summary>Agent proposals ({pending} waiting)</summary>
      <p className="muted">A simulated agent (no AI model): it proposes a change, and nothing changes until someone applies it.</p>
      <AiModelPicker />
      <div className="inline" data-testid="ai-agent">
        <input
          aria-label="AI instruction"
          placeholder="Tell the AI what to change…"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          disabled={!canAsk || busy}
          size={36}
        />
        <button
          onClick={() => ask({ action: "ai", mode: "edit", instruction, ...aiChoice })}
          disabled={!canAsk || busy || instruction.trim() === ""}
        >
          Ask AI: edit
        </button>
        <button onClick={() => ask({ action: "ai", mode: "summarise", instruction: "", ...aiChoice })} disabled={!canAsk || busy}>
          Ask AI: summarise
        </button>
        {busy && <span className="muted">AI is working…</span>}
      </div>
      <div className="inline">
        <button onClick={() => ask({ action: "tidy" })} disabled={!canAsk}>
          Ask agent: tidy up
        </button>
        <button onClick={() => ask({ action: "summary" })} disabled={!canAsk}>
          Ask agent: add a summary
        </button>
        <input aria-label="Find" placeholder="find" value={find} onChange={(e) => setFind(e.target.value)} disabled={!canAsk} />
        <input
          aria-label="Replace with"
          placeholder="replace with"
          value={replace}
          onChange={(e) => setReplace(e.target.value)}
          disabled={!canAsk}
        />
        <button onClick={() => ask({ action: "replace", find, replace })} disabled={!canAsk || find === ""}>
          Ask agent: replace
        </button>
        {message && (
          <span className="muted" data-testid="proposal-message">
            {message}
          </span>
        )}
      </div>
      {proposals === "error" ? (
        <p>Could not load proposals.</p>
      ) : (
        <ul>
          {proposals.map((proposal) => {
            const stale = proposal.changes.filter((c) => !c.applicable).length;
            const mayDiscard = canApply || proposal.requestedBy === currentUser();
            return (
              <li key={proposal.id} data-testid="proposal" data-status={proposal.status}>
                <strong>{proposal.instruction}</strong>{proposal.agent === "ai" && <span className="muted"> [AI]</span>}{" "}
                <span className="muted">
                  asked by {proposal.requestedBy}, {new Date(proposal.createdAt).toLocaleString()} · {proposal.summary} ·{" "}
                  {STATUS_TEXT[proposal.status]}
                  {proposal.decidedBy && ` by ${proposal.decidedBy}`}
                </span>{" "}
                <button onClick={() => setOpen(open === proposal.id ? null : proposal.id)}>
                  {open === proposal.id ? "Hide changes" : "Preview changes"}
                </button>
                {proposal.status === "pending" && (
                  <>
                    {" "}
                    <button onClick={() => apply(proposal)} disabled={!canApply || stale > 0}>
                      Apply
                    </button>{" "}
                    <button onClick={() => discard(proposal)} disabled={!mayDiscard}>
                      Discard
                    </button>
                    {stale > 0 && (
                      <div className="notice" data-testid="proposal-stale">
                        {stale} of {proposal.changes.length} change(s) no longer fit: that text was edited after the proposal. Discard
                        it and ask again.
                      </div>
                    )}
                  </>
                )}
                {open === proposal.id && (
                  <div className="diff" data-testid="proposal-diff">
                    {proposal.changes.map((change, i) => (
                      <pre key={i} data-applicable={change.applicable}>
                        <span className="muted">{change.before}</span>
                        {change.original && <del>{change.original}</del>}
                        {change.replacement && <ins>{change.replacement}</ins>}
                        <span className="muted">{change.after}</span>
                      </pre>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </details>
  );
}
