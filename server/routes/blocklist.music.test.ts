import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';

import TheMovieDb from '@server/api/themoviedb';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { Blocklist } from '@server/entity/Blocklist';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
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
import blocklistRoutes from './blocklist';

// A music artist row and a music album row in the media table: the blocklist
// routes read and write movies and TV by TMDB id and neither fail on them nor
// change their answer for movies and TV (D-84, D-8).

let app: Express;

before(() => {
  app = createRoutesApp({ '/blocklist': blocklistRoutes });
});

setupTestDb();

const stubs = new MethodStubs();

afterEach(() => {
  stubs.restore();
});

async function blocklistMovieAndShow() {
  const admin = await getRepository(User).findOneByOrFail({ id: 1 });
  const items = [
    { tmdbId: 9901, mediaType: MediaType.MOVIE, title: 'Blocked Movie' },
    { tmdbId: 9902, mediaType: MediaType.TV, title: 'Blocked Show' },
  ];

  for (const item of items) {
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: item.tmdbId,
        mediaType: item.mediaType,
        status: MediaStatus.BLOCKLISTED,
        status4k: MediaStatus.BLOCKLISTED,
      })
    );
    await getRepository(Blocklist).save(
      new Blocklist({ ...item, user: admin, media })
    );
  }
}

describe('blocklist routes with music rows in the table', () => {
  it('GET /blocklist and GET /blocklist/:id answer what they answer without them', async () => {
    await blocklistMovieAndShow();
    const agent = await loginAs(app);
    const urls = [
      '/blocklist',
      '/blocklist?filter=manual',
      '/blocklist?search=Blocked',
      '/blocklist/9901?mediaType=movie',
      '/blocklist/9902?mediaType=tv',
    ];

    const without = await Promise.all(urls.map((url) => agent.get(url)));
    await saveMusicRows(MediaStatus.BLOCKLISTED);
    const withMusic = await Promise.all(urls.map((url) => agent.get(url)));

    withMusic.forEach((res, i) => {
      assert.strictEqual(res.status, 200, urls[i]);
      assert.deepStrictEqual(res.body, without[i].body, urls[i]);
    });
    assert.strictEqual(withMusic[0].body.pageInfo.results, 2);
  });

  it('GET /blocklist/:id answers 400 for a music media type, as for any other it does not take', async () => {
    const agent = await loginAs(app);

    const res = await agent.get('/blocklist/1?mediaType=music');

    assert.strictEqual(res.status, 400);
  });

  it('POST /blocklist blocklists a movie and a show as before and leaves the music rows alone', async () => {
    const { artist, album } = await saveMusicRows(MediaStatus.AVAILABLE);
    const before = await rawMediaRows([artist.id, album.id]);
    const agent = await loginAs(app);

    for (const [tmdbId, mediaType] of [
      [9911, MediaType.MOVIE],
      [9912, MediaType.TV],
    ] as const) {
      const res = await agent
        .post('/blocklist')
        .send({ tmdbId, mediaType, title: `Title ${tmdbId}`, user: 1 });
      assert.strictEqual(res.status, 201);

      const media = await getRepository(Media).findOneByOrFail({
        tmdbId,
        mediaType,
      });
      assert.strictEqual(media.status, MediaStatus.BLOCKLISTED);
    }

    const duplicate = await agent
      .post('/blocklist')
      .send({ tmdbId: 9911, mediaType: MediaType.MOVIE, user: 1 });
    assert.strictEqual(duplicate.status, 412);
    await assertRowsUnchanged([artist, album], before);
  });

  it('POST /blocklist refuses a music media type and saves neither a blocklist nor a media row', async () => {
    const { artist, album } = await saveMusicRows(MediaStatus.AVAILABLE);
    const before = await rawMediaRows([artist.id, album.id]);
    const agent = await loginAs(app);

    const res = await agent
      .post('/blocklist')
      .send({ tmdbId: 9921, mediaType: MediaType.MUSIC, title: 'x', user: 1 });

    assert.ok(res.status >= 400, `answered ${res.status}`);
    assert.strictEqual(await getRepository(Blocklist).count(), 0);
    assert.strictEqual(await getRepository(Media).count(), 2);
    await assertRowsUnchanged([artist, album], before);
  });

  it('DELETE /blocklist/:id removes the movie or show and its blocklist entry and leaves the music rows', async () => {
    await blocklistMovieAndShow();
    const { artist, album } = await saveMusicRows(MediaStatus.BLOCKLISTED);
    const before = await rawMediaRows([artist.id, album.id]);
    const agent = await loginAs(app);

    assert.strictEqual(
      (await agent.delete('/blocklist/9901?mediaType=movie')).status,
      204
    );
    assert.strictEqual(
      (await agent.delete('/blocklist/9902?mediaType=tv')).status,
      204
    );
    assert.strictEqual(
      (await agent.delete('/blocklist/9902?mediaType=music')).status,
      400
    );

    assert.strictEqual(await getRepository(Blocklist).count(), 0);
    assert.strictEqual(await getRepository(Media).count(), 2);
    await assertRowsUnchanged([artist, album], before);
  });

  it('POST and DELETE /blocklist/collection/:id blocklist and unblocklist the movies of a collection and leave the music rows', async () => {
    stubs.stub(TheMovieDb.prototype, 'getCollection', async () => ({
      id: 9930,
      name: 'Collection',
      overview: '',
      parts: [
        { id: 9931, title: 'Part One' },
        { id: 9932, title: 'Part Two' },
      ],
    }));
    const { artist, album } = await saveMusicRows(MediaStatus.AVAILABLE);
    const before = await rawMediaRows([artist.id, album.id]);
    const agent = await loginAs(app);

    assert.strictEqual(
      (await agent.post('/blocklist/collection/9930')).status,
      201
    );
    assert.strictEqual(
      await getRepository(Media).countBy({
        mediaType: MediaType.MOVIE,
        status: MediaStatus.BLOCKLISTED,
      }),
      2
    );
    assert.strictEqual(await getRepository(Blocklist).count(), 2);
    await assertRowsUnchanged([artist, album], before);

    assert.strictEqual(
      (await agent.delete('/blocklist/collection/9930')).status,
      204
    );
    assert.strictEqual(await getRepository(Blocklist).count(), 0);
    assert.strictEqual(await getRepository(Media).count(), 2);
    await assertRowsUnchanged([artist, album], before);
  });
});
