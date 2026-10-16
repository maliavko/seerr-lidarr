import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
  MusicKind,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import notificationManager from '@server/lib/notifications';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import { MethodStubs } from '@server/test/musicRows';

// A music row whose status becomes AVAILABLE completes its own requests as a
// movie row's are, PARTIALLY_AVAILABLE none, and no notification and no movie
// or TV branch is entered for it (D-342, R-13, D-11); movie and TV completion
// and their notifications are as before (D-8).

setupTestDb();

const ARTIST_MBID = '11111111-2222-3333-4444-555555555555';
const ALBUM_MBID = '66666666-7777-8888-9999-000000000000';
const OTHER_ALBUM_MBID = '66666666-7777-8888-9999-000000000001';

const stubs = new MethodStubs();
let notifications: unknown[][];
let tmdbCalls: string[];

beforeEach(() => {
  notifications = [];
  tmdbCalls = [];
  mock.method(notificationManager, 'sendNotification', (...args: unknown[]) => {
    notifications.push(args);
  });
  // a music request is sent to Lidarr after it is approved: not under test here
  mock.method(
    MediaRequestSubscriber.prototype,
    'sendToLidarr',
    async () => undefined
  );
  for (const method of ['getMovie', 'getTvShow']) {
    stubs.stub(TheMovieDb.prototype, method, async () => {
      tmdbCalls.push(method);
      return {
        title: 'Title',
        name: 'Title',
        overview: 'Overview',
        release_date: '2020-01-01',
        poster_path: '/poster.jpg',
      };
    });
  }
});

afterEach(() => {
  mock.restoreAll();
  stubs.restore();
});

async function requester(): Promise<User> {
  return getRepository(User).findOneOrFail({ where: { id: 1 } });
}

async function saveMusicRow(
  kind: MusicKind,
  mbid: string,
  status: MediaStatus
): Promise<Media> {
  return getRepository(Media).save(
    new Media({
      mediaType: MediaType.MUSIC,
      musicBrainzId: mbid,
      musicKind: kind,
      ...(kind === MusicKind.ALBUM ? { artistMusicBrainzId: ARTIST_MBID } : {}),
      status,
      status4k: MediaStatus.UNKNOWN,
    })
  );
}

async function saveRequest(
  media: Media,
  status: MediaRequestStatus,
  type: MediaType = media.mediaType
): Promise<MediaRequest> {
  return getRepository(MediaRequest).save(
    new MediaRequest({
      type,
      status,
      media,
      requestedBy: await requester(),
      is4k: false,
    })
  );
}

async function setStatus(media: Media, status: MediaStatus): Promise<void> {
  const repository = getRepository(Media);
  const row = await repository.findOneByOrFail({ id: media.id });
  row.status = status;
  await repository.save(row);
}

async function requestStatus(
  request: MediaRequest
): Promise<MediaRequestStatus> {
  return (await getRepository(MediaRequest).findOneByOrFail({ id: request.id }))
    .status;
}

const ALL_STATUSES = [
  MediaRequestStatus.PENDING,
  MediaRequestStatus.APPROVED,
  MediaRequestStatus.FAILED,
  MediaRequestStatus.DECLINED,
  MediaRequestStatus.COMPLETED,
];

describe('MediaSubscriber completes music requests', () => {
  it('an album row becoming AVAILABLE completes its approved and failed requests, not its artist whole-artist request', async () => {
    const album = await saveMusicRow(
      MusicKind.ALBUM,
      ALBUM_MBID,
      MediaStatus.PROCESSING
    );
    const artist = await saveMusicRow(
      MusicKind.ARTIST,
      ARTIST_MBID,
      MediaStatus.PROCESSING
    );
    const approved = await saveRequest(album, MediaRequestStatus.APPROVED);
    const failed = await saveRequest(album, MediaRequestStatus.FAILED);
    const wholeArtist = await saveRequest(artist, MediaRequestStatus.APPROVED);

    await setStatus(album, MediaStatus.AVAILABLE);

    assert.strictEqual(
      await requestStatus(approved),
      MediaRequestStatus.COMPLETED
    );
    assert.strictEqual(
      await requestStatus(failed),
      MediaRequestStatus.COMPLETED
    );
    assert.strictEqual(
      await requestStatus(wholeArtist),
      MediaRequestStatus.APPROVED,
      'an album becoming available completes no whole-artist request'
    );
  });

  it('an artist row becoming AVAILABLE completes its whole-artist request, not the request of one of its albums', async () => {
    const album = await saveMusicRow(
      MusicKind.ALBUM,
      ALBUM_MBID,
      MediaStatus.PROCESSING
    );
    const artist = await saveMusicRow(
      MusicKind.ARTIST,
      ARTIST_MBID,
      MediaStatus.PROCESSING
    );
    const albumRequest = await saveRequest(album, MediaRequestStatus.APPROVED);
    const wholeArtist = await saveRequest(artist, MediaRequestStatus.APPROVED);

    await setStatus(artist, MediaStatus.AVAILABLE);

    assert.strictEqual(
      await requestStatus(wholeArtist),
      MediaRequestStatus.COMPLETED
    );
    assert.strictEqual(
      await requestStatus(albumRequest),
      MediaRequestStatus.APPROVED,
      'an artist becoming available completes no album request'
    );
  });

  it('completes the requests of an album and of another album separately', async () => {
    const album = await saveMusicRow(
      MusicKind.ALBUM,
      ALBUM_MBID,
      MediaStatus.PROCESSING
    );
    const other = await saveMusicRow(
      MusicKind.ALBUM,
      OTHER_ALBUM_MBID,
      MediaStatus.PROCESSING
    );
    const request = await saveRequest(album, MediaRequestStatus.APPROVED);
    const otherRequest = await saveRequest(other, MediaRequestStatus.APPROVED);

    await setStatus(album, MediaStatus.AVAILABLE);

    assert.strictEqual(
      await requestStatus(request),
      MediaRequestStatus.COMPLETED
    );
    assert.strictEqual(
      await requestStatus(otherRequest),
      MediaRequestStatus.APPROVED
    );
  });

  for (const from of [
    MediaStatus.UNKNOWN,
    MediaStatus.PENDING,
    MediaStatus.PROCESSING,
    MediaStatus.PARTIALLY_AVAILABLE,
  ]) {
    it(`completes an approved request whatever the row held before (${from})`, async () => {
      const artist = await saveMusicRow(MusicKind.ARTIST, ARTIST_MBID, from);
      const request = await saveRequest(artist, MediaRequestStatus.APPROVED);

      await setStatus(artist, MediaStatus.AVAILABLE);

      assert.strictEqual(
        await requestStatus(request),
        MediaRequestStatus.COMPLETED
      );
    });
  }

  it('a row becoming PARTIALLY_AVAILABLE completes no request', async () => {
    const artist = await saveMusicRow(
      MusicKind.ARTIST,
      ARTIST_MBID,
      MediaStatus.PROCESSING
    );
    const requests = [];
    for (const status of ALL_STATUSES) {
      requests.push(await saveRequest(artist, status));
    }

    await setStatus(artist, MediaStatus.PARTIALLY_AVAILABLE);

    for (const [index, request] of requests.entries()) {
      assert.strictEqual(
        await requestStatus(request),
        ALL_STATUSES[index],
        `a ${MediaRequestStatus[ALL_STATUSES[index]]} request moved`
      );
    }
  });

  it('an AVAILABLE artist whose row becomes PARTIALLY_AVAILABLE keeps its completed request completed and completes none', async () => {
    const artist = await saveMusicRow(
      MusicKind.ARTIST,
      ARTIST_MBID,
      MediaStatus.AVAILABLE
    );
    const completed = await saveRequest(artist, MediaRequestStatus.COMPLETED);
    const approved = await saveRequest(artist, MediaRequestStatus.APPROVED);

    await setStatus(artist, MediaStatus.PARTIALLY_AVAILABLE);

    assert.strictEqual(
      await requestStatus(completed),
      MediaRequestStatus.COMPLETED
    );
    assert.strictEqual(
      await requestStatus(approved),
      MediaRequestStatus.APPROVED
    );
  });

  it('a declined request stays declined', async () => {
    const album = await saveMusicRow(
      MusicKind.ALBUM,
      ALBUM_MBID,
      MediaStatus.PROCESSING
    );
    const declined = await saveRequest(album, MediaRequestStatus.DECLINED);

    await setStatus(album, MediaStatus.AVAILABLE);

    assert.strictEqual(
      await requestStatus(declined),
      MediaRequestStatus.DECLINED
    );
  });

  for (const held of [MediaStatus.PENDING, MediaStatus.PROCESSING]) {
    it(`moves every request status exactly as a movie row held ${held} becoming AVAILABLE moves it`, async () => {
      const movie = await getRepository(Media).save(
        new Media({
          mediaType: MediaType.MOVIE,
          tmdbId: 4242,
          status: held,
          status4k: MediaStatus.UNKNOWN,
        })
      );
      const album = await saveMusicRow(MusicKind.ALBUM, ALBUM_MBID, held);
      const movieRequests = [];
      const musicRequests = [];
      for (const status of ALL_STATUSES) {
        movieRequests.push(await saveRequest(movie, status));
        musicRequests.push(await saveRequest(album, status));
      }
      // saving a request moves its row on (an approved movie request makes it
      // processing): put both rows where the case holds them
      await getRepository(Media).update({ id: movie.id }, { status: held });
      await getRepository(Media).update({ id: album.id }, { status: held });

      await setStatus(movie, MediaStatus.AVAILABLE);
      await setStatus(album, MediaStatus.AVAILABLE);

      const movieResult = [];
      const musicResult = [];
      for (let i = 0; i < ALL_STATUSES.length; i++) {
        movieResult.push(await requestStatus(movieRequests[i]));
        musicResult.push(await requestStatus(musicRequests[i]));
      }
      assert.deepStrictEqual(musicResult, movieResult);
      assert.ok(
        movieResult.includes(MediaRequestStatus.COMPLETED),
        'the movie completed nothing: the case proves nothing'
      );
    });
  }

  it('sends no notification and asks TMDB nothing for a completed music request, and nothing fails', async () => {
    const album = await saveMusicRow(
      MusicKind.ALBUM,
      ALBUM_MBID,
      MediaStatus.PROCESSING
    );
    const artist = await saveMusicRow(
      MusicKind.ARTIST,
      ARTIST_MBID,
      MediaStatus.PROCESSING
    );
    const albumRequest = await saveRequest(album, MediaRequestStatus.APPROVED);
    const artistRequest = await saveRequest(
      artist,
      MediaRequestStatus.APPROVED
    );

    await setStatus(album, MediaStatus.AVAILABLE);
    await setStatus(artist, MediaStatus.AVAILABLE);

    assert.strictEqual(
      await requestStatus(albumRequest),
      MediaRequestStatus.COMPLETED
    );
    assert.strictEqual(
      await requestStatus(artistRequest),
      MediaRequestStatus.COMPLETED
    );
    assert.deepStrictEqual(notifications, []);
    assert.deepStrictEqual(tmdbCalls, []);
  });

  it('writes nothing but the request statuses: the music row keeps AVAILABLE and status4k unknown', async () => {
    const album = await saveMusicRow(
      MusicKind.ALBUM,
      ALBUM_MBID,
      MediaStatus.PROCESSING
    );
    await saveRequest(album, MediaRequestStatus.APPROVED);

    await setStatus(album, MediaStatus.AVAILABLE);

    const row = await getRepository(Media).findOneByOrFail({ id: album.id });
    assert.strictEqual(row.status, MediaStatus.AVAILABLE);
    assert.strictEqual(row.status4k, MediaStatus.UNKNOWN);
  });
});

describe('MediaSubscriber completes movie and TV requests as before', () => {
  it('a movie becoming AVAILABLE completes its approved request and notifies once', async () => {
    const movie = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 4343,
        status: MediaStatus.PROCESSING,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    const request = await saveRequest(movie, MediaRequestStatus.APPROVED);
    const declined = await saveRequest(movie, MediaRequestStatus.DECLINED);

    notifications.length = 0;
    tmdbCalls.length = 0;

    await setStatus(movie, MediaStatus.AVAILABLE);

    assert.strictEqual(
      await requestStatus(request),
      MediaRequestStatus.COMPLETED
    );
    assert.strictEqual(
      await requestStatus(declined),
      MediaRequestStatus.DECLINED
    );
    assert.strictEqual(notifications.length, 1);
    assert.deepStrictEqual(tmdbCalls, ['getMovie']);
  });

  it('a movie becoming PARTIALLY_AVAILABLE completes nothing', async () => {
    const movie = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 4344,
        status: MediaStatus.PROCESSING,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    const request = await saveRequest(movie, MediaRequestStatus.APPROVED);

    await setStatus(movie, MediaStatus.PARTIALLY_AVAILABLE);

    assert.strictEqual(
      await requestStatus(request),
      MediaRequestStatus.APPROVED
    );
  });

  it('a show whose requested season becomes AVAILABLE completes its request and notifies once', async () => {
    const show = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId: 4545,
        tvdbId: 4546,
        status: MediaStatus.PROCESSING,
        status4k: MediaStatus.UNKNOWN,
        seasons: [
          new Season({
            seasonNumber: 1,
            status: MediaStatus.PROCESSING,
            status4k: MediaStatus.UNKNOWN,
          }),
        ],
      })
    );
    const request = await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.TV,
        status: MediaRequestStatus.APPROVED,
        media: show,
        requestedBy: await requester(),
        is4k: false,
        seasons: [
          new SeasonRequest({
            seasonNumber: 1,
            status: MediaRequestStatus.APPROVED,
          }),
        ],
      })
    );

    notifications.length = 0;
    tmdbCalls.length = 0;

    const repository = getRepository(Media);
    const row = await repository.findOneOrFail({
      where: { id: show.id },
      relations: { seasons: true },
    });
    row.status = MediaStatus.AVAILABLE;
    row.seasons[0].status = MediaStatus.AVAILABLE;
    await repository.save(row);

    assert.strictEqual(
      await requestStatus(request),
      MediaRequestStatus.COMPLETED
    );
    assert.strictEqual(notifications.length, 1);
    assert.deepStrictEqual(tmdbCalls, ['getTvShow']);
  });
});
