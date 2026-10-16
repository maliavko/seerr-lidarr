import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import TheMovieDb from '@server/api/themoviedb';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { Blocklist } from '@server/entity/Blocklist';
import Media from '@server/entity/Media';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import {
  MethodStubs,
  assertRowsUnchanged,
  rawMediaRows,
  saveMusicRows,
} from '@server/test/musicRows';
import { runWithMockTimers } from '@server/test/runWithMockTimers';
import blocklistedTagsProcessor from './blocklistedTagsProcessor';

// A music artist row and a music album row in the media table: the blocklisted
// tags processor neither fails on them nor touches them, and blocklists and
// cleans movies and TV as it does without them (D-84, D-8).

setupTestDb();

const stubs = new MethodStubs();

afterEach(() => {
  stubs.restore();
});

function results<T>(items: T[]) {
  return {
    page: 1,
    total_pages: 1,
    total_results: items.length,
    results: items,
  };
}

describe('Blocklisted tags processor with music rows in the table', () => {
  for (const musicStatus of [MediaStatus.BLOCKLISTED, MediaStatus.AVAILABLE]) {
    it(`cleans and fills the tag blocklist for movies and TV and leaves music rows of status ${musicStatus}`, async () => {
      const settings = getSettings();
      settings.main.blocklistedTags = '999';
      settings.main.blocklistedTagsLimit = 1;
      stubs.stub(TheMovieDb.prototype, 'getKeywordDetails', async () => ({
        id: 999,
        name: 'tag',
      }));
      stubs.stub(TheMovieDb.prototype, 'getDiscoverMovies', async () =>
        results([{ id: 100, title: 'Tagged Movie' }])
      );
      stubs.stub(TheMovieDb.prototype, 'getDiscoverTv', async () =>
        results([{ id: 200, name: 'Tagged Show' }])
      );

      // an entry an earlier run blocklisted by another tag, which the TMDB
      // answers above no longer list: the clean-up removes it with its media
      const stale = await getRepository(Media).save(
        new Media({
          tmdbId: 300,
          mediaType: MediaType.TV,
          status: MediaStatus.BLOCKLISTED,
          status4k: MediaStatus.BLOCKLISTED,
        })
      );
      await getRepository(Blocklist).save(
        new Blocklist({
          tmdbId: 300,
          mediaType: MediaType.TV,
          title: 'Stale',
          blocklistedTags: ',888,',
          media: stale,
        })
      );
      const { artist, album } = await saveMusicRows(musicStatus);
      const before = await rawMediaRows([artist.id, album.id]);

      await runWithMockTimers(() => blocklistedTagsProcessor.run());

      const movie = await getRepository(Media).findOneByOrFail({
        tmdbId: 100,
        mediaType: MediaType.MOVIE,
      });
      assert.strictEqual(movie.status, MediaStatus.BLOCKLISTED);
      const show = await getRepository(Media).findOneByOrFail({
        tmdbId: 200,
        mediaType: MediaType.TV,
      });
      assert.strictEqual(show.status, MediaStatus.BLOCKLISTED);
      assert.strictEqual(
        await getRepository(Media).countBy({ tmdbId: 300 }),
        0,
        'a tag-blocklisted media the tags no longer list is cleaned away'
      );
      assert.deepStrictEqual(
        (await getRepository(Blocklist).find({ order: { tmdbId: 'ASC' } })).map(
          (b) => [b.tmdbId, b.mediaType, b.blocklistedTags]
        ),
        [
          [100, MediaType.MOVIE, ',999,'],
          [200, MediaType.TV, ',999,'],
        ]
      );
      await assertRowsUnchanged([artist, album], before);
    });
  }
});
