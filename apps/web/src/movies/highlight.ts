import { normalize, type ParseResult } from "@alfred/agent-harness";

export interface Segment {
  text: string;
  /** The chip these words produced; absent for other text. */
  sig?: string;
}

/** Splits the typed text at the words that produced a chip, so the input can underline them. */
export function wordSegments(text: string, parsed: Pick<ParseResult, "tokens" | "marks">): Segment[] {
  const normalized = normalize(text);
  // Tokens come from the normalized text. Offsets only map back when normalizing kept the length.
  if (normalized.length !== text.length) return [{ text }];
  const starts: number[] = [];
  const ends: number[] = [];
  let cursor = 0;
  for (const token of parsed.tokens) {
    const at = normalized.indexOf(token, cursor);
    if (at < 0) return [{ text }];
    starts.push(at);
    ends.push(at + token.length);
    cursor = at + token.length;
  }
  const segments: Segment[] = [];
  let done = 0;
  for (const mark of parsed.marks) {
    const from = starts[mark.from]!;
    const to = ends[mark.to - 1]!;
    if (from > done) segments.push({ text: text.slice(done, from) });
    segments.push({ text: text.slice(from, to), sig: mark.sig });
    done = to;
  }
  if (done < text.length) segments.push({ text: text.slice(done) });
  return segments;
}
