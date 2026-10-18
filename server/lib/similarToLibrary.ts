// The pure parts of Similar to Your Library (F2-D-311).

// The most library artists whose similar artists are read.
export const LIBRARY_READ_LIMIT = 30;

// The most artists the slider shows.
export const SIMILAR_TO_LIBRARY_LIMIT = 20;

// At most `limit` of the artists, spread evenly over the list ordered by
// Lidarr's id: the ones at index floor(i * n / limit) for i from 0 to limit - 1
// (all of them where there are `limit` or fewer), so the part read is the same
// at every load and runs from the oldest artist to the newest.
export function pickSpread<T extends { id?: number }>(
  artists: T[],
  limit: number = LIBRARY_READ_LIMIT
): T[] {
  const ordered = artists
    .map((artist, index) => ({ artist, index }))
    .sort((a, b) => {
      const x = a.artist.id ?? Number.MAX_SAFE_INTEGER;
      const y = b.artist.id ?? Number.MAX_SAFE_INTEGER;

      return x - y || a.index - b.index;
    })
    .map(({ artist }) => artist);
  const n = ordered.length;

  if (n <= limit) {
    return ordered;
  }

  return Array.from(
    { length: limit },
    (_, i) => ordered[Math.floor((i * n) / limit)]
  );
}

// What ListenBrainz gave as similar to one library artist that was read.
export interface SimilarAnswer {
  similar: { mbid: string; name: string; score: number }[];
}

export interface RankedSimilarArtist {
  mbid: string;
  name: string;
  // the best score among the read artists it is similar to
  score: number;
  // how many of the read artists it is similar to
  count: number;
}

// The artists the read ones are similar to that the library does not hold, the
// one similar to more of the read artists first, then the higher best score,
// then its id (ascending), at most 20. libraryIds is every artist Lidarr holds,
// not only those read. An artist is counted once for a read artist, and its
// name is the one of its best-scored entry.
export function rankSimilarToLibrary(
  answers: SimilarAnswer[],
  libraryIds: Iterable<string>,
  limit: number = SIMILAR_TO_LIBRARY_LIMIT
): RankedSimilarArtist[] {
  const held = new Set(libraryIds);
  const found = new Map<string, RankedSimilarArtist>();

  for (const answer of answers) {
    const seen = new Set<string>();

    for (const entry of answer.similar) {
      if (held.has(entry.mbid)) {
        continue;
      }

      const known = found.get(entry.mbid);

      if (!known) {
        found.set(entry.mbid, {
          mbid: entry.mbid,
          name: entry.name,
          score: entry.score,
          count: 1,
        });
        seen.add(entry.mbid);
        continue;
      }

      if (entry.score > known.score) {
        known.score = entry.score;
        known.name = entry.name;
      }

      if (!seen.has(entry.mbid)) {
        known.count += 1;
        seen.add(entry.mbid);
      }
    }
  }

  return [...found.values()]
    .sort(
      (a, b) =>
        b.count - a.count ||
        b.score - a.score ||
        (a.mbid < b.mbid ? -1 : a.mbid > b.mbid ? 1 : 0)
    )
    .slice(0, limit);
}
