import type { PlexWatchlistItem } from '@server/api/plextv';
import PlexTvAPI from '@server/api/plextv';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { Permission } from '@server/lib/permissions';
import watchlistSync from '@server/lib/watchlistsync';
import { setupTestDb } from '@server/test/db';
import {
  assertRowsUnchanged,
  rawMediaRows,
  saveMusicRows,
} from '@server/test/musicRows';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

// A music artist row and a music album row in the media table: the watchlist
// sync neither fails on them nor changes which movies and shows it requests
// (D-84, D-8).

let watchlistItems: PlexWatchlistItem[] = [];

Object.defineProperty(PlexTvAPI.prototype, 'getWatchlist', {
  get() {
    return async () => ({
      offset: 0,
      size: 20,
      totalSize: watchlistItems.length,
      items: watchlistItems,
    });
  },
  set() {},
  configurable: true,
});

let requestCalls: { mediaId: number; mediaType: MediaType }[] = [];

Object.defineProperty(MediaRequest, 'request', {
  value: async (body: { mediaId: number; mediaType: MediaType }) => {
    requestCalls.push({ mediaId: body.mediaId, mediaType: body.mediaType });
    return {} as MediaRequest;
  },
  writable: true,
  configurable: true,
});

setupTestDb();

async function configureSyncUser(): Promise<User> {
  const userRepository = getRepository(User);
  const admin = await userRepository.findOneOrFail({ where: { id: 1 } });

  admin.plexToken = 'test-plex-token';
  admin.permissions = Permission.AUTO_REQUEST;
  await userRepository.save(admin);

  await getRepository(UserSettings).save(
    new UserSettings({
      user: admin,
      watchlistSyncMovies: true,
      watchlistSyncTv: true,
    })
  );

  return admin;
}

async function seedMedia(
  tmdbId: number,
  mediaType: MediaType,
  status: MediaStatus
): Promise<void> {
  await getRepository(Media).save(
    new Media({ tmdbId, mediaType, status, status4k: MediaStatus.UNKNOWN })
  );
}

describe('Watchlist sync with music rows in the table', () => {
  beforeEach(() => {
    requestCalls = [];
    watchlistItems = [];
  });

  it('requests the same movies and shows it requests without them', async () => {
    await configureSyncUser();
    await seedMedia(100, MediaType.MOVIE, MediaStatus.DELETED);
    await seedMedia(102, MediaType.MOVIE, MediaStatus.AVAILABLE);
    await seedMedia(200, MediaType.TV, MediaStatus.DELETED);
    await seedMedia(201, MediaType.TV, MediaStatus.AVAILABLE);

    watchlistItems = [
      {
        ratingKey: 'rk-100',
        tmdbId: 100,
        title: 'Deleted Movie',
        type: 'movie',
      },
      { ratingKey: 'rk-101', tmdbId: 101, title: 'New Movie', type: 'movie' },
      {
        ratingKey: 'rk-102',
        tmdbId: 102,
        title: 'Available Movie',
        type: 'movie',
      },
      {
        ratingKey: 'rk-200',
        tmdbId: 200,
        tvdbId: 200000,
        title: 'Deleted Show',
        type: 'show',
      },
      {
        ratingKey: 'rk-201',
        tmdbId: 201,
        tvdbId: 201000,
        title: 'Available Show',
        type: 'show',
      },
    ];

    await watchlistSync.syncWatchlist();
    const without = requestCalls.map((c) => `${c.mediaType}:${c.mediaId}`);
    assert.deepStrictEqual(without.sort(), [
      'movie:100',
      'movie:101',
      'tv:200',
    ]);

    requestCalls = [];
    const { artist, album } = await saveMusicRows(MediaStatus.AVAILABLE);
    const before = await rawMediaRows([artist.id, album.id]);

    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(
      requestCalls.map((c) => `${c.mediaType}:${c.mediaId}`).sort(),
      without
    );
    await assertRowsUnchanged([artist, album], before);
  });
});
