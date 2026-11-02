import { toKey } from "./text";

export interface DictEntry {
  kind: string;
  id: string;
  label: string;
  /** How the key was produced. Fuzzy matching uses only "name" and "alias" keys. */
  via: "name" | "alias" | "surname";
  /** Surname shared by people with similar film counts. The top person is used. */
  ambiguous?: boolean;
  alts?: string[];
}

export interface Dictionary {
  entries: Map<string, DictEntry>;
  /** First-name key -> full names, most frequent first. Used for autocomplete suggestions. */
  firstNames: Map<string, string[]>;
  /** Surname keys skipped because they are common words ("stone", "hill"). */
  commonWords: ReadonlySet<string>;
  commonWordSurnames: Map<string, string[]>;
}

/** A fixed vocabulary term, for example a genre, ingredient or diet. */
export interface TermSpec {
  kind: string;
  id: string;
  label: string;
  aliases?: string[];
}

/** A person, for example an actor or director. `count` is the number of catalog items they appear in. */
export interface PersonSpec {
  kind: string;
  name: string;
  count: number;
}

export interface DictionaryOptions {
  terms?: TermSpec[];
  people?: PersonSpec[];
  /** Words that are also names. A surname or one-word name in this list matches only as part of a full name, and typo matching leaves these words alone. */
  commonWords?: Iterable<string>;
  /** Minimum item count for a surname to match alone. Rare people match only by full name. */
  minSurnameCount?: number;
}

const PARTICLES = new Set(["de", "del", "da", "di", "van", "von", "le"]);

function surnameOf(name: string): string {
  const parts = name.split(" ");
  for (let i = 1; i < parts.length - 1; i++) {
    if (PARTICLES.has(parts[i]!.toLowerCase())) return parts.slice(i).join(" ");
  }
  return parts[parts.length - 1]!;
}

export function buildDictionary(options: DictionaryOptions): Dictionary {
  const entries = new Map<string, DictEntry>();
  const firstNames = new Map<string, string[]>();
  const commonWordSurnames = new Map<string, string[]>();
  const common = new Set(options.commonWords ?? []);
  /* A surname resolves to its top person when that person has this many times more items than the next. */
  const dominance = 3;
  /* Minimum item count for a first-name suggestion. */
  const minFirst = 2;
  const minSurname = options.minSurnameCount ?? 1;

  for (const t of options.terms ?? []) {
    entries.set(toKey(t.label), { kind: t.kind, id: t.id, label: t.label, via: "name" });
    for (const a of t.aliases ?? []) {
      const k = toKey(a);
      if (!entries.has(k)) entries.set(k, { kind: t.kind, id: t.id, label: t.label, via: "alias" });
    }
  }

  const people = [...(options.people ?? [])].sort((a, b) => b.count - a.count);
  const bySurname = new Map<string, PersonSpec[]>();
  for (const p of people) {
    const nameKey = toKey(p.name);
    // One-word names like "Prince" or "J" are too easy to type by accident.
    const tooCommon = !p.name.includes(" ") && (common.has(nameKey) || nameKey.length < 3);
    if (!tooCommon) entries.set(nameKey, { kind: p.kind, id: p.name, label: p.name, via: "name" });
    const sk = toKey(surnameOf(p.name));
    bySurname.set(sk, [...(bySurname.get(sk) ?? []), p]);
    if (p.count >= minFirst) {
      const fk = toKey(p.name.split(" ")[0]!);
      firstNames.set(fk, [...(firstNames.get(fk) ?? []), p.name]);
    }
  }

  for (const [sk, group] of bySurname) {
    if (sk.length < 3) continue;
    if (common.has(sk)) {
      commonWordSurnames.set(sk, group.map((p) => p.name));
      continue;
    }
    if (entries.has(sk)) continue;
    const [top, next] = group as [PersonSpec, PersonSpec | undefined];
    if (top.count < minSurname) continue;
    const clear = !next || top.count >= dominance * next.count;
    entries.set(sk, {
      kind: top.kind,
      id: top.name,
      label: top.name,
      via: "surname",
      ambiguous: !clear,
      alts: group.slice(1).map((p) => p.name),
    });
  }

  return { entries, firstNames, commonWordSurnames, commonWords: common };
}
