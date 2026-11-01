import { normalize } from "@alfred/agent-harness";

/**
 * Words that refer back to earlier assistant answers (routing rule A). Only used while a conversation
 * is active: then "which of those is shortest" or "something lighter instead" go to the assistant.
 */
const FOLLOW_UP = /\b(those|them|these|that one|this one|the (first|second|third|last|other)( one)?|which of|which one|shorter|longer|older|newer|lighter|darker|funnier|instead|another|other ones?|any others?|more like (that|this|it)|it|they)\b/;

/** Words that refer to something else, not a movie title, in a lookup or after "like". */
export const PRONOUNS: ReadonlySet<string> = new Set(["it", "this", "that", "these", "those", "them", "they", "he", "she", "him", "her", "this one", "that one", "this movie", "that movie"]);

export function isFollowUp(text: string): boolean {
  return FOLLOW_UP.test(normalize(text));
}
