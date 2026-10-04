import {
  buildDictionary,
  DEFAULT_STOP_WORDS,
  DEFAULT_TASK_PHRASES,
  toKey,
  type ParserConfig,
  type PersonSpec,
  type PhraseChip,
  type Rule,
  type RuleContext,
  type RouterOptions,
} from "@alfred/agent-harness";
import type { Movie } from "./catalog";

const GENRES: { id: string; label: string; aliases: string[] }[] = [
  { id: "sci-fi", label: "Sci-fi", aliases: ["scifi", "science fiction", "sf"] },
  { id: "action", label: "Action", aliases: [] },
  { id: "comedy", label: "Comedy", aliases: ["comedies", "funny"] },
  { id: "drama", label: "Drama", aliases: ["dramas"] },
  { id: "horror", label: "Horror", aliases: ["scary"] },
  { id: "thriller", label: "Thriller", aliases: ["thrillers"] },
  { id: "romance", label: "Romance", aliases: ["romantic"] },
  { id: "crime", label: "Crime", aliases: [] },
  { id: "animation", label: "Animation", aliases: ["animated", "cartoon"] },
  { id: "family", label: "Family", aliases: ["kids"] },
  { id: "fantasy", label: "Fantasy", aliases: [] },
  { id: "adventure", label: "Adventure", aliases: ["adventures"] },
  { id: "mystery", label: "Mystery", aliases: ["whodunit"] },
  { id: "documentary", label: "Documentary", aliases: ["documentaries", "docs"] },
  { id: "history", label: "History", aliases: ["historical"] },
  { id: "music", label: "Music", aliases: ["musical", "musicals"] },
  { id: "tv-movie", label: "TV movie", aliases: ["tv movies", "made for tv"] },
  { id: "war", label: "War", aliases: [] },
  { id: "western", label: "Western", aliases: ["westerns"] },
];

/** All 19 TMDB genre IDs, in the form stored in the catalog. */
export const GENRE_IDS = GENRES.map((g) => g.id);

/** Surnames that are also English words. They match only as part of a full name. */
const COMMON_WORDS = ["stone", "hill", "king", "wood", "young", "hunt", "bell", "fox", "day", "hardy", "grant", "blunt", "bale", "page", "moss", "ledger", "foster", "wright"];

const STOP_WORDS = [...DEFAULT_STOP_WORDS, "movie", "movies", "film", "films", "flick", "flicks", "watch", "tonight", "recommend", "suggest", "directed", "director", "star", "stars"];

const UNWATCHED = { kind: "user", id: "unwatched", label: "Unwatched only" };
const GROUP = { kind: "task", id: "group", label: "group pick" };
const PHRASES: PhraseChip[] = [
  ...DEFAULT_TASK_PHRASES,
  { phrase: ["movie", "night"], chip: { kind: "task", id: "plan", label: "plan" } },
  { phrase: ["marathon"], chip: { kind: "task", id: "plan", label: "plan" } },
  ...[["me", "and"], ["my", "friend"], ["my", "friends"], ["friend"], ["friends"], ["both", "of", "us"]].map((phrase) => ({ phrase, chip: GROUP })),
  ...[["havent", "seen"], ["havent", "watched"], ["not", "seen"], ["not", "watched"], ["new", "to", "me"], ["unwatched"], ["unseen"]].map((phrase) => ({ phrase, chip: UNWATCHED })),
];

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, a: 1, an: 1 };
const HOURS = new Set(["h", "hr", "hrs", "hour", "hours"]);
const MINUTES = new Set(["m", "min", "mins", "minute", "minutes"]);
const STARS = new Set(["star", "stars", "rating"]);

function readNumber(ctx: RuleContext, i: number): { n: number; unit: string | null } | null {
  const t = ctx.tokens[i];
  if (!t) return null;
  const match = t.match(/^(\d+(?:\.\d+)?)(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)?$/);
  if (match) return { n: parseFloat(match[1]!), unit: match[2] ?? null };
  const word = NUMBER_WORDS[ctx.keyAt(i)];
  return word ? { n: word, unit: null } : null;
}

const quote = (ctx: RuleContext, from: number, to: number) => `"${ctx.tokens.slice(from, to).join(" ")}"`;
const ratingChip = (n: number) => ({ kind: "rating", id: String(n), label: `Rating ≥ ${n}`, data: { min: n } });

/** "7+", "8/10", "highly rated", "rated 8", "rated above 7 stars". */
const ratingRule: Rule = {
  name: "rating",
  match(ctx, i) {
    const k = ctx.keyAt(i);
    const short = ctx.tokens[i]!.match(/^(\d+(?:\.\d+)?)(\+|\/10)$/);
    if (short && parseFloat(short[1]!) <= 10) {
      const n = parseFloat(short[1]!);
      return { consumed: 1, chips: [ratingChip(n)], trace: `${quote(ctx, i, i + 1)} → rating ≥ ${n}` };
    }
    if (["highly", "top", "well"].includes(k) && ctx.keyAt(i + 1) === "rated") {
      return { consumed: 2, chips: [ratingChip(8)], trace: `${quote(ctx, i, i + 2)} → rating ≥ 8` };
    }
    if (k !== "rated" && k !== "rating") return null;
    let j = i + 1;
    if (ctx.keyAt(j) === "above" || ctx.keyAt(j) === "over") j++;
    else if (ctx.matches(j, ["at", "least"])) j += 2;
    const num = readNumber(ctx, j);
    if (!num || num.unit || num.n > 10) return null;
    if (STARS.has(ctx.keyAt(j + 1))) j++;
    return { consumed: j + 1 - i, chips: [ratingChip(num.n)], trace: `${quote(ctx, i, j + 1)} → rating ≥ ${num.n}` };
  },
};

const MAX_WORDS = new Set(["under", "less", "shorter", "below", "within", "max"]);
const MIN_WORDS = new Set(["over", "longer", "more", "above", "greater"]);

/**
 * Comparisons with a number. Unit decides the meaning:
 * - hours or minutes: runtime. "stars" or "rating": rating.
 * - no unit after a minimum word ("above 7"), 10 or less: rating.
 * - no unit, 4 or less: hours. 30 or more: minutes. Anything else is ambiguous.
 * "shorter" and "longer" always mean runtime.
 */
const comparisonRule: Rule = {
  name: "comparison",
  match(ctx, i) {
    const k = ctx.keyAt(i);
    if (k === "short" || k === "quick") {
      return { consumed: 1, chips: [{ kind: "runtime", id: "max100", label: "≤ 100 min", data: { max: 100 } }], trace: `${quote(ctx, i, i + 1)} → runtime ≤ 100 min` };
    }
    const atLeast = ctx.matches(i, ["at", "least"]);
    const isMax = MAX_WORDS.has(k);
    const isMin = atLeast || MIN_WORDS.has(k);
    if (!isMax && !isMin) return null;
    const runtimeOnly = k === "shorter" || k === "longer";
    let j = i + (atLeast ? 2 : 1);
    if (ctx.keyAt(j) === "than") j++;
    const num = readNumber(ctx, j);
    if (!num) return null;

    let unit = num.unit;
    const next = ctx.keyAt(j + 1);
    if (!unit && (HOURS.has(next) || MINUTES.has(next))) {
      unit = next;
      j++;
    } else if (!unit && STARS.has(next)) {
      return { consumed: j + 2 - i, chips: [ratingChip(num.n)], trace: `${quote(ctx, i, j + 2)} → rating ≥ ${num.n}` };
    }
    const phrase = quote(ctx, i, j + 1);
    if (!unit && !runtimeOnly && isMin && num.n <= 10) {
      return { consumed: j + 1 - i, chips: [ratingChip(num.n)], trace: `${phrase} → rating ≥ ${num.n}. A number of 10 or less with no unit means rating.` };
    }

    let minutes: number;
    if (unit) minutes = HOURS.has(unit) ? num.n * 60 : num.n;
    else if (num.n <= 4) minutes = num.n * 60;
    else if (num.n >= 30) minutes = num.n;
    else return { consumed: j + 1 - i, trace: `${phrase} is ambiguous. Add a unit: "hours", "min" or "stars".` };

    minutes = Math.round(minutes);
    const sign = isMax ? "≤" : "≥";
    return {
      consumed: j + 1 - i,
      chips: [{ kind: "runtime", id: `${isMax ? "max" : "min"}${minutes}`, label: `${sign} ${minutes} min`, data: isMax ? { min: null, max: minutes } : { min: minutes, max: null } }],
      trace: `${phrase} → runtime ${sign} ${minutes} min`,
    };
  },
};

/** "90s", "1990s", "after 2010", "before 2000", "2014", "recent", "classic". */
const yearRule: Rule = {
  name: "year",
  match(ctx, i) {
    const k = ctx.keyAt(i);
    const raw = ctx.tokens[i]!;
    const one = (label: string, min: number | null, max: number | null, consumed = 1) => ({
      consumed,
      chips: [{ kind: "year", id: label, label, data: { min, max } }],
      trace: `${quote(ctx, i, i + consumed)} → year: ${label}`,
    });
    const decade = raw.match(/^'?(\d{2}|\d{4})s$/);
    if (decade) {
      let y = parseInt(decade[1]!, 10);
      if (y < 100) y += y >= 30 ? 1900 : 2000;
      return one(`${y}s`, y, y + 9);
    }
    const next = ctx.keyAt(i + 1);
    if (["after", "since", "from"].includes(k) && /^(19|20)\d{2}$/.test(next)) return one(`From ${next}`, parseInt(next, 10), null, 2);
    if (["before", "until"].includes(k) && /^(19|20)\d{2}$/.test(next)) return one(`Before ${next}`, null, parseInt(next, 10) - 1, 2);
    if (/^(19|20)\d{2}$/.test(k)) return one(k, parseInt(k, 10), parseInt(k, 10));
    if (k === "recent" || (k === "new" && next !== "to")) return one("2015 or later", 2015, null);
    if (["classic", "old", "older"].includes(k)) return one("Before 2000", null, 1999);
    return null;
  },
};

/** "like Inception", "similar to The Matrix". Titles match only after these words, so "Up" or "Her" stay ordinary words. */
function similarRule(titles: Map<string, Movie>): Rule {
  return {
    name: "similar",
    match(ctx, i) {
      const k = ctx.keyAt(i);
      const start = k === "like" ? i + 1 : k === "similar" && ctx.keyAt(i + 1) === "to" ? i + 2 : -1;
      if (start < 0) return null;
      for (let n = Math.min(7, ctx.tokens.length - start); n >= 1; n--) {
        const key = ctx.tokens.slice(start, start + n).map(toKey).join("");
        const movie = titles.get(key);
        if (movie) {
          return {
            consumed: start + n - i,
            chips: [{ kind: "similar", id: String(movie.id), label: movie.title }],
            trace: `${quote(ctx, i, start + n)} → similar to ${movie.title}`,
          };
        }
      }
      return null;
    },
  };
}

function titleWords(catalog: Movie[]): string[] {
  return [...new Set(catalog.flatMap((m) => [m.title, m.originalTitle ?? ""].join(" ").split(/[^\p{L}\p{N}]+/u).map(toKey).filter((w) => w.length > 2)))];
}

export function buildMovieParserConfig(catalog: Movie[]): ParserConfig {
  const counts = new Map<string, PersonSpec>();
  const titles = new Map<string, Movie>();
  for (const movie of catalog) {
    for (const [kind, names] of [["actor", movie.cast], ["director", movie.directors]] as const) {
      for (const name of names) {
        const p = counts.get(name) ?? { kind, name, count: 0 };
        p.count++;
        counts.set(name, p);
      }
    }
    titles.set(toKey(movie.title), movie);
    if (/^the /i.test(movie.title)) titles.set(toKey(movie.title.slice(4)), movie);
    const base = movie.title.split(":")[0]!;
    if (base !== movie.title && !titles.has(toKey(base))) titles.set(toKey(base), movie);
  }

  return {
    dictionary: buildDictionary({
      terms: GENRES.map((g) => ({ kind: "genre", ...g })),
      people: [...counts.values()],
      // A surname alone does not match when it is a common word or appears in any title ("story", "potter", "knight").
      commonWords: [...COMMON_WORDS, ...titleWords(catalog)],
      minSurnameCount: 2,
    }),
    rules: [ratingRule, comparisonRule, yearRule, similarRule(titles)],
    phrases: PHRASES,
    stopWords: STOP_WORDS,
  };
}

export const MOVIE_ROUTER_OPTIONS: RouterOptions = { semanticKinds: ["similar"] };
