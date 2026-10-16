import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';

import TheMovieDb from '@server/api/themoviedb';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { Watchlist } from '@server/entity/Watchlist';
import { setupTestDb } from '@server/test/db';
import { MethodStubs, createRoutesApp, loginAs } from '@server/test/musicRows';
import type { Express } from 'express';
import watchlistRoutes from './watchlist';

// POST /watchlist takes a movie or a TV show by TMDB id as it did before music
// joined MediaType, and refuses any other media type, music included, saving
// no row and asking TMDB nothing (D-8, D-111).

let app: Express;

before(() => {
  app = createRoutesApp({ '/watchlist': watchlistRoutes });
});

setupTestDb();

const stubs = new MethodStubs();
let tmdbCalls: unknown[][] = [];

function stubTmdb() {
  tmdbCalls = [];
  for (const method of ['getMovie', 'getTvShow']) {
    stubs.stub(TheMovieDb.prototype, method, async (...args: unknown[]) => {
      tmdbCalls.push([method, ...args]);
      const id = Object.values(args[0] as Record<string, number>)[0];
      return { id, external_ids: { tvdb_id: id + 1000 } };
    });
  }
}

afterEach(() => {
  stubs.restore();
});

describe('POST /watchlist', () => {
  it('takes a movie and a TV show as before', async () => {
    stubTmdb();
    const agent = await loginAs(app);

    for (const [tmdbId, mediaType] of [
      [7001, MediaType.MOVIE],
      [7002, MediaType.TV],
    ] as const) {
      const res = await agent
        .post('/watchlist')
        .send({ tmdbId, mediaType, title: 'Title' });

      assert.strictEqual(res.status, 201, mediaType);
      const media = await getRepository(Media).findOneByOrFail({
        tmdbId,
        mediaType,
      });
      assert.ok(media.id);
    }

    assert.strictEqual(await getRepository(Watchlist).count(), 2);
    assert.deepStrictEqual(
      tmdbCalls.map((call) => call[0]),
      ['getMovie', 'getTvShow']
    );
  });

  it('refuses mediaType music, saving no row and asking TMDB nothing', async () => {
    stubTmdb();
    const agent = await loginAs(app);

    const res = await agent
      .post('/watchlist')
      .send({ tmdbId: 7002, mediaType: MediaType.MUSIC, title: 'x' });

    assert.ok(res.status >= 400, `answered ${res.status}`);
    assert.strictEqual(await getRepository(Watchlist).count(), 0);
    assert.strictEqual(await getRepository(Media).count(), 0);
    assert.deepStrictEqual(tmdbCalls, []);
  });

  it('refuses a media type it never knew, as it does music', async () => {
    stubTmdb();
    const agent = await loginAs(app);

    const unknown = await agent
      .post('/watchlist')
      .send({ tmdbId: 7003, mediaType: 'nonsense' });
    const music = await agent
      .post('/watchlist')
      .send({ tmdbId: 7003, mediaType: MediaType.MUSIC });

    assert.strictEqual(music.status, unknown.status);
    assert.deepStrictEqual(music.body, unknown.body);
  });
});
