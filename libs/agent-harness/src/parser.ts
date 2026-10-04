import type { Dictionary, DictEntry } from "./dictionary";
import { levenshtein, toKey, tokenize } from "./text";

export interface Chip {
  kind: string;
  id: string;
  label: string;
  negate: boolean;
  fuzzy: boolean;
  ambiguous: boolean;
  alts: string[];
  /** Rule-specific values, for example { max: 120 } for a runtime chip. */
  data?: Record<string, number | string | null>;
  /** Stable identity: kind, id and negation. */
  sig: string;
}

export type ChipInput = Pick<Chip, "kind" | "id" | "label"> & Partial<Omit<Chip, "kind" | "id" | "label" | "sig">>;

export interface ParseResult {
  chips: Chip[];
  /** Words that no rule or dictionary matched. They become free text for semantic search. */
  leftover: string[];
  /** One line per parser decision, for display in the UI. */
  trace: string[];
  /** Autocomplete for a partial name at the end of the query. */
  suggestion: { from: string; to: string } | null;
}

export interface RuleContext {
  tokens: string[];
  keyAt(i: number): string;
  /** True when the tokens from position i equal the phrase keys. */
  matches(i: number, phrase: string[]): boolean;
}

export interface RuleMatch {
  /** Number of tokens used. Must be at least 1. */
  consumed: number;
  chips?: ChipInput[];
  trace: string;
}

/** A domain rule, for example runtime or rating. Rules run before the dictionary lookup. */
export interface Rule {
  name: string;
  match(ctx: RuleContext, i: number): RuleMatch | null;
}

/** A fixed phrase that produces a chip, for example "plan" (task) or "haven't seen" (user data). */
export interface PhraseChip {
  phrase: string[];
  chip: ChipInput;
}

export interface ParserConfig {
  dictionary: Dictionary;
  rules?: Rule[];
  phrases?: PhraseChip[];
  stopWords?: Iterable<string>;
  negationWords?: Iterable<string>;
  negationPhrases?: string[][];
}

export const DEFAULT_STOP_WORDS = (
  "a an the and i me want to for of in that which who whos is are what whats " +
  "show find give get see some something any one ones kind type please good great " +
  "with has have having including includes include contains containing featuring starring by " +
  "from like similar as but about can you there on it its also looking need maybe really very just this these those"
).split(" ");

export const DEFAULT_NEGATION_WORDS = [
  "not", "no", "without", "except", "excluding", "exclude", "nothing", "minus", "avoid", "skip",
  "hate", "hates", "dislike", "dislikes", "dont", "doesnt", "isnt", "arent",
];

export const DEFAULT_NEGATION_PHRASES = [
  ["does", "not"], ["do", "not"], ["is", "not"], ["are", "not"], ["other", "than"], ["anything", "but"],
];

/** Generic task words. A "task" chip routes the request to the assistant. */
export const DEFAULT_TASK_PHRASES: PhraseChip[] = [
  ...(["plan", "schedule"] as const).map((w) => ({ phrase: [w], chip: { kind: "task", id: "plan", label: "plan" } })),
  ...(["compare", "versus", "vs"] as const).map((w) => ({ phrase: [w], chip: { kind: "task", id: "compare", label: "compare" } })),
  ...(["explain", "why"] as const).map((w) => ({ phrase: [w], chip: { kind: "task", id: "explain", label: "explain" } })),
  ...(["summarize", "summarise"] as const).map((w) => ({ phrase: [w], chip: { kind: "task", id: "summarize", label: "summarize" } })),
  { phrase: ["decide"], chip: { kind: "task", id: "decide", label: "decide" } },
  { phrase: ["should", "i"], chip: { kind: "task", id: "decide", label: "decide" } },
];

const CONNECTORS = new Set(["or", "nor"]);

function toChip(c: ChipInput): Chip {
  const negate = c.negate ?? false;
  return {
    negate,
    fuzzy: false,
    ambiguous: false,
    alts: [],
    ...c,
    sig: `${c.kind}:${c.id}:${negate}`,
  };
}

/** Find a dictionary entry with typo tolerance: edit distance 2 for two-word names, 1 for single words. */
function fuzzyLookup(dict: Dictionary, single: string, pair: string | null): { entry: DictEntry; used: number } | null {
  if (pair && pair.length >= 9) {
    for (const [k, e] of dict.entries) {
      if (e.via === "name" && k.length >= 9 && levenshtein(pair, k) <= 2) return { entry: e, used: 2 };
    }
  }
  if (single.length >= 5) {
    for (const [k, e] of dict.entries) {
      if (e.via !== "surname" && k.length >= 5 && levenshtein(single, k) === 1) return { entry: e, used: 1 };
    }
  }
  return null;
}

/**
 * Parse a query with rules and dictionaries only. No network, no model.
 *
 * Order at each token: phrase chips, negation, domain rules, dictionary (longest match first),
 * typo-tolerant dictionary, connectors, stop words, first-name suggestion, leftover.
 *
 * Negation scope: a negation word applies to the next dictionary entity. It continues through
 * "or", "nor" and commas ("not sci-fi or horror"). Any other word ends it.
 */
export function parse(text: string, config: ParserConfig): ParseResult {
  const tokens = tokenize(text);
  const keys = tokens.map(toKey);
  const keyAt = (i: number) => keys[i] ?? "";
  const matches = (i: number, phrase: string[]) => phrase.every((w, o) => keyAt(i + o) === w);
  const ctx: RuleContext = { tokens, keyAt, matches };

  const dict = config.dictionary;
  const stop = new Set(config.stopWords ?? DEFAULT_STOP_WORDS);
  const negWords = new Set(config.negationWords ?? DEFAULT_NEGATION_WORDS);
  const negPhrases = config.negationPhrases ?? DEFAULT_NEGATION_PHRASES;
  const phrases = [...(config.phrases ?? [])].sort((a, b) => b.phrase.length - a.phrase.length);
  const rules = config.rules ?? [];

  const chips: Chip[] = [];
  const leftover: string[] = [];
  const trace: string[] = [];
  let suggestion: ParseResult["suggestion"] = null;
  let neg = false;
  let negHit = false;
  const clearNeg = () => {
    neg = false;
    negHit = false;
  };
  const quote = (from: number, to: number) => `"${tokens.slice(from, to).join(" ")}"`;

  let i = 0;
  while (i < tokens.length) {
    const k = keyAt(i);
    const raw = tokens[i]!;
    if (!k) {
      i++;
      continue;
    }

    const phrase = phrases.find((p) => matches(i, p.phrase));
    if (phrase) {
      chips.push(toChip(phrase.chip));
      trace.push(`${quote(i, i + phrase.phrase.length)} → ${phrase.chip.kind}: ${phrase.chip.label}`);
      i += phrase.phrase.length;
      clearNeg();
      continue;
    }

    const negLen = negWords.has(k) ? 1 : (negPhrases.find((p) => matches(i, p))?.length ?? 0);
    if (negLen) {
      neg = true;
      negHit = false;
      trace.push(`${quote(i, i + negLen)} starts an exclusion`);
      i += negLen;
      continue;
    }

    let ruleHit: RuleMatch | null = null;
    for (const rule of rules) {
      ruleHit = rule.match(ctx, i);
      if (ruleHit) break;
    }
    if (ruleHit) {
      for (const c of ruleHit.chips ?? []) chips.push(toChip(c));
      trace.push(ruleHit.trace);
      i += Math.max(1, ruleHit.consumed);
      clearNeg();
      continue;
    }

    let entry: DictEntry | null = null;
    let used = 0;
    let fuzzy = false;
    let prefixNeg = false;
    const nonKey = /^non-?./.test(raw) ? toKey(raw.replace(/^non-?/, "")) : "";
    if (nonKey && dict.entries.has(nonKey)) {
      entry = dict.entries.get(nonKey)!;
      used = 1;
      prefixNeg = true;
    }
    for (let n = Math.min(4, tokens.length - i); n >= 1 && !entry; n--) {
      const e = dict.entries.get(keys.slice(i, i + n).join(""));
      if (e) {
        entry = e;
        used = n;
      }
    }
    if (!entry) {
      const hit = fuzzyLookup(dict, k, i + 1 < tokens.length ? k + keyAt(i + 1) : null);
      if (hit) {
        entry = hit.entry;
        used = hit.used;
        fuzzy = true;
      }
    }
    if (entry) {
      const negate = neg || prefixNeg;
      chips.push(
        toChip({
          kind: entry.kind,
          id: entry.id,
          label: entry.label,
          negate,
          fuzzy,
          ambiguous: entry.ambiguous ?? false,
          alts: entry.alts ?? [],
        }),
      );
      const how = [entry.kind, entry.via !== "name" ? entry.via : "", fuzzy ? "typo tolerance" : ""].filter(Boolean).join(", ");
      const also = entry.alts?.length ? `. ${entry.ambiguous ? "Ambiguous, also" : "Also"}: ${entry.alts.join(", ")}` : "";
      trace.push(`${quote(i, i + used)} → ${negate ? "exclude " : ""}${entry.label} (${how})${also}`);
      if (neg) negHit = true;
      i += used;
      continue;
    }

    if (CONNECTORS.has(k) && neg && negHit) {
      i++;
      continue;
    }

    if (stop.has(k)) {
      if (neg && negHit) clearNeg();
      i++;
      continue;
    }

    const common = dict.commonWordSurnames.get(k);
    if (common) trace.push(`"${raw}" not matched alone. It is a common word. Type the full name, for example ${common[0]}.`);

    const first = dict.firstNames.get(k);
    if (first && i === tokens.length - 1) {
      suggestion = { from: raw, to: first[0]! };
      trace.push(`"${raw}" is a partial name. Suggest ${first[0]}.`);
      i++;
      continue;
    }

    leftover.push(raw);
    if (neg) {
      trace.push(`Exclusion did not apply: "${raw}" is not a known term`);
      clearNeg();
    }
    i++;
  }

  if (leftover.length) trace.push(`Free text: "${leftover.join(" ")}". Not in the dictionaries, so semantic search ranks by meaning.`);

  const seen = new Set<string>();
  const unique = chips.filter((c) => !seen.has(c.sig) && seen.add(c.sig));
  return { chips: unique, leftover, trace, suggestion };
}
