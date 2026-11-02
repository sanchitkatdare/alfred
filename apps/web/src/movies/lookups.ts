import { normalize, toKey } from "@alfred/agent-harness";
import type { Movie } from "./catalog";
import { PRONOUNS } from "./followups";

/**
 * Level 2 workflows: questions and actions answered by code from data we already hold.
 * They never use the LLM. Each pattern matches the whole message, so compound requests
 * ("who directed X and is it worth watching?") still go to the assistant.
 */
export type LookupKind = "director" | "cast" | "runtime" | "year" | "rating" | "genre" | "about" | "watched-list";

export interface Lookup {
  kind: LookupKind;
  /** The movie the question is about; absent for the watched list. */
  movie?: Movie;
  /** Other catalog movies with the same title, most voted first. */
  others: Movie[];
}

/** "about" fetches a story file, so it runs on Enter; the rest answer while typing. Marking watched happens only through the page's buttons. */
export const RUNS_ON_ENTER: ReadonlySet<LookupKind> = new Set(["about"]);

const T = "(.+?)"; // title slot (lazy, so "the dark knight as watched" keeps "as" out)
const PATTERNS: [LookupKind, RegExp][] = [
  ["director", new RegExp(`^(?:who|which director) (?:directed|made|did direct) ${T}$`)],
  ["director", new RegExp(`^who (?:is|was) the director of ${T}$`)],
  ["cast", new RegExp(`^who (?:stars|starred|acts|acted|plays|played|is|was) in ${T}$`)],
  ["cast", new RegExp(`^(?:the )?(?:cast|actors) (?:of|in) ${T}$`)],
  ["runtime", new RegExp(`^how (?:long|many minutes) is ${T}$`)],
  ["runtime", new RegExp(`^(?:what is |whats )?the (?:runtime|length) of ${T}$`)],
  ["year", new RegExp(`^when (?:did|was) ${T} (?:come out|released|made)$`)],
  ["year", new RegExp(`^what year (?:did|was|is) ${T} (?:come out|released|made|from)$`)],
  ["rating", new RegExp(`^(?:what is|whats|how is) ${T} rated$`)],
  ["rating", new RegExp(`^(?:what is |whats )?the (?:rating|score) (?:of|for) ${T}$`)],
  ["genre", new RegExp(`^what (?:genre|kind of movie|type of movie) is ${T}$`)],
  ["about", new RegExp(`^(?:what is|whats) ${T} about$`)],
  ["about", new RegExp(`^(?:tell me about|what happens in) ${T}$`)],
  ["about", new RegExp(`^(?:the )?(?:plot|synopsis|story|summary) of ${T}$`)],
];
const WATCHED_LIST = /^(?:what|which)(?: movies| films)? have i (?:watched|seen)(?: so far)?$|^(?:show )?(?:me )?my (?:watched|seen)(?: list| movies)?$/;

/** Lowercase, no accents, no quotes or trailing punctuation, single spaces. */
function clean(text: string): string {
  return normalize(text)
    .replace(/["“”]/g, "")
    .replace(/'s\b/g, "s")
    .replace(/[?.!]+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface TitleIndex {
  byKey: Map<string, Movie[]>;
}

const isLatin = (title: string) => !/[^\p{ASCII}]/u.test(normalize(title));

/**
 * Titles and original titles, with and without a leading "the", most voted first. The part before
 * a colon also matches, unless a movie has exactly that title ("Dune" stays Dune, not "Dune: Part Two").
 */
export function buildTitleIndex(catalog: Movie[]): TitleIndex {
  const collect = (titlesOf: (m: Movie) => string[]) => {
    const found = new Map<string, Set<Movie>>();
    for (const m of catalog) {
      for (const title of titlesOf(m)) {
        for (const k of [toKey(title), toKey(title.replace(/^the\s+/i, ""))]) {
          if (!k) continue;
          if (!found.has(k)) found.set(k, new Set());
          found.get(k)!.add(m);
        }
      }
    }
    return found;
  };
  // An original title in another script loses those letters in its key ("A計劃" → "a"), so it cannot match.
  const exact = collect((m) => (m.originalTitle && isLatin(m.originalTitle) ? [m.title, m.originalTitle] : [m.title]));
  const bases = collect((m) => (m.title.includes(":") ? [m.title.split(":")[0]!] : []));
  const byKey = new Map<string, Movie[]>();
  for (const [k, movies] of [...bases, ...exact]) byKey.set(k, [...movies].sort((a, b) => (b.votes ?? 0) - (a.votes ?? 0)));
  return { byKey };
}

/** "the movie Inception (2010)" → Inception. A trailing year picks between remakes. */
function resolveTitle(raw: string, index: TitleIndex): { movie: Movie; others: Movie[] } | null {
  const candidatesFor = (text: string) => index.byKey.get(toKey(text.replace(/^(?:the )?(?:movie|film) /, "").replace(/ (?:movie|film)$/, "").trim())) ?? [];
  // The whole text first, so "Blade Runner 2049" and "1917" stay titles.
  const whole = candidatesFor(raw);
  const yearMatch = whole.length ? null : raw.match(/\(?\b(19|20)\d{2}\)?$/);
  const year = yearMatch ? Number(yearMatch[0].replace(/\D/g, "")) : null;
  const candidates = yearMatch ? candidatesFor(raw.slice(0, yearMatch.index)) : whole;
  if (!candidates.length) return null;
  const movie = (year && candidates.find((m) => m.year === year)) || candidates[0]!;
  return { movie, others: candidates.filter((m) => m !== movie) };
}

export function detectLookup(text: string, index: TitleIndex): Lookup | null {
  const q = clean(text);
  if (WATCHED_LIST.test(q)) return { kind: "watched-list", others: [] };
  for (const [kind, pattern] of PATTERNS) {
    const m = q.match(pattern);
    const found = m && !PRONOUNS.has(m[1]!) && resolveTitle(m[1]!, index);
    if (found) return { kind, ...found };
  }
  return null;
}

const label = (m: Movie) => `${m.title} (${m.year})`;
const list = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const hours = (min: number) => `${Math.floor(min / 60)} h ${min % 60} min`;

/** Short description for the chip and dev mode, for example "director · Inception (2010)". */
export const describeLookup = (l: Lookup) => (l.movie ? `${l.kind} · ${label(l.movie)}` : l.kind);

/** Answer text for the read-only kinds that need no file or state. */
export function answerFromCatalog(l: Lookup): string | null {
  const m = l.movie;
  if (!m) return null;
  switch (l.kind) {
    case "director":
      return m.directors.length ? `${label(m)} was directed by ${list(m.directors)}.` : `The catalog has no director for ${label(m)}.`;
    case "cast":
      return m.cast.length ? `${label(m)} stars ${list(m.cast)} (top-billed cast).` : `The catalog has no cast for ${label(m)}.`;
    case "runtime":
      return `${label(m)} runs ${hours(m.runtime)} (${m.runtime} minutes).`;
    case "year":
      return `${m.title} came out in ${m.year}.`;
    case "rating":
      return `${label(m)} is rated ${m.rating.toFixed(1)} on TMDB${m.votes ? ` from ${m.votes.toLocaleString()} votes` : ""}.`;
    case "genre":
      return `${label(m)}: ${list(m.genres)}.`;
    default:
      return null;
  }
}

export const aboutAnswer = (m: Movie, story: { overview: string; tagline: string } | undefined) =>
  story?.overview ? `${label(m)}${story.tagline ? ` · "${story.tagline}"` : ""}\n${story.overview}` : `The catalog has no story text for ${label(m)}.`;
