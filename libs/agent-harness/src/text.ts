/** Lowercase, strip accents and normalize curly apostrophes. */
export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[‘’]/g, "'");
}

/** Matching key: letters and digits only, so "De Niro", "deNiro" and "de-niro" are equal. */
export function toKey(text: string): string {
  return normalize(text).replace(/[^a-z0-9]/g, "");
}

/** Split a query into tokens. Commas become separate tokens; quotes are dropped. */
export function tokenize(text: string): string[] {
  return normalize(text)
    .replace(/["“”]/g, " ")
    .replace(/([,;!?])/g, " $1 ")
    .split(/\s+/)
    .map((t) => t.replace(/^[.(]+|[.):]+$/g, ""))
    .filter(Boolean);
}

export function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}
