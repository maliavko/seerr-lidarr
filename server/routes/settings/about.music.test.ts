import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { setupTestDb } from '@server/test/db';
import {
  authenticated,
  createRoutesApp,
  loginAs,
  saveMusicRows,
} from '@server/test/musicRows';
import type { Express } from 'express';
import settingsRoutes from './index';

// A music artist row and a music album row in the media table: the about
// page's count of media rows counts every row, music too, and nothing else of
// the answer changes (D-84, D-8).

let app: Express;

before(() => {
  app = createRoutesApp({ '/settings': authenticated(settingsRoutes) });
});

setupTestDb();

describe('GET /settings/about with music rows in the table', () => {
  it('counts every media row, music rows too, and answers the rest as without them', async () => {
    for (const [tmdbId, mediaType] of [
      [9961, MediaType.MOVIE],
      [9962, MediaType.TV],
      [9963, MediaType.MOVIE],
    ] as const) {
      await getRepository(Media).save(
        new Media({
          tmdbId,
          mediaType,
          status: MediaStatus.AVAILABLE,
          status4k: MediaStatus.UNKNOWN,
        })
      );
    }
    const agent = await loginAs(app);

    const without = await agent.get('/settings/about');
    assert.strictEqual(without.status, 200);
    assert.strictEqual(without.body.totalMediaItems, 3);

    await saveMusicRows();
    const withMusic = await agent.get('/settings/about');

    assert.strictEqual(withMusic.status, 200);
    assert.strictEqual(withMusic.body.totalMediaItems, 5);
    assert.deepStrictEqual(
      { ...withMusic.body, totalMediaItems: undefined },
      { ...without.body, totalMediaItems: undefined }
    );
    assert.strictEqual(withMusic.body.totalRequests, 0);
  });
});
