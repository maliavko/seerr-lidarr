import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it } from 'node:test';

import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TautulliAPI from '@server/api/tautulli';
import TheMovieDb from '@server/api/themoviedb';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import type { RadarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import {
  MethodStubs,
  assertRowsUnchanged,
  createRoutesApp,
  loginAs,
  rawMediaRows,
  saveMusicRows,
} from '@server/test/musicRows';
import type { Express } from 'express';
import mediaRoutes from './media';

let app: Express;

before(() => {
  app = createRoutesApp({ '/media': mediaRoutes });
});

setupTestDb();

// calls to outside services a music row must never cause (D-84)
const stubs = new MethodStubs();
let outside: { name: string; calls: unknown[][] }[] = [];

beforeEach(() => {
  outside = [
    {
      name: 'RadarrAPI.removeMovie',
      ...stubs.stub(RadarrAPI.prototype, 'removeMovie'),
    },
    {
      name: 'SonarrAPI.removeSeries',
      ...stubs.stub(SonarrAPI.prototype, 'removeSeries'),
    },
    {
      name: 'TheMovieDb.getTvShow',
      ...stubs.stub(TheMovieDb.prototype, 'getTvShow', async () => {
        throw new Error('TMDB must not be asked');
      }),
    },
    {
      name: 'TautulliAPI.getMediaWatchStats',
      ...stubs.stub(
        TautulliAPI.prototype,
        'getMediaWatchStats',
        async () => []
      ),
    },
    {
      name: 'TautulliAPI.getMediaWatchUsers',
      ...stubs.stub(
        TautulliAPI.prototype,
        'getMediaWatchUsers',
        async () => []
      ),
    },
  ];
});

afterEach(() => {
  stubs.restore();
});

function assertNoOutsideCall() {
  for (const { name, calls } of outside) {
    assert.strictEqual(calls.length, 0, `${name} was called`);
  }
}

async function saveMovieAndTv() {
  const repository = getRepository(Media);

  const movie = await repository.save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: 8001,
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.UNKNOWN,
      mediaAddedAt: new Date('2024-01-01T00:00:00Z'),
    })
  );
  const tv = await repository.save(
    new Media({
      mediaType: MediaType.TV,
      tmdbId: 8002,
      tvdbId: 6002,
      status: MediaStatus.PARTIALLY_AVAILABLE,
      status4k: MediaStatus.UNKNOWN,
      mediaAddedAt: new Date('2024-01-03T00:00:00Z'),
    })
  );
  const pendingMovie = await repository.save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: 8003,
      status: MediaStatus.PENDING,
      status4k: MediaStatus.UNKNOWN,
    })
  );

  return { movie, tv, pendingMovie };
}

const LISTS = [
  '/media',
  '/media?filter=available',
  '/media?filter=allavailable',
  '/media?filter=partial',
  '/media?filter=pending',
  '/media?filter=processing',
  '/media?sort=mediaAdded',
  '/media?sort=modified&take=2&skip=1',
];

describe('GET /media with music rows in the table', () => {
  for (const url of LISTS) {
    it(`${url} answers what it answers without them and lists no music row`, async () => {
      const { movie, tv, pendingMovie } = await saveMovieAndTv();
      const agent = await loginAs(app);

      const without = await agent.get(url);
      assert.strictEqual(without.status, 200);

      const { artist, album } = await saveMusicRows(
        url.includes('processing')
          ? MediaStatus.PROCESSING
          : url.includes('pending')
            ? MediaStatus.PENDING
            : url.includes('partial')
              ? MediaStatus.PARTIALLY_AVAILABLE
              : MediaStatus.AVAILABLE
      );
      const withMusic = await agent.get(url);

      assert.strictEqual(withMusic.status, 200);
      assert.deepStrictEqual(withMusic.body, without.body);
      const ids = (withMusic.body.results as Media[]).map((m) => m.id);
      assert.ok(!ids.includes(artist.id) && !ids.includes(album.id));
      assert.ok(
        ids.every((id) => [movie.id, tv.id, pendingMovie.id].includes(id))
      );
    });
  }

  it('counts only movie and TV rows in pageInfo', async () => {
    await saveMovieAndTv();
    await saveMusicRows();
    const agent = await loginAs(app);

    const res = await agent.get('/media?take=2');

    assert.strictEqual(res.body.pageInfo.results, 3);
    assert.strictEqual(res.body.pageInfo.pages, 2);
    assert.strictEqual(res.body.results.length, 2);
  });
});

describe('GET /media lists exactly the movie and TV rows each filter asks for', () => {
  const expectations: {
    url: string;
    music: MediaStatus;
    rows: ('movie' | 'tv' | 'pendingMovie')[];
  }[] = [
    {
      url: '/media?filter=pending',
      music: MediaStatus.PENDING,
      rows: ['pendingMovie'],
    },
    {
      url: '/media?filter=available',
      music: MediaStatus.AVAILABLE,
      rows: ['movie'],
    },
    {
      url: '/media?filter=partial',
      music: MediaStatus.PARTIALLY_AVAILABLE,
      rows: ['tv'],
    },
    {
      url: '/media?filter=allavailable',
      music: MediaStatus.AVAILABLE,
      rows: ['tv', 'movie'],
    },
    {
      url: '/media?filter=processing',
      music: MediaStatus.PROCESSING,
      rows: [],
    },
    {
      url: '/media?sort=mediaAdded',
      music: MediaStatus.AVAILABLE,
      rows: ['tv', 'movie'],
    },
    {
      url: '/media',
      music: MediaStatus.AVAILABLE,
      rows: ['pendingMovie', 'tv', 'movie'],
    },
  ];

  for (const { url, music, rows } of expectations) {
    it(`${url} lists ${rows.length ? rows.join(', ') : 'nothing'}, a music row of the status it asks for present`, async () => {
      const saved = await saveMovieAndTv();
      // the column defaults to now; this row was never added to a library
      await getRepository(Media).update(
        { id: saved.pendingMovie.id },
        { mediaAddedAt: null as unknown as Date }
      );
      const agent = await loginAs(app);
      await saveMusicRows(music);

      const res = await agent.get(url);

      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(
        (res.body.results as Media[]).map((m) => m.id),
        rows.map((name) => saved[name].id)
      );
      assert.strictEqual(res.body.pageInfo.results, rows.length);
    });
  }
});

describe('POST and DELETE /media/:id on a music row', () => {
  it('POST /media/:id/:status changes the music row only and calls no outside service', async () => {
    const { movie } = await saveMovieAndTv();
    const { artist } = await saveMusicRows(MediaStatus.UNKNOWN);
    const agent = await loginAs(app);
    const movieBefore = await rawMediaRows([movie.id]);

    const res = await agent.post(`/media/${artist.id}/available`).send({});

    assert.strictEqual(res.status, 200);
    assert.strictEqual(
      (await getRepository(Media).findOneByOrFail({ id: artist.id })).status,
      MediaStatus.AVAILABLE
    );
    assert.deepStrictEqual(await rawMediaRows([movie.id]), movieBefore);
    assertNoOutsideCall();
  });

  it('POST /media/:id/:status still moves a movie as before', async () => {
    const { movie } = await saveMovieAndTv();
    await saveMusicRows();
    const agent = await loginAs(app);

    const res = await agent.post(`/media/${movie.id}/processing`).send({});

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, MediaStatus.PROCESSING);

    const partial = await agent.post(`/media/${movie.id}/partial`).send({});
    assert.strictEqual(partial.status, 400);
  });

  it('DELETE /media/:id removes the music row alone and calls no outside service', async () => {
    const { movie, tv, pendingMovie } = await saveMovieAndTv();
    const { artist, album } = await saveMusicRows();
    const agent = await loginAs(app);

    const res = await agent.delete(`/media/${artist.id}`);

    assert.strictEqual(res.status, 204);
    assert.strictEqual(
      await getRepository(Media).findOneBy({ id: artist.id }),
      null
    );
    assert.notStrictEqual(
      await getRepository(Media).findOneBy({ id: album.id }),
      null
    );
    assert.strictEqual(await getRepository(Media).count(), 4);
    assert.deepStrictEqual(
      (await getRepository(Media).find({ order: { id: 'ASC' } }))
        .filter((m) => m.mediaType !== MediaType.MUSIC)
        .map((m) => m.id),
      [movie.id, tv.id, pendingMovie.id]
    );
    assertNoOutsideCall();
  });

  it('DELETE /media/:id still removes a movie row', async () => {
    const { movie } = await saveMovieAndTv();
    const { artist, album } = await saveMusicRows();
    const agent = await loginAs(app);
    const before = await rawMediaRows([artist.id, album.id]);

    const res = await agent.delete(`/media/${movie.id}`);

    assert.strictEqual(res.status, 204);
    assert.strictEqual(
      await getRepository(Media).findOneBy({ id: movie.id }),
      null
    );
    await assertRowsUnchanged([artist, album], before);
  });
});

describe('DELETE /media/:id/file', () => {
  for (const kind of ['artist', 'album'] as const) {
    it(`answers 404 for a music ${kind} row, with a Radarr and a Sonarr server configured, and calls no service`, async () => {
      await saveMovieAndTv();
      const rows = await saveMusicRows();
      const row = rows[kind];
      const settings = getSettings();
      settings.radarr = [radarrServer()];
      const agent = await loginAs(app);
      const before = await rawMediaRows([row.id]);

      const res = await agent.delete(`/media/${row.id}/file`);

      assert.strictEqual(res.status, 404);
      assert.deepStrictEqual(await rawMediaRows([row.id]), before);
      assertNoOutsideCall();
    });
  }

  it('still answers 409 for a movie while no Radarr server is configured, and calls Radarr for one that is', async () => {
    const { movie } = await saveMovieAndTv();
    await saveMusicRows();
    const settings = getSettings();
    settings.radarr = [];
    settings.sonarr = [];
    const agent = await loginAs(app);

    const refused = await agent.delete(`/media/${movie.id}/file`);
    assert.strictEqual(refused.status, 409);

    settings.radarr = [radarrServer()];
    const removed = await agent.delete(`/media/${movie.id}/file`);
    assert.strictEqual(removed.status, 204);
    assert.strictEqual(outside[0].calls.length, 1);
    assert.strictEqual(
      (await getRepository(Media).findOneByOrFail({ id: movie.id })).status,
      MediaStatus.DELETED
    );
  });

  it('answers 404 for an id that is not a media, as before', async () => {
    await saveMusicRows();
    const agent = await loginAs(app);

    const res = await agent.delete('/media/99999/file');

    assert.strictEqual(res.status, 404);
  });
});

describe('GET /media/:id/watch_data', () => {
  function configureTautulli() {
    const settings = getSettings();
    settings.tautulli = {
      ...settings.tautulli,
      hostname: 'tautulli.local',
      port: 8181,
      apiKey: 'key',
    };
  }

  for (const kind of ['artist', 'album'] as const) {
    it(`answers 404 for a music ${kind} row and asks Tautulli nothing`, async () => {
      await saveMovieAndTv();
      const rows = await saveMusicRows();
      configureTautulli();
      const agent = await loginAs(app);

      const res = await agent.get(`/media/${rows[kind].id}/watch_data`);

      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.message, 'Media does not exist.');
      assertNoOutsideCall();
    });
  }

  it('answers a movie row with its watch data as before', async () => {
    const { movie } = await saveMovieAndTv();
    await saveMusicRows();
    await getRepository(Media).update({ id: movie.id }, { ratingKey: 'rk-1' });
    configureTautulli();
    const agent = await loginAs(app);

    const res = await agent.get(`/media/${movie.id}/watch_data`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.playCount, 0);
    assert.strictEqual(outside[3].calls.length, 1);
  });
});

function radarrServer(): RadarrSettings {
  return {
    id: 0,
    name: 'Radarr',
    hostname: 'radarr.local',
    port: 7878,
    apiKey: 'key',
    baseUrl: '',
    useSsl: false,
    activeProfileId: 1,
    activeDirectory: '/movies',
    is4k: false,
    minimumAvailability: 'released',
    tags: [],
    isDefault: true,
    syncEnabled: false,
    preventSearch: false,
    externalUrl: '',
  } as unknown as RadarrSettings;
}
