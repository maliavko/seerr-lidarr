import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import downloadTracker from '@server/lib/downloadtracker';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import { saveMusicRows } from '@server/test/musicRows';

mock.method(MediaRequest, 'sendNotification', async () => undefined);

setupTestDb();

// A music artist row and a music album row beside movie and TV rows (D-84, D-8):
// Media's statics and load hooks neither fail on them nor change their answer
// for movies and TV.
async function saveMovieAndTv() {
  const repository = getRepository(Media);

  const movie = await repository.save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: 7001,
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.UNKNOWN,
      ratingKey: 'rating-movie',
      serviceId: 0,
      externalServiceId: 91,
      externalServiceSlug: 'movie-slug',
    })
  );
  const tv = await repository.save(
    new Media({
      mediaType: MediaType.TV,
      tmdbId: 7002,
      tvdbId: 5002,
      status: MediaStatus.PROCESSING,
      status4k: MediaStatus.UNKNOWN,
      ratingKey: 'rating-tv',
      serviceId: 0,
      externalServiceId: 92,
      externalServiceSlug: 'tv-slug',
    })
  );

  return { movie, tv };
}

function configureServers(): void {
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.PLEX;
  settings.plex.machineId = 'machine-1';
  settings.radarr = [
    {
      id: 0,
      name: 'Radarr',
      hostname: 'radarr.local',
      port: 7878,
      apiKey: 'key',
      baseUrl: '',
      useSsl: false,
      is4k: false,
      isDefault: true,
      externalUrl: '',
    } as RadarrSettings,
  ];
  settings.sonarr = [
    {
      id: 0,
      name: 'Sonarr',
      hostname: 'sonarr.local',
      port: 8989,
      apiKey: 'key',
      baseUrl: '',
      useSsl: false,
      is4k: false,
      isDefault: true,
      externalUrl: '',
    } as SonarrSettings,
  ];
}

describe('Media statics with music rows in the table', () => {
  beforeEach(() => {
    configureServers();
  });

  it('getRelatedMedia gives the movie and TV rows asked for and no music row', async () => {
    const { movie, tv } = await saveMovieAndTv();
    const items = [
      { tmdbId: 7001, mediaType: MediaType.MOVIE },
      { tmdbId: 7002, mediaType: MediaType.TV },
      { tmdbId: 7003, mediaType: MediaType.MOVIE },
    ];

    const without = (await Media.getRelatedMedia(undefined, items)).map(
      (m) => m.id
    );
    const { artist, album } = await saveMusicRows();
    const withMusic = await Media.getRelatedMedia(undefined, items);

    assert.deepStrictEqual(withMusic.map((m) => m.id).sort(), without.sort());
    assert.deepStrictEqual(withMusic.map((m) => m.id).sort(), [
      movie.id,
      tv.id,
    ]);
    assert.ok(!withMusic.some((m) => [artist.id, album.id].includes(m.id)));
    assert.ok(withMusic.every((m) => m.mediaType !== MediaType.MUSIC));
  });

  it('getRelatedMedia with an active request marks movie and TV rows only and does not fail', async () => {
    const { movie, tv } = await saveMovieAndTv();
    const { artist } = await saveMusicRows();
    const requestedBy = await getRepository(User).findOneOrFail({
      where: { id: 1 },
    });
    getSettings().main.hideRequested = true;

    try {
      await getRepository(MediaRequest).save(
        new MediaRequest({
          type: MediaType.MOVIE,
          status: MediaRequestStatus.PENDING,
          media: movie,
          requestedBy,
          is4k: false,
        })
      );

      const related = await Media.getRelatedMedia(
        requestedBy,
        [
          { tmdbId: 7001, mediaType: MediaType.MOVIE },
          { tmdbId: 7002, mediaType: MediaType.TV },
        ],
        { includeActiveRequest: true }
      );

      assert.deepStrictEqual(related.map((m) => m.id).sort(), [
        movie.id,
        tv.id,
      ]);
      assert.strictEqual(
        related.find((m) => m.id === movie.id)?.hasActiveRequest,
        true
      );
      assert.strictEqual(
        related.find((m) => m.id === tv.id)?.hasActiveRequest,
        false
      );
      assert.ok(!related.some((m) => m.id === artist.id));
    } finally {
      getSettings().main.hideRequested = false;
    }
  });

  it('getMedia finds the movie or TV row by its TMDB id and never a music row', async () => {
    const { movie, tv } = await saveMovieAndTv();
    const { artist, album } = await saveMusicRows();

    assert.strictEqual(
      (await Media.getMedia(7001, MediaType.MOVIE))?.id,
      movie.id
    );
    assert.strictEqual((await Media.getMedia(7002, MediaType.TV))?.id, tv.id);
    assert.strictEqual(await Media.getMedia(7001, MediaType.TV), undefined);
    assert.strictEqual(await Media.getMedia(7999, MediaType.MOVIE), undefined);

    for (const type of [MediaType.MOVIE, MediaType.TV, MediaType.MUSIC]) {
      const found = await Media.getMedia(0, type);
      assert.ok(
        found === undefined || ![artist.id, album.id].includes(found.id),
        `getMedia(0, ${type}) answered a music row`
      );
    }
  });
});

describe('Media load hooks on a music row', () => {
  let movieProgress: ReturnType<typeof mock.method>;
  let seriesProgress: ReturnType<typeof mock.method>;

  beforeEach(() => {
    configureServers();
    movieProgress = mock.method(downloadTracker, 'getMovieProgress', () => []);
    seriesProgress = mock.method(
      downloadTracker,
      'getSeriesProgress',
      () => []
    );
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it('give a music row no URL and no download status and ask no tracker', async () => {
    await saveMovieAndTv();
    const { artist, album } = await saveMusicRows(MediaStatus.PROCESSING);
    movieProgress.mock.resetCalls();
    seriesProgress.mock.resetCalls();

    for (const row of [artist, album]) {
      const loaded = await getRepository(Media).findOneOrFail({
        where: { id: row.id },
      });

      assert.strictEqual(loaded.mediaUrl, undefined);
      assert.strictEqual(loaded.mediaUrl4k, undefined);
      assert.strictEqual(loaded.iOSPlexUrl, undefined);
      assert.strictEqual(loaded.tautulliUrl, undefined);
      assert.strictEqual(loaded.serviceUrl, undefined);
      assert.strictEqual(loaded.serviceUrl4k, undefined);
      assert.deepStrictEqual(loaded.downloadStatus, []);
      assert.deepStrictEqual(loaded.downloadStatus4k, []);
    }

    assert.strictEqual(movieProgress.mock.callCount(), 0);
    assert.strictEqual(seriesProgress.mock.callCount(), 0);
  });

  it('give a music row carrying service fields no service URL and no download status', async () => {
    const { artist } = await saveMusicRows(MediaStatus.PROCESSING);
    // never so by D-111; the hooks stay keyed on the media type all the same
    await getRepository(Media).update(
      { id: artist.id },
      { serviceId: 0, externalServiceId: 91, externalServiceSlug: 'slug' }
    );
    movieProgress.mock.resetCalls();
    seriesProgress.mock.resetCalls();

    const loaded = await getRepository(Media).findOneOrFail({
      where: { id: artist.id },
    });

    assert.strictEqual(loaded.serviceUrl, undefined);
    assert.deepStrictEqual(loaded.downloadStatus, []);
    assert.strictEqual(movieProgress.mock.callCount(), 0);
    assert.strictEqual(seriesProgress.mock.callCount(), 0);
  });

  it('load a music row under Jellyfin as well, without a URL', async () => {
    const settings = getSettings();
    settings.main.mediaServerType = MediaServerType.JELLYFIN;
    const { artist } = await saveMusicRows();

    const loaded = await getRepository(Media).findOneOrFail({
      where: { id: artist.id },
    });

    assert.strictEqual(loaded.mediaUrl, undefined);
    assert.strictEqual(loaded.serviceUrl, undefined);
  });

  it('still give movie and TV rows their URLs and ask the tracker for them', async () => {
    const { movie, tv } = await saveMovieAndTv();
    await saveMusicRows();
    movieProgress.mock.resetCalls();
    seriesProgress.mock.resetCalls();

    const loadedMovie = await getRepository(Media).findOneOrFail({
      where: { id: movie.id },
    });
    const loadedTv = await getRepository(Media).findOneOrFail({
      where: { id: tv.id },
    });

    assert.match(loadedMovie.mediaUrl ?? '', /metadata%2Frating-movie/);
    assert.strictEqual(
      loadedMovie.serviceUrl,
      'http://radarr.local:7878/movie/movie-slug'
    );
    assert.strictEqual(
      loadedTv.serviceUrl,
      'http://sonarr.local:8989/series/tv-slug'
    );
    assert.deepStrictEqual(movieProgress.mock.calls[0].arguments, [0, 91]);
    assert.deepStrictEqual(seriesProgress.mock.calls[0].arguments, [0, 92]);
  });
});
