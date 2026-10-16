import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
  MusicKind,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import {
  DuplicateMediaRequestError,
  MediaRequest,
  RequestPermissionError,
} from '@server/entity/MediaRequest';
import type { User } from '@server/entity/User';
import type { MusicRequestBody } from '@server/interfaces/api/requestInterfaces';
import { getAlbum, getArtist, isMusicConfigured } from '@server/lib/music';
import { resolveMusicItems } from '@server/lib/musicStatus';
import { Permission } from '@server/lib/permissions';
import requestLock, {
  mediaKey,
  mediaLock,
  userKey,
} from '@server/utils/requestLock';

// The request of a music item (D-311, D-11): a media_request of type 'music' of
// the item's media row, made as a movie request is (D-301) — the request
// permission read on the requester, the auto-approval and modifiedBy on the
// caller — and without a quota, an override rule, a notification, seasons or
// 4K.

// the body is malformed, or carries a field only a movie or TV request has: 400
export class InvalidMusicRequestError extends Error {}
// the item is unknown, or there is no default Lidarr server: 404
export class MusicItemNotFoundError extends Error {}
// the covering of the item cannot be decided (D-362): 500
export class MusicCoveringUndecidedRequestError extends Error {}

const MUSICBRAINZ_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// the fields of a movie or TV request's body (MediaRequestBody) that a music
// request has no place for; is4k and ignoreQuota may be sent false
const MOVIE_ONLY_FIELDS = [
  'mediaId',
  'tvdbId',
  'seasons',
  'serverId',
  'profileId',
  'profileName',
  'rootFolder',
  'languageProfileId',
  'tags',
];
const MOVIE_ONLY_FLAGS = ['is4k', 'ignoreQuota'];

// A field a music request lacks, carried by a body: a stated InvalidMusicRequestError
function assertNoMovieOnlyField(body: Record<string, unknown>): void {
  for (const field of MOVIE_ONLY_FIELDS) {
    if (body[field] !== undefined) {
      throw new InvalidMusicRequestError(`A music request has no ${field}.`);
    }
  }

  for (const field of MOVIE_ONLY_FLAGS) {
    if (body[field] !== undefined && body[field] !== false) {
      throw new InvalidMusicRequestError(`A music request has no ${field}.`);
    }
  }
}

// The body of an edit of a music request (PUT /request/:id): mediaType 'music'
// and, of every other field, only userId, the requester; a field the request
// lacks, the item's own among them, is a stated 400 and nothing is changed.
export function parseMusicRequestEdit(raw: unknown): {
  userId?: number | null;
} {
  const body = (raw ?? {}) as Record<string, unknown>;

  if (body.mediaType !== MediaType.MUSIC) {
    throw new InvalidMusicRequestError(
      `The request is a music request: mediaType ${MediaType.MUSIC}.`
    );
  }

  assertNoMovieOnlyField(body);

  for (const field of ['musicBrainzId', 'musicKind']) {
    if (body[field] !== undefined) {
      throw new InvalidMusicRequestError(
        `The ${field} of a music request cannot be edited.`
      );
    }
  }

  return { userId: body.userId as number | null | undefined };
}

// The music body as it arrives, or a stated 400: mediaType 'music', a MusicBrainz
// id and the kind album or artist, and none of a movie or TV body's own fields.
export function parseMusicRequestBody(raw: unknown): MusicRequestBody {
  const body = (raw ?? {}) as Record<string, unknown>;

  assertNoMovieOnlyField(body);

  if (
    typeof body.musicBrainzId !== 'string' ||
    !MUSICBRAINZ_ID.test(body.musicBrainzId)
  ) {
    throw new InvalidMusicRequestError(
      'A music request needs the MusicBrainz id of the artist or album as musicBrainzId.'
    );
  }

  if (
    body.musicKind !== MusicKind.ALBUM &&
    body.musicKind !== MusicKind.ARTIST
  ) {
    throw new InvalidMusicRequestError(
      `A music request needs a musicKind of ${MusicKind.ALBUM} or ${MusicKind.ARTIST}.`
    );
  }

  return {
    mediaType: MediaType.MUSIC,
    musicBrainzId: body.musicBrainzId.toLowerCase(),
    musicKind: body.musicKind,
    userId: body.userId as number | null | undefined,
  };
}

export async function requestMusic(
  raw: unknown,
  user: User
): Promise<MediaRequest> {
  const body = parseMusicRequestBody(raw);

  // Only a caller allowed to set the request user may queue on their lock
  const lockUserId =
    body.userId && MediaRequest.canSetRequestUser(user) ? body.userId : user.id;

  return requestLock.dispatch(userKey(lockUserId), () =>
    mediaLock.dispatch(
      mediaKey(MediaType.MUSIC, `${body.musicKind}:${body.musicBrainzId}`),
      () => createMusicRequest(body, user)
    )
  );
}

async function createMusicRequest(
  body: MusicRequestBody,
  user: User
): Promise<MediaRequest> {
  const mediaRepository = getRepository(Media);
  const requestRepository = getRepository(MediaRequest);

  // the requester: the caller, or the user the body's userId names where the
  // caller may name one, as for a movie
  const requestUser = await MediaRequest.getRequestUser(user, body.userId);

  if (
    !requestUser.hasPermission([Permission.REQUEST, Permission.REQUEST_MUSIC], {
      type: 'or',
    })
  ) {
    throw new RequestPermissionError(
      'You do not have permission to make music requests.'
    );
  }

  if (!isMusicConfigured()) {
    throw new MusicItemNotFoundError('No default Lidarr server is configured.');
  }

  // the item, read through the music metadata service (D-201): a source that
  // fails throws a MusicSourceError, which the route answers 500 with its message
  let artistMusicBrainzId: string | undefined;

  if (body.musicKind === MusicKind.ALBUM) {
    const album = await getAlbum(body.musicBrainzId);

    if (!album) {
      throw new MusicItemNotFoundError('Album not found.');
    }

    artistMusicBrainzId = album.artist.id || undefined;
  } else if (!(await getArtist(body.musicBrainzId))) {
    throw new MusicItemNotFoundError('Artist not found.');
  }

  // a covered or available item is refused as a duplicate, before anything is
  // created (D-362 decides covering)
  const [resolution] = await resolveMusicItems([
    {
      mbid: body.musicBrainzId,
      kind: body.musicKind,
      artistMbid: artistMusicBrainzId,
    },
  ]);

  if (!resolution.decided) {
    throw new MusicCoveringUndecidedRequestError(
      "Unable to determine whether the album is covered by its artist's request."
    );
  }

  if (
    resolution.status === MediaStatus.AVAILABLE ||
    resolution.requests.length > 0
  ) {
    throw new DuplicateMediaRequestError(
      'Request for this media already exists.'
    );
  }

  let media = await mediaRepository.findOne({
    where: { musicBrainzId: body.musicBrainzId, musicKind: body.musicKind },
  });

  if (!media) {
    media = new Media({
      mediaType: MediaType.MUSIC,
      musicBrainzId: body.musicBrainzId,
      musicKind: body.musicKind,
      artistMusicBrainzId:
        body.musicKind === MusicKind.ALBUM
          ? (artistMusicBrainzId ?? null)
          : null,
      status: MediaStatus.PENDING,
      status4k: MediaStatus.UNKNOWN,
    });
  } else {
    if (
      media.status === MediaStatus.UNKNOWN ||
      media.status === MediaStatus.DELETED
    ) {
      media.status = MediaStatus.PENDING;
    }

    if (
      body.musicKind === MusicKind.ALBUM &&
      !media.artistMusicBrainzId &&
      artistMusicBrainzId
    ) {
      media.artistMusicBrainzId = artistMusicBrainzId;
    }
  }

  await mediaRepository.save(media);

  // an admin, or a caller with Auto-Approve, Auto-Approve Music or Manage
  // Requests, has the request approved, and is the one who modified it, as for
  // a movie
  const autoApprove = user.hasPermission(
    [
      Permission.AUTO_APPROVE,
      Permission.AUTO_APPROVE_MUSIC,
      Permission.MANAGE_REQUESTS,
    ],
    { type: 'or' }
  );

  const request = new MediaRequest({
    type: MediaType.MUSIC,
    media,
    requestedBy: requestUser,
    status: autoApprove
      ? MediaRequestStatus.APPROVED
      : MediaRequestStatus.PENDING,
    modifiedBy: autoApprove ? user : undefined,
    is4k: false,
  });

  await requestRepository.save(request);

  return request;
}
