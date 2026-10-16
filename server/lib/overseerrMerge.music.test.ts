import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { MediaStatus, MediaType } from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import checkOverseerrMerge from '@server/lib/overseerrMerge';
import Settings from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import {
  assertRowsUnchanged,
  rawMediaRows,
  saveMusicRows,
} from '@server/test/musicRows';

// A music artist row and a music album row in the media table: the Overseerr
// merge neither fails on them nor touches them, and converts the statuses of
// movies and TV as it does without them (D-84, D-8).

setupTestDb();

const exitCodes: unknown[] = [];

beforeEach(async () => {
  exitCodes.length = 0;
  mock.method(process, 'exit', (code?: number) => {
    exitCodes.push(code);
    throw new Error(`process.exit(${code})`);
  });

  // the merge reads the settings of an Overseerr database (no media server
  // type), then reopens the connection the test already holds
  const saved: unknown[] = [];
  mock.method(Settings.prototype, 'load', async () => ({
    main: { mediaServerType: undefined, applicationTitle: 'Overseerr' },
    notifications: {
      agents: { email: { options: { senderName: 'Overseerr' } } },
    },
    save: async () => {
      saved.push(true);
    },
  }));
  mock.method(dataSource, 'initialize', async () => dataSource);
  mock.method(dataSource, 'destroy', async () => undefined);

  await dataSource.query(
    'CREATE TABLE IF NOT EXISTS "migrations" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "timestamp" bigint NOT NULL, "name" varchar NOT NULL)'
  );
});

afterEach(() => {
  mock.restoreAll();
});

describe('Overseerr merge with music rows in the table', () => {
  it('converts the blocklisted status of movies and TV to deleted and leaves music rows as they are', async () => {
    const repository = getRepository(Media);
    const movie = await repository.save(
      new Media({
        tmdbId: 9971,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.BLOCKLISTED,
        status4k: MediaStatus.AVAILABLE,
      })
    );
    const show = await repository.save(
      new Media({
        tmdbId: 9972,
        mediaType: MediaType.TV,
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.BLOCKLISTED,
      })
    );
    const untouched = await repository.save(
      new Media({
        tmdbId: 9973,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.PROCESSING,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    // music rows holding the very status the merge converts
    const { artist, album } = await saveMusicRows(MediaStatus.BLOCKLISTED);
    await repository.update(
      { id: album.id },
      { status: MediaStatus.AVAILABLE, status4k: MediaStatus.BLOCKLISTED }
    );
    const before = await rawMediaRows([artist.id, album.id]);

    const merged = await checkOverseerrMerge();

    assert.strictEqual(merged, true);
    assert.deepStrictEqual(exitCodes, []);
    const reload = (id: number) => repository.findOneByOrFail({ id });
    assert.strictEqual((await reload(movie.id)).status, MediaStatus.DELETED);
    assert.strictEqual(
      (await reload(movie.id)).status4k,
      MediaStatus.AVAILABLE
    );
    assert.strictEqual((await reload(show.id)).status, MediaStatus.AVAILABLE);
    assert.strictEqual((await reload(show.id)).status4k, MediaStatus.DELETED);
    assert.strictEqual(
      (await reload(untouched.id)).status,
      MediaStatus.PROCESSING
    );
    await assertRowsUnchanged([artist, album], before);
  });
});
