import type { Route, RouteDecision } from "@alfred/agent-harness";
import { isFollowUp } from "./followups";
import { describeLookup, type Lookup } from "./lookups";

/** "lookup" is a Level 2 workflow: answered by code, never by the LLM. */
export type AppRoute = Route | "lookup";

export interface AppRouteInput {
  query: string;
  lookup: Lookup | null;
  rules: RouteDecision;
  /** An earlier assistant turn finished, so references to its answer make sense. */
  inConversation: boolean;
  ignoreFollowUp: boolean;
}

/** Enter starts over unless the text refers back to the conversation ("which of those"). */
export function startsNewSearch(query: string, ignoreFollowUp: boolean): boolean {
  return ignoreFollowUp || !isFollowUp(query);
}

/** Lookups first, because they need no LLM. Then follow-ups (routing rule A). Then the rule router. */
export function decideAppRoute({ query, lookup, rules, inConversation, ignoreFollowUp }: AppRouteInput): { route: AppRoute; reason: string; followUp: boolean } {
  if (lookup) return { route: "lookup", reason: `Lookup: ${describeLookup(lookup)}`, followUp: false };
  if (!ignoreFollowUp && inConversation && rules.route !== "assistant" && isFollowUp(query)) {
    return { route: "assistant", reason: "Follow-up to the conversation", followUp: true };
  }
  return { ...rules, followUp: false };
}
