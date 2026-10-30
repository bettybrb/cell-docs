import { diffLines } from "diff";
import type { ProposalRequest } from "../shared/api-types";

/**
 * A simulated agent: deterministic text edits standing in for an AI model,
 * so proposals can be stored, reviewed, permission-checked and applied
 * without one. A real model would plug in here and return proposed text the
 * same way.
 */
export function simulateAgent(text: string, request: ProposalRequest): { proposed: string; instruction: string } {
  switch (request.action) {
    case "tidy":
      return { proposed: tidy(text), instruction: "Tidy up spacing and capital letters" };
    case "summary":
      return { proposed: withSummary(text), instruction: "Add a summary at the top" };
    case "ai":
      throw new Error("AI requests are handled by runAi, not the simulated agent.");
    case "replace":
      return {
        proposed: text.split(request.find).join(request.replace),
        instruction: `Replace “${request.find}” with “${request.replace}”`,
      };
  }
}

/** Removes trailing and repeated spaces and space before punctuation, and capitalises sentence starts. */
function tidy(text: string): string {
  return text
    .replace(/[ \t]+$/gm, "")
    .replace(/(\S)[ \t]{2,}/g, "$1 ")
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .replace(/(^|[.!?][ \t]+)([a-z])/gm, (_match, lead: string, letter: string) => lead + letter.toUpperCase());
}

/** Puts a "Summary" section first, made of the first sentence of up to three paragraphs. */
function withSummary(text: string): string {
  if (text.startsWith("## Summary")) return text;
  const sentences = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph && !paragraph.startsWith("#"))
    .map((paragraph) => /^[^.!?\n]*[.!?]?/.exec(paragraph)![0].trim())
    .filter(Boolean)
    .slice(0, 3);
  if (sentences.length === 0) return text;
  return `## Summary\n\n${sentences.map((s) => `- ${s}`).join("\n")}\n\n${text}`;
}

/** One replaced range of the base text (offsets in the base). */
export interface TextChange {
  start: number;
  end: number;
  original: string;
  replacement: string;
}

/**
 * Splits the difference between two texts into separate changes of whole
 * lines. Lines read clearly in a preview, and a change only conflicts with
 * edits made to its own lines.
 */
export function computeChanges(base: string, proposed: string): TextChange[] {
  const changes: TextChange[] = [];
  let index = 0;
  let current: TextChange | null = null;
  for (const part of diffLines(base, proposed)) {
    if (!part.added && !part.removed) {
      if (current) changes.push(current);
      current = null;
      index += part.value.length;
      continue;
    }
    current ??= { start: index, end: index, original: "", replacement: "" };
    if (part.removed) {
      current.original += part.value;
      current.end += part.value.length;
      index += part.value.length;
    } else {
      current.replacement += part.value;
    }
  }
  if (current) changes.push(current);
  return changes;
}
