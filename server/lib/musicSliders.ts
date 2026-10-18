import { getLidarrMetadata } from '@server/api/lidarrmetadata';
import { getListenBrainz } from '@server/api/listenbrainz';
import type {
  LidarrAlbum,
  LidarrArtist,
  LidarrTrackFile,
} from '@server/api/servarr/lidarr';
import type { BoundAlbum, ImportRecord } from '@server/lib/albumBoundOrder';
import { nextAlbumsByBound } from '@server/lib/albumBoundOrder';
import { albumCameInAt } from '@server/lib/albumCameInAt';
import type { MusicAlbumSummary, MusicArtistSummary } from '@server/lib/music';
import {
  buildLidarr,
  getDefaultLidarr,
  logFailure,
  metadataImage,
  toAlbumSummary,
} from '@server/lib/music';
import type { SimilarAnswer } from '@server/lib/similarToLibrary';
import { pickSpread, rankSimilarToLibrary } from '@server/lib/similarToLibrary';
import logger from '@server/logger';

// A music slider shows at most 20 items (F2-D-92).
export const SLIDER_LIMIT = 20;

// Lidarr's import history is read this many records a page, newest first.
const IMPORT_PAGE_SIZE = 200;
// the histories and tracks of this many albums are read side by side
const BATCH = 5;

// The albums the default Lidarr holds at least one track file of, in the order
// Lidarr imported them, the album that came into the library last first (F2-D-311):
// each album's time is decided by albumCameInAt from its history, its tracks and
// its held files, the albums visited in descending order of a bound no album's
// time exceeds (nextAlbumsByBound) until 20 are placed and the twentieth's time
// is no earlier than the next album's bound; then by time, latest first, ties in
// Lidarr's order. At most 20, read as Lidarr stands now (no cache). No default
// Lidarr server gives none; Lidarr failing, any read among it, throws.
export async function getRecentlyAddedAlbums(): Promise<MusicAlbumSummary[]> {
  const server = getDefaultLidarr();

  if (!server) {
    return [];
  }

  const lidarr = buildLidarr(server);
  const held = (await lidarr.getAlbums()).filter(
    (album): album is LidarrAlbum & { id: number } =>
      album.id !== undefined && (album.statistics?.trackFileCount ?? 0) > 0
  );

  if (held.length === 0) {
    return [];
  }

  const files = new Map<number, LidarrTrackFile[]>();
  const earliest = new Map<number, number>();

  for (const file of await lidarr.getTrackFiles(held.map((a) => a.id))) {
    files.set(file.albumId, [...(files.get(file.albumId) ?? []), file]);

    const added = Date.parse(file.dateAdded);

    if (
      !Number.isNaN(added) &&
      added < (earliest.get(file.albumId) ?? Infinity)
    ) {
      earliest.set(file.albumId, added);
    }
  }

  const heldById = new Map(held.map((album) => [album.id, album]));
  const boundAlbums: BoundAlbum[] = held.map((album, index) => ({
    id: album.id,
    index,
    earliest: earliest.get(album.id) ?? null,
  }));
  const imports: ImportRecord[] = [];
  const visited = new Set<number>();
  const placed: { album: LidarrAlbum & { id: number }; time: number }[] = [];
  let complete = false;
  let nextPage = 1;

  for (;;) {
    const order = nextAlbumsByBound({
      albums: boundAlbums,
      imports,
      complete,
      visited,
      count: BATCH,
    });

    // the latest time any album not yet read can have
    const ceiling = order.needPage
      ? order.ceiling
      : order.next.length > 0
        ? order.next[0].bound
        : null;

    if (ceiling === null) {
      break;
    }

    if (placed.length >= SLIDER_LIMIT) {
      const twentieth = [...placed].sort((a, b) => b.time - a.time)[
        SLIDER_LIMIT - 1
      ].time;

      if (twentieth >= ceiling) {
        break;
      }
    }

    if (order.needPage) {
      const page = await lidarr.getImportHistory(nextPage, IMPORT_PAGE_SIZE);

      nextPage += 1;
      complete =
        page.records.length === 0 ||
        page.page * page.pageSize >= page.totalRecords;

      for (const record of page.records) {
        const at = Date.parse(record.date);

        if (record.albumId !== undefined && !Number.isNaN(at)) {
          imports.push({ albumId: record.albumId, at });
        }
      }

      imports.sort((a, b) => b.at - a.at);
      continue;
    }

    const batch = order.next.map(({ album }) => album);

    const times = await Promise.all(
      batch.map(async ({ id }) => {
        const album = heldById.get(id) as LidarrAlbum & { id: number };
        const [history, tracks] = await Promise.all([
          lidarr.getAlbumHistory(album.artistId ?? album.artist?.id ?? 0, id),
          lidarr.getTracks(id),
        ]);
        const time = albumCameInAt(
          history,
          (files.get(id) ?? []).map((file) => ({
            id: file.id,
            dateAdded: file.dateAdded,
            trackIds: tracks
              .filter((track) => track.trackFileId === file.id)
              .map((track) => track.id),
          })),
          tracks.map((track) => track.id)
        );

        return { album, time: time ?? -Infinity };
      })
    );

    for (const entry of times) {
      visited.add(entry.album.id);
      placed.push(entry);
    }
  }

  const ordered = placed
    .map((entry) => ({
      ...entry,
      index: held.findIndex((a) => a.id === entry.album.id),
    }))
    .sort((a, b) => b.time - a.time || a.index - b.index)
    .slice(0, SLIDER_LIMIT)
    .map(({ album }) => album);

  // an album Lidarr gave without its artist has it by the artist's id
  const artists = ordered.some((album) => !album.artist)
    ? await lidarr.getArtists()
    : [];

  return ordered.map((album) =>
    toAlbumSummary({
      ...album,
      artist:
        album.artist ?? artists.find((artist) => artist.id === album.artistId),
    })
  );
}

// The one clock the deadlines of Similar to Your Library are read from: what
// time it is, and a timer that can be cancelled. Tests drive it (F2-D-311).
export const sliderClock = {
  now: (): number => Date.now(),
  setTimer: (ms: number, fn: () => void): (() => void) => {
    const timer = setTimeout(fn, ms);

    return () => clearTimeout(timer);
  },
};

// Waits for a read until `ms` after `startedAt` on the slider clock: its value
// where it answers by then, else `fallback`; the read itself is left to end.
// A read that fails fails here too.
function waitUntil<T>(
  read: Promise<T>,
  startedAt: number,
  ms: number,
  fallback: T
): Promise<T> {
  const remaining = startedAt + ms - sliderClock.now();

  if (remaining <= 0) {
    // left to end, never an unhandled failure
    read.catch(() => undefined);

    return Promise.resolve(fallback);
  }

  return new Promise<T>((resolve, reject) => {
    const cancel = sliderClock.setTimer(remaining, () => {
      read.catch(() => undefined);
      resolve(fallback);
    });

    read.then(
      (value) => {
        cancel();
        resolve(value);
      },
      (e) => {
        cancel();
        reject(e);
      }
    );
  });
}

// An artist's image read by its MusicBrainz id from Lidarr's metadata service
// (Poster); none where the read fails (logged).
async function readArtistImage(mbid: string): Promise<string | undefined> {
  try {
    const service = await getLidarrMetadata().getArtist(mbid);

    return metadataImage(service?.images, 'Poster');
  } catch (e) {
    logFailure(
      "Failed to read a similar artist's image from Lidarr's metadata service",
      e
    );

    return undefined;
  }
}

// The artists ListenBrainz gives as similar to an artist, the first 20, most
// similar first, each with its image read by its MusicBrainz id from Lidarr's
// metadata service (side by side); an image that cannot be read is left out,
// never the list.
export async function getSimilarArtistSummaries(
  mbid: string
): Promise<MusicArtistSummary[]> {
  const similar = await getListenBrainz().getSimilarArtists(mbid);

  return Promise.all(
    similar.slice(0, SLIDER_LIMIT).map(async (artist) => ({
      id: artist.mbid,
      name: artist.name,
      imageUrl: await readArtistImage(artist.mbid),
      inLidarr: false,
    }))
  );
}

// The deadline, in milliseconds from when the route began, of the reads of
// ListenBrainz and of getArtists, and of the images (F2-D-311).
export const LIBRARY_READ_DEADLINE = 6000;
export const LIBRARY_IMAGE_DEADLINE = 8000;
// the similar artists of this many library artists are read side by side
const LIBRARY_READ_BATCH = 6;

// Similar to Your Library: the artists ListenBrainz gives as similar to the
// artists the default Lidarr holds and Lidarr does not hold (F2-D-311). The
// library is read at each call; at most 30 of its artists, spread over it by
// pickSpread, have their similar artists read 6 at a time; getArtists and these
// reads are waited for until 6 seconds after the call began (what answered by
// then counts), the artists ranked by rankSimilarToLibrary, their images read
// side by side and waited for until 8 seconds after the call began (one not
// answered by then is none); reads still going on are left to end and fill their
// caches. No default Lidarr server, no library, or every read failing gives none;
// getArtists failing throws.
export async function getSimilarToLibrarySummaries(): Promise<
  MusicArtistSummary[]
> {
  const startedAt = sliderClock.now();
  const server = getDefaultLidarr();

  if (!server) {
    return [];
  }

  const library = await waitUntil<LidarrArtist[] | undefined>(
    buildLidarr(server).getArtists(),
    startedAt,
    LIBRARY_READ_DEADLINE,
    undefined
  );

  if (!library) {
    logger.error('Failed to read the library for Similar to Your Library', {
      label: 'Music',
      errorMessage: `Lidarr did not answer within ${LIBRARY_READ_DEADLINE / 1000} seconds`,
    });

    return [];
  }

  const libraryIds = library
    .map((artist) => artist.foreignArtistId)
    .filter((id): id is string => Boolean(id));
  const toRead = pickSpread(
    library.filter((artist) => Boolean(artist.foreignArtistId))
  );

  const answers: SimilarAnswer[] = [];
  const queue = [...toRead];
  let closed = false;

  const worker = async () => {
    for (;;) {
      const artist = queue.shift();

      // reads not yet begun are never begun once the answer stops waiting; an
      // answer that comes later is pushed too late to be ranked
      if (!artist || closed) {
        return;
      }

      try {
        const similar = await getListenBrainz().getSimilarArtists(
          artist.foreignArtistId
        );

        answers.push({ similar });
      } catch (e) {
        logFailure('Failed to read the similar artists of a library artist', e);
      }
    }
  };

  await waitUntil(
    Promise.all(
      Array.from(
        { length: Math.min(LIBRARY_READ_BATCH, toRead.length) },
        worker
      )
    ),
    startedAt,
    LIBRARY_READ_DEADLINE,
    undefined
  );
  closed = true;

  const ranked = rankSimilarToLibrary(answers, libraryIds);

  const artists = await Promise.all(
    ranked.map(
      async (artist): Promise<MusicArtistSummary> => ({
        id: artist.mbid,
        name: artist.name,
        imageUrl: await waitUntil(
          readArtistImage(artist.mbid),
          startedAt,
          LIBRARY_IMAGE_DEADLINE,
          undefined
        ),
        inLidarr: false,
      })
    )
  );

  return artists;
}
