// The order Recently Added visits the albums in (F2-D-311): by a bound no
// album's time exceeds - the later of its latest import in Lidarr's history and
// its earliest held file's dateAdded - so that only as much of Lidarr's import
// history is read as the order needs.

// an album Lidarr holds a file of: its place in Lidarr's list and its earliest
// held file's dateAdded in milliseconds (null where none is known)
export interface BoundAlbum {
  id: number;
  index: number;
  earliest: number | null;
}

// one import record of Lidarr's history, in milliseconds
export interface ImportRecord {
  albumId: number;
  at: number;
}

export interface BoundOrder {
  // the next albums, at most `count`, by descending bound (ties in Lidarr's
  // order), each with its bound
  next: { album: BoundAlbum; bound: number }[];
  // true where no album's place can be told from the pages read: another page
  // is asked
  needPage: boolean;
  // the latest bound an album not in `next` can have
  ceiling: number;
}

// `imports` are the import records of the pages read so far, newest first;
// `complete` is true once the last page is among them. Once the pages reach
// back to a date D, an album whose latest import was seen has its bound, and
// an album not seen has its latest import no later than D: its bound is its
// earliest held file where that is no earlier than D, else no later than D.
export function nextAlbumsByBound({
  albums,
  imports,
  complete,
  visited,
  count,
}: {
  albums: BoundAlbum[];
  imports: ImportRecord[];
  complete: boolean;
  visited: Set<number>;
  count: number;
}): BoundOrder {
  const reach = complete
    ? -Infinity
    : imports.length > 0
      ? imports[imports.length - 1].at
      : Infinity;
  const latestImport = new Map<number, number>();

  for (const record of imports) {
    // newest first: the first met is the latest
    if (!latestImport.has(record.albumId)) {
      latestImport.set(record.albumId, record.at);
    }
  }

  const known: { album: BoundAlbum; bound: number }[] = [];
  let ceiling = -Infinity;

  for (const album of albums) {
    if (visited.has(album.id)) {
      continue;
    }

    const earliest = album.earliest ?? -Infinity;
    const seen = latestImport.get(album.id);
    const bound = seen === undefined ? earliest : Math.max(seen, earliest);

    if (seen !== undefined || bound >= reach) {
      known.push({ album, bound });
    } else {
      ceiling = Math.max(ceiling, reach);
    }
  }

  known.sort((a, b) => b.bound - a.bound || a.album.index - b.album.index);

  const next = known.slice(0, count);

  return {
    next,
    needPage: next.length === 0 && ceiling > -Infinity,
    ceiling: Math.max(ceiling, known[count]?.bound ?? -Infinity),
  };
}
