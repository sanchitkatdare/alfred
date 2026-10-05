/** Catalog metadata shipped to the browser. No overviews and no vectors. */
export interface Movie {
  id: number;
  title: string;
  year: number;
  runtime: number;
  genres: string[];
  rating: number;
  cast: string[];
  directors: string[];
  originalTitle?: string;
  votes?: number;
  language?: string;
}

/** Shape of public/data/catalog-meta.json, written by scripts/seed.ts. People are stored once and referenced by index. */
export interface CatalogMeta {
  generatedAt: string;
  source: "TMDB";
  people: string[];
  movies: (Omit<Movie, "cast" | "directors"> & { cast: number[]; directors: number[] })[];
}

export function hydrateCatalog(meta: CatalogMeta): Movie[] {
  const name = (i: number) => meta.people[i] ?? "";
  return meta.movies.map((m) => ({ ...m, cast: m.cast.map(name), directors: m.directors.map(name) }));
}
