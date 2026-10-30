import { useEffect, useState, useSyncExternalStore } from "react";
import type { ProvidersResponse } from "../shared/api-types";
import { api, type AiChoice } from "./api";

// One choice for the whole page, kept across reloads; the document and chart AI controls share it.
const KEY = "ai-choice";
const listeners = new Set<() => void>();
let snapshot: string = (() => {
  try {
    return localStorage.getItem(KEY) ?? "{}";
  } catch {
    return "{}";
  }
})();

function setChoice(choice: AiChoice) {
  snapshot = JSON.stringify(choice);
  try {
    localStorage.setItem(KEY, snapshot);
  } catch {
    /* private mode: the choice lasts until reload */
  }
  listeners.forEach((l) => l());
}

export function useAiChoice(): AiChoice {
  const raw = useSyncExternalStore((l) => (listeners.add(l), () => void listeners.delete(l)), () => snapshot);
  return JSON.parse(raw) as AiChoice;
}

/** Provider and model selector; shows what the next AI request will use. */
export function AiModelPicker() {
  const choice = useAiChoice();
  const [info, setInfo] = useState<ProvidersResponse | null>(null);
  useEffect(() => void api.aiProviders().then((r) => r.ok && setInfo(r.data)), []);
  if (!info) return null;

  const provider = info.providers.find((p) => p.id === (choice.provider ?? info.current.provider)) ?? info.providers[0]!;
  const model = choice.model && provider.models.includes(choice.model) ? choice.model : choice.provider ? (provider.models[0] ?? "") : (info.current.model ?? provider.models[0] ?? "");
  return (
    <div className="inline" data-testid="ai-model-picker">
      <select aria-label="AI provider" value={provider.id} onChange={(e) => setChoice({ provider: e.target.value as AiChoice["provider"] })}>
        {info.providers.map((p) => (
          <option key={p.id} value={p.id}>{p.label}{p.configured ? "" : " (no key)"}</option>
        ))}
      </select>
      <select aria-label="AI model" value={model} onChange={(e) => setChoice({ provider: provider.id, model: e.target.value })}>
        {provider.models.length === 0 && <option value="">no models available</option>}
        {!provider.models.includes(model) && model && <option value={model}>{model}</option>}
        {provider.models.map((m) => (
          <option key={m} value={m}>{m}</option>
        ))}
      </select>
      <span className="muted" data-testid="ai-selected">Using {provider.label} · {model || "no model"}</span>
      {provider.note && <span className="muted">{provider.note}</span>}
    </div>
  );
}
