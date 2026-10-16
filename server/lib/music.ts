import type { LidarrMetadataImage } from '@server/api/lidarrmetadata';
import { getLidarrMetadata } from '@server/api/lidarrmetadata';
import type {
  MusicBrainzRelease,
  MusicBrainzReleaseGroup,
} from '@server/api/musicbrainz';
import { getMusicBrainz } from '@server/api/musicbrainz';
import type {
  LidarrAlbum,
  LidarrArtist,
  LidarrImage,
  LidarrTrack,
} from '@server/api/servarr/lidarr';
import LidarrAPI from '@server/api/servarr/lidarr';
import cacheManager from '@server/lib/cache';
import { albumInProfile } from '@server/lib/musicProfile';
import type { LidarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

// Every call to an outside source gives up after ten seconds (D-201).
const REQUEST_TIMEOUT = 10000;

// Lidarr's lookups are kept 6 hours, its own records of what it holds 5
// minutes, in seconds.
const LOOKUP_TTL = 21600;
const HELD_TTL = 300;

// Search shows the first ten artists and the first ten albums.
const SEARCH_LIMIT = 10;

export interface MusicArtistSummary {
  // the MusicBrainz id
  id: string;
  name: string;
  disambiguation?: string;
  artistType?: string;
  overview?: string;
  imageUrl?: string;
  inLidarr: boolean;
}

export interface MusicAlbumSummary {
  // the MusicBrainz release-group id
  id: string;
  title: string;
  disambiguation?: string;
  artist?: { id: string; name: string };
  releaseDate?: string;
  albumType?: string;
  secondaryTypes: string[];
  coverUrl?: string;
  inLidarr: boolean;
}

export interface MusicSearchResults {
  artists: MusicArtistSummary[];
  albums: MusicAlbumSummary[];
}

export interface MusicArtist extends MusicArtistSummary {
  backdropUrl?: string;
  genres: string[];
  albums: MusicAlbumSummary[];
}

export interface MusicTrack {
  disc: number;
  position: number;
  // the number as the source gives it
  number: string;
  title: string;
  // milliseconds, where known
  length?: number;
}

export interface MusicAlbum extends MusicAlbumSummary {
  artist: { id: string; name: string };
  overview?: string;
  genres: string[];
  tracks: MusicTrack[];
}

// An artist or album whose own metadata cannot be read: the stated error.
export class MusicSourceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MusicSourceError';
  }
}

export const getDefaultLidarr = (): LidarrSettings | undefined =>
  getSettings().lidarr.find((server) => server.isDefault);

// With no default Lidarr server there is no music anywhere (D-181, D-4).
export const isMusicConfigured = (): boolean =>
  getDefaultLidarr() !== undefined;

const buildLidarr = (server: LidarrSettings): LidarrAPI =>
  new LidarrAPI({
    url: LidarrAPI.buildUrl(server, '/api/v1'),
    apiKey: server.apiKey,
    timeout: REQUEST_TIMEOUT,
  });

const cacheKey = (server: LidarrSettings, ...parts: string[]): string =>
  [LidarrAPI.buildUrl(server, '/api/v1'), 'music', ...parts].join(':');

// A cached answer, or the one the load makes and keeps for ttl seconds. An
// answer of null, a thing not found, is not kept.
async function cached<T>(
  key: string,
  ttl: number,
  load: () => Promise<T>
): Promise<T> {
  const cache = cacheManager.getCache('lidarr').data;
  const hit = cache.get<T>(key);

  if (hit !== undefined) {
    return hit;
  }

  const value = await load();

  if (value !== null) {
    cache.set(key, value, ttl);
  }

  return value;
}

const logFailure = (message: string, e: Error): void => {
  logger.error(message, { label: 'Music', errorMessage: e.message });
};

// An image is passed to the client as a URL: what Lidarr keeps of a held
// artist is a path on its own disk, which is none.
const isUrl = (value?: string): value is string =>
  value !== undefined && /^https?:\/\//i.test(value);

const coverArtArchiveUrl = (releaseGroupMbid: string): string =>
  `https://coverartarchive.org/release-group/${releaseGroupMbid}/front-250`;

function artistImage(images: LidarrImage[] = []): string | undefined {
  const poster = images.find((image) => image.coverType === 'poster');
  const first = images[0];

  if (isUrl(poster?.remoteUrl)) {
    return poster?.remoteUrl;
  }

  return isUrl(first?.remoteUrl) ? first.remoteUrl : undefined;
}

function artistBackdrop(images: LidarrImage[] = []): string | undefined {
  const fanart = images.find((image) => image.coverType === 'fanart');

  return isUrl(fanart?.remoteUrl) ? fanart.remoteUrl : undefined;
}

// What Lidarr's metadata service gives of an artist, by its CoverType and only
// as an http(s) URL.
function metadataImage(
  images: LidarrMetadataImage[] = [],
  coverType: 'Poster' | 'Fanart'
): string | undefined {
  const url = images.find((image) => image.CoverType === coverType)?.Url;

  return isUrl(url) ? url : undefined;
}

function albumCover(album: LidarrAlbum): string {
  const cover = (album.images ?? []).find(
    (image) => image.coverType === 'cover'
  );

  if (isUrl(cover?.remoteUrl)) {
    return cover.remoteUrl;
  }

  return isUrl(album.remoteCover)
    ? album.remoteCover
    : coverArtArchiveUrl(album.foreignAlbumId);
}

const nonEmpty = (value?: string): string | undefined =>
  value ? value : undefined;

const toArtistSummary = (artist: LidarrArtist): MusicArtistSummary => ({
  id: artist.foreignArtistId,
  name: artist.artistName,
  disambiguation: nonEmpty(artist.disambiguation),
  artistType: nonEmpty(artist.artistType),
  overview: nonEmpty(artist.overview),
  imageUrl: artistImage(artist.images),
  inLidarr: Boolean(artist.id),
});

const toAlbumSummary = (album: LidarrAlbum): MusicAlbumSummary => ({
  id: album.foreignAlbumId,
  title: album.title,
  disambiguation: nonEmpty(album.disambiguation),
  artist: album.artist
    ? { id: album.artist.foreignArtistId, name: album.artist.artistName }
    : undefined,
  releaseDate: nonEmpty(album.releaseDate),
  albumType: nonEmpty(album.albumType),
  secondaryTypes: album.secondaryTypes ?? [],
  coverUrl: albumCover(album),
  inLidarr: Boolean(album.id),
});

const toMusicBrainzAlbum = (
  group: MusicBrainzReleaseGroup
): MusicAlbumSummary => ({
  id: group.id,
  title: group.title,
  releaseDate: nonEmpty(group['first-release-date']),
  albumType: group['primary-type'] ?? undefined,
  secondaryTypes: group['secondary-types'] ?? [],
  coverUrl: coverArtArchiveUrl(group.id),
  inLidarr: false,
});

const fromLidarrTracks = (tracks: LidarrTrack[]): MusicTrack[] =>
  [...tracks]
    .sort(
      (a, b) =>
        a.mediumNumber - b.mediumNumber ||
        a.absoluteTrackNumber - b.absoluteTrackNumber
    )
    .map((track) => ({
      disc: track.mediumNumber,
      position: track.absoluteTrackNumber,
      number: track.trackNumber,
      title: track.title,
      length: track.duration > 0 ? track.duration : undefined,
    }));

const fromMusicBrainzRelease = (release: MusicBrainzRelease): MusicTrack[] =>
  (release.media ?? []).flatMap((medium) =>
    (medium.tracks ?? []).map((track) => ({
      disc: medium.position,
      position: track.position,
      number: track.number,
      title: track.title,
      length: track.length ?? undefined,
    }))
  );

// A held artist of a search result (its lookup entry carries Lidarr's id) whose
// entry gives no http(s) image URL or no overview takes the one it lacks from
// Lidarr's metadata service for the same MusicBrainz id, never from a lookup by
// id (D-201). The service failing, timing out or not knowing the id leaves the
// summary as the lookup gave it.
async function withMetadataService(
  entry: LidarrArtist,
  summary: MusicArtistSummary
): Promise<MusicArtistSummary> {
  if (!entry.id || (summary.imageUrl && summary.overview)) {
    return summary;
  }

  try {
    const service = await getLidarrMetadata().getArtist(entry.foreignArtistId);

    return {
      ...summary,
      imageUrl: summary.imageUrl ?? metadataImage(service?.images, 'Poster'),
      overview: summary.overview ?? nonEmpty(service?.overview),
    };
  } catch (e) {
    logFailure(
      "Failed to read an artist Lidarr holds from Lidarr's metadata service",
      e
    );

    return summary;
  }
}

// Search (R-3): the first ten artists and the first ten albums of Lidarr's
// lookup, in Lidarr's order. One lookup failing leaves the other's results,
// both failing or no default Lidarr server give no music. The held artists
// missing an image or an overview are asked of Lidarr's metadata service side
// by side, each once.
export async function searchMusic(term: string): Promise<MusicSearchResults> {
  const server = getDefaultLidarr();

  if (!server) {
    return { artists: [], albums: [] };
  }

  const lidarr = buildLidarr(server);
  const [artists, albums] = await Promise.allSettled([
    cached(cacheKey(server, 'search', 'artist', term), LOOKUP_TTL, () =>
      lidarr.lookupArtists(term)
    ),
    cached(cacheKey(server, 'search', 'album', term), LOOKUP_TTL, () =>
      lidarr.lookupAlbums(term)
    ),
  ]);

  if (artists.status === 'rejected') {
    logFailure('Failed to search artists in Lidarr', artists.reason);
  }
  if (albums.status === 'rejected') {
    logFailure('Failed to search albums in Lidarr', albums.reason);
  }

  return {
    artists:
      artists.status === 'fulfilled'
        ? await Promise.all(
            artists.value
              .slice(0, SEARCH_LIMIT)
              .map((entry) =>
                withMetadataService(entry, toArtistSummary(entry))
              )
          )
        : [],
    albums:
      albums.status === 'fulfilled'
        ? albums.value.slice(0, SEARCH_LIMIT).map(toAlbumSummary)
        : [],
  };
}

// The artists Lidarr holds, read through the cache; a failure throws.
async function listHeldArtists(
  server: LidarrSettings,
  lidarr: LidarrAPI
): Promise<LidarrArtist[]> {
  return cached(cacheKey(server, 'artists'), HELD_TTL, () =>
    lidarr.getArtists()
  );
}

// The artist Lidarr holds under a MusicBrainz id, if it does; Lidarr failing to
// list its artists is logged and is no held artist.
async function findHeldArtist(
  server: LidarrSettings,
  lidarr: LidarrAPI,
  mbid: string
): Promise<LidarrArtist | undefined> {
  try {
    const artists = await listHeldArtists(server, lidarr);

    return artists.find((artist) => artist.foreignArtistId === mbid);
  } catch (e) {
    logFailure('Failed to read the artists Lidarr holds', e);

    return undefined;
  }
}

// The albums of an artist as the service lists them (D-201): Lidarr's where it
// holds the artist, else MusicBrainz's release groups. A source failing throws,
// so that an empty list is told from a list that could not be read.
async function readArtistAlbums(
  server: LidarrSettings,
  lidarr: LidarrAPI,
  held: LidarrArtist | undefined,
  mbid: string
): Promise<MusicAlbumSummary[]> {
  if (held?.id) {
    const artistId = held.id;
    const heldAlbums = await cached(
      cacheKey(server, 'albums', String(artistId)),
      HELD_TTL,
      () => lidarr.getAlbums({ artistId })
    );

    return heldAlbums.map(toAlbumSummary);
  }

  return (await getMusicBrainz().getArtistAlbums(mbid)).map(toMusicBrainzAlbum);
}

// The MusicBrainz ids of the albums a whole-artist request of an artist covers,
// the covering of an album being decided against them (D-362, R-6): where Lidarr
// holds the artist, the albums the service lists for it (getAlbums({artistId}),
// which Lidarr keeps under the artist's own metadata profile) that fall under
// the default server's saved metadata profile, by the one test the send and the
// scan make (albumInProfile), the saved profile read through LidarrAPI in the
// 'lidarr' cache as Lidarr's records are; where Lidarr does not hold it, the
// albums the service lists for its page. A MusicSourceError where they cannot
// be read (the albums failing, the profiles failing or lacking the saved one),
// and where there is no default Lidarr server, there being no music then.
export async function getArtistAlbumIds(mbid: string): Promise<string[]> {
  const server = getDefaultLidarr();

  if (!server) {
    throw new MusicSourceError('Music is not configured.');
  }

  const lidarr = buildLidarr(server);

  try {
    // Whether Lidarr holds the artist decides whose list the albums are (Lidarr's
    // or MusicBrainz's): Lidarr failing to list its artists leaves that, and so
    // the albums, unread, never guessed from MusicBrainz's list (F-1111).
    const held = (await listHeldArtists(server, lidarr)).find(
      (artist) => artist.foreignArtistId === mbid
    );

    if (held?.id) {
      const artistId = held.id;
      const [heldAlbums, profile] = await Promise.all([
        cached(cacheKey(server, 'albums', String(artistId)), HELD_TTL, () =>
          lidarr.getAlbums({ artistId })
        ),
        cached(
          cacheKey(
            server,
            'metadataprofile',
            String(server.activeMetadataProfileId)
          ),
          HELD_TTL,
          () => lidarr.getMetadataProfile(server.activeMetadataProfileId)
        ),
      ]);

      return heldAlbums
        .filter((album) => albumInProfile(album, profile))
        .map((album) => album.foreignAlbumId);
    }

    return (await getMusicBrainz().getArtistAlbums(mbid)).map(
      (album) => album.id
    );
  } catch (e) {
    logFailure('Failed to read the albums of an artist', e);
    throw new MusicSourceError(`Failed to read the albums: ${e.message}`, {
      cause: e,
    });
  }
}

// An artist (R-4) by its MusicBrainz id: null where there is no default
// Lidarr server or no answer for the id; a MusicSourceError where its own
// metadata cannot be read.
export async function getArtist(mbid: string): Promise<MusicArtist | null> {
  const server = getDefaultLidarr();

  if (!server) {
    return null;
  }

  const lidarr = buildLidarr(server);
  const held = await findHeldArtist(server, lidarr, mbid);

  let artist: LidarrArtist | null;

  if (held) {
    artist = held;
  } else {
    try {
      artist = await cached(cacheKey(server, 'artist', mbid), LOOKUP_TTL, () =>
        lidarr.lookupArtistByMbid(mbid)
      );
    } catch (e) {
      logFailure('Failed to look an artist up in Lidarr', e);
      throw new MusicSourceError(`Failed to read the artist: ${e.message}`, {
        cause: e,
      });
    }
  }

  if (!artist) {
    return null;
  }

  let albums: MusicAlbumSummary[] = [];

  try {
    albums = await readArtistAlbums(server, lidarr, held, mbid);
  } catch (e) {
    logFailure('Failed to read the albums of an artist', e);
  }

  let imageUrl = artistImage(artist.images);
  let backdropUrl = artistBackdrop(artist.images);
  let overview = nonEmpty(artist.overview);

  // Lidarr gives a held artist's images as paths on its own disk and, once it
  // holds the artist, its lookup answers that record too: each of the three the
  // record does not give comes from Lidarr's metadata service for the same
  // MusicBrainz id, asked only where one is missing, never from the lookup
  // (D-201). It failing, timing out or not knowing the id leaves them out.
  if (held && (!imageUrl || !backdropUrl || !overview)) {
    try {
      const service = await getLidarrMetadata().getArtist(mbid);

      imageUrl ??= metadataImage(service?.images, 'Poster');
      backdropUrl ??= metadataImage(service?.images, 'Fanart');
      overview ??= nonEmpty(service?.overview);
    } catch (e) {
      logFailure(
        "Failed to read an artist Lidarr holds from Lidarr's metadata service",
        e
      );
    }
  }

  return {
    ...toArtistSummary(artist),
    // an artist found by its id is shown by that id
    id: mbid,
    imageUrl,
    overview,
    backdropUrl,
    genres: artist.genres ?? [],
    albums,
  };
}

// The release whose tracks an album shows when Lidarr does not hold it: the
// one Lidarr's lookup marks monitored, else its first Official one, else its
// first (D-201).
function pickRelease(album: LidarrAlbum): string | undefined {
  const releases = album.releases ?? [];

  return (
    releases.find((release) => release.monitored) ??
    releases.find((release) => release.status === 'Official') ??
    releases[0]
  )?.foreignReleaseId;
}

// An album (R-5) by its release-group id, answered as getArtist answers.
export async function getAlbum(mbid: string): Promise<MusicAlbum | null> {
  const server = getDefaultLidarr();

  if (!server) {
    return null;
  }

  const lidarr = buildLidarr(server);

  let album: LidarrAlbum | null;

  try {
    album = await cached(cacheKey(server, 'album', mbid), LOOKUP_TTL, () =>
      lidarr.lookupAlbumByMbid(mbid)
    );
  } catch (e) {
    logFailure('Failed to look an album up in Lidarr', e);
    throw new MusicSourceError(`Failed to read the album: ${e.message}`, {
      cause: e,
    });
  }

  if (!album) {
    return null;
  }

  let tracks: MusicTrack[] = [];

  if (album.id) {
    const albumId = album.id;

    try {
      const heldTracks = await cached(
        cacheKey(server, 'tracks', String(albumId)),
        HELD_TTL,
        () => lidarr.getTracks(albumId)
      );

      tracks = fromLidarrTracks(heldTracks);
    } catch (e) {
      logFailure('Failed to read the tracks of an album Lidarr holds', e);
    }
  } else {
    const releaseId = pickRelease(album);

    if (releaseId) {
      try {
        tracks = fromMusicBrainzRelease(
          await getMusicBrainz().getRelease(releaseId)
        );
      } catch (e) {
        logFailure('Failed to read the tracks of an album from MusicBrainz', e);
      }
    }
  }

  const summary = toAlbumSummary(album);

  return {
    ...summary,
    id: mbid,
    artist: summary.artist ?? { id: '', name: '' },
    overview: nonEmpty(album.overview),
    genres: album.genres ?? [],
    tracks,
  };
}
