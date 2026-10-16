import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
  MusicKind,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { getArtistAlbumIds } from '@server/lib/music';
import { In } from 'typeorm';

// The one place that decides which standing requests cover a music item and the
// status its mediaInfo carries (D-362, D-11, R-6): the music routes, the music
// results of search and the albums of an artist's page put that status in place
// of the stored one, and the request route refuses a duplicate by the same
// covering.

// A music request stands, and so covers, while it is pending, approved or
// failed; declined and completed ones cover nothing, and a deleted or cancelled
// one is gone from the table (R-6, D-11).
const STANDING = [
  MediaRequestStatus.PENDING,
  MediaRequestStatus.APPROVED,
  MediaRequestStatus.FAILED,
];

export const isStandingRequest = (request: {
  status: MediaRequestStatus;
}): boolean => STANDING.includes(request.status);

export interface MusicItem {
  // the item's MusicBrainz id: the artist's, or the album's release-group id
  mbid: string;
  kind: MusicKind;
  // an album's artist as its metadata gives it; the artist its row carries is
  // taken before it
  artistMbid?: string;
  // the album is listed on the page of an artist Lidarr does not hold
  // (artistMbid being that artist): the page's albums are then the artist's
  // albums by definition, and they are not read again. Once Lidarr holds the
  // artist the page's albums are not by definition its albums (D-362).
  listedUnderArtist?: boolean;
}

// The covering of an album that a whole-artist request of its artist stands
// for cannot be decided: the artist's albums or the saved metadata profile
// could not be read (D-362). The
// caller says so as its place requires.
export class MusicCoveringUndecidedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MusicCoveringUndecidedError';
  }
}

export interface MusicResolved {
  decided: true;
  item: MusicItem;
  // the item's media row, if it has one
  row?: Media;
  // the standing requests that cover the item
  requests: MediaRequest[];
  // the status the item's mediaInfo carries
  status: MediaStatus;
}

export interface MusicUndecided {
  decided: false;
  item: MusicItem;
  row?: Media;
}

export type MusicResolution = MusicResolved | MusicUndecided;

const keyOf = (kind: MusicKind, mbid: string): string => `${kind}:${mbid}`;

// R-6's status, the first that holds, from the status the item's row records
// and the standing requests that cover it. An album is available as its row
// records it (only the Lidarr scan sets that, D-371), an artist available or
// partially available; then pending where a covering request is pending,
// processing where one is approved or failed, else unknown. A row's stored
// pending or processing, which the request flow sets as a movie's, is never
// what music shows.
export function musicStatusOf(
  kind: MusicKind,
  rowStatus: MediaStatus | undefined,
  covering: { status: MediaRequestStatus }[]
): MediaStatus {
  if (rowStatus === MediaStatus.AVAILABLE) {
    return MediaStatus.AVAILABLE;
  }

  if (
    kind === MusicKind.ARTIST &&
    rowStatus === MediaStatus.PARTIALLY_AVAILABLE
  ) {
    return MediaStatus.PARTIALLY_AVAILABLE;
  }

  const standing = covering.filter(isStandingRequest);

  if (standing.some((r) => r.status === MediaRequestStatus.PENDING)) {
    return MediaStatus.PENDING;
  }

  return standing.length > 0 ? MediaStatus.PROCESSING : MediaStatus.UNKNOWN;
}

// The covering and the status of music items, read in as few queries as the
// items allow: one for their rows, one for the standing requests of them and of
// the artists of the albums, and the albums of an artist read once, and only
// where a whole-artist request of it stands and an album is not listed under
// it already (so an album with no standing artist request asks no metadata).
// An album whose artist's albums or saved metadata profile cannot be read,
// where a whole-artist request of the artist stands, is undecided; nothing else
// fails for it.
export async function resolveMusicItems(
  items: MusicItem[]
): Promise<MusicResolution[]> {
  if (items.length === 0) {
    return [];
  }

  const rowIds = [...new Set(items.map((item) => item.mbid))];
  const rows = new Map<string, Media>();

  for (const row of await getRepository(Media).find({
    where: { musicBrainzId: In(rowIds) },
  })) {
    if (row.musicBrainzId && row.musicKind) {
      rows.set(keyOf(row.musicKind, row.musicBrainzId), row);
    }
  }

  const artistOf = (item: MusicItem): string | undefined =>
    item.kind === MusicKind.ALBUM
      ? rows.get(keyOf(item.kind, item.mbid))?.artistMusicBrainzId ||
        item.artistMbid ||
        undefined
      : undefined;

  const requestIds = [
    ...new Set([...rowIds, ...items.flatMap((item) => artistOf(item) ?? [])]),
  ];
  const standing = new Map<string, MediaRequest[]>();

  for (const request of await getRepository(MediaRequest)
    .createQueryBuilder('request')
    .innerJoinAndSelect('request.media', 'media')
    .where('request.type = :type', { type: MediaType.MUSIC })
    .andWhere('request.status IN (:...standing)', { standing: STANDING })
    .andWhere('media.musicBrainzId IN (:...requestIds)', { requestIds })
    .getMany()) {
    const { musicBrainzId, musicKind } = request.media;

    if (musicBrainzId && musicKind) {
      const key = keyOf(musicKind, musicBrainzId);

      standing.set(key, [...(standing.get(key) ?? []), request]);
    }
  }

  const artistAlbums = new Map<string, Promise<Set<string> | Error>>();

  for (const item of items) {
    const artist = artistOf(item);

    if (
      artist &&
      !(item.listedUnderArtist && artist === item.artistMbid) &&
      standing.has(keyOf(MusicKind.ARTIST, artist)) &&
      !artistAlbums.has(artist)
    ) {
      artistAlbums.set(
        artist,
        getArtistAlbumIds(artist).then(
          (ids) => new Set(ids),
          (e: Error) => e
        )
      );
    }
  }

  return Promise.all(
    items.map(async (item): Promise<MusicResolution> => {
      const row = rows.get(keyOf(item.kind, item.mbid));
      const covering = [...(standing.get(keyOf(item.kind, item.mbid)) ?? [])];
      const artist = artistOf(item);
      const artistRequests = artist
        ? (standing.get(keyOf(MusicKind.ARTIST, artist)) ?? [])
        : [];

      if (artistRequests.length > 0) {
        if (item.listedUnderArtist && artist === item.artistMbid) {
          covering.push(...artistRequests);
        } else if (artist) {
          const albums = await artistAlbums.get(artist);

          if (albums instanceof Error || albums === undefined) {
            return { decided: false, item, row };
          }

          if (albums.has(item.mbid)) {
            covering.push(...artistRequests);
          }
        }
      }

      return {
        decided: true,
        item,
        row,
        requests: covering,
        status: musicStatusOf(item.kind, row?.status, covering),
      };
    })
  );
}

async function resolveOne(item: MusicItem): Promise<MusicResolved> {
  const [resolution] = await resolveMusicItems([item]);

  if (!resolution.decided) {
    throw new MusicCoveringUndecidedError(
      'Whether the album is covered by its artist’s request cannot be decided: the artist’s albums or the saved metadata profile could not be read.'
    );
  }

  return resolution;
}

// The standing requests that cover a music item: its own and, for an album, its
// artist's whole-artist requests where the album is among the artist's albums
// (D-362): once Lidarr holds the artist, the albums the music metadata service
// lists for it that fall under the saved metadata profile, else the albums it
// lists for its page. Throws MusicCoveringUndecidedError where a whole-artist
// request of the album's artist stands and the artist's albums or the saved
// metadata profile cannot be read.
export async function getCoveringRequests(
  item: MusicItem
): Promise<MediaRequest[]> {
  return (await resolveOne(item)).requests;
}

// The status a music item's mediaInfo carries (R-6); it throws as
// getCoveringRequests does.
export async function getMusicStatus(item: MusicItem): Promise<MediaStatus> {
  return (await resolveOne(item)).status;
}

// The mediaInfo a music item answers: its row, as the caller read it, with the
// computed status in place of the stored one; where it has no row, one carrying
// the status only if a covering request gives it one other than unknown, and
// none otherwise. mediaInfo.requests stays the row's own requests.
export function musicMediaInfo(
  resolved: MusicResolved,
  media?: Media
): Media | undefined {
  if (media) {
    return new Media({ ...media, status: resolved.status });
  }

  if (resolved.status === MediaStatus.UNKNOWN) {
    return undefined;
  }

  const { item } = resolved;

  return new Media({
    mediaType: MediaType.MUSIC,
    musicBrainzId: item.mbid,
    musicKind: item.kind,
    artistMusicBrainzId:
      item.kind === MusicKind.ALBUM ? (item.artistMbid ?? null) : null,
    status: resolved.status,
    status4k: MediaStatus.UNKNOWN,
    requests: [],
  });
}

// The requests of a list with the media of each music request carrying the
// status D-362 gives it, in place of the stored one: the status the covering
// requests give the item, and, where an album's covering is undecided (its
// artist's albums or the saved metadata profile cannot be read), the one its
// own requests give, so that the rest of the list stands (D-362). Movie and TV requests are returned as they
// are. A list with no music request asks nothing.
export async function requestsWithMusicStatus(
  requests: MediaRequest[]
): Promise<MediaRequest[]> {
  const music = requests.filter(
    (request) =>
      request.type === MediaType.MUSIC &&
      request.media?.musicBrainzId &&
      request.media.musicKind
  );

  if (music.length === 0) {
    return requests;
  }

  const resolutions = await resolveMusicItems(
    music.map((request) => ({
      mbid: request.media.musicBrainzId as string,
      kind: request.media.musicKind as MusicKind,
      artistMbid: request.media.artistMusicBrainzId ?? undefined,
    }))
  );

  // the standing requests of the rows whose covering is undecided
  const undecidedRowIds = resolutions.flatMap((resolution) =>
    resolution.decided || !resolution.row ? [] : [resolution.row.id]
  );
  const own =
    undecidedRowIds.length > 0
      ? await getRepository(MediaRequest).find({
          where: { media: { id: In(undecidedRowIds) }, status: In(STANDING) },
          relations: { media: true },
        })
      : [];

  music.forEach((request, index) => {
    const resolution = resolutions[index];
    const status = resolution.decided
      ? resolution.status
      : musicStatusOf(
          resolution.item.kind,
          request.media.status,
          own.filter((r) => r.media.id === request.media.id)
        );

    request.media = new Media({ ...request.media, status });
  });

  return requests;
}
