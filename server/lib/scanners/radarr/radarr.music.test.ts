import type { RadarrMovie } from '@server/api/servarr/radarr';
import RadarrAPI from '@server/api/servarr/radarr';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { radarrScanner } from '@server/lib/scanners/radarr';
import type { RadarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import {
  assertRowsUnchanged,
  rawMediaRows,
  saveMusicRows,
} from '@server/test/musicRows';
import { runWithMockTimers } from '@server/test/runWithMockTimers';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// A music artist row and a music album row in the media table: the Radarr scan
// neither fails on them nor touches them, and does for movies what it does
// without them (D-84, D-8).

let getMoviesImpl: () => Promise<RadarrMovie[]> = async () => [];
Object.defineProperty(RadarrAPI.prototype, 'getMovies', {
  set() {},
  get() {
    return async () => getMoviesImpl();
  },
  configurable: true,
});

const confirmedTmdbIds: unknown[] = [];
Object.defineProperty(RadarrAPI.prototype, 'getLibraryMoviesByTmdbId', {
  set() {},
  get() {
    return async (tmdbId: unknown) => {
      confirmedTmdbIds.push(tmdbId);
      return [];
    };
  },
  configurable: true,
});

setupTestDb();

function configureRadarr(): void {
  const settings = getSettings();
  settings.radarr = [
    {
      id: 0,
      name: 'Radarr 0',
      hostname: 'localhost',
      port: 7878,
      apiKey: 'test-key',
      baseUrl: '',
      useSsl: false,
      activeProfileId: 1,
      activeProfileName: 'Default',
      activeDirectory: '/movies',
      is4k: false,
      minimumAvailability: 'released',
      tags: [],
      isDefault: true,
      syncEnabled: true,
      preventSearch: false,
      tagRequests: false,
      overrideRule: [],
      externalUrl: '',
    },
  ] as RadarrSettings[];
  settings.sonarr = [];
}

function fakeRadarrMovie(overrides: Partial<RadarrMovie> = {}): RadarrMovie {
  return {
    tmdbId: 550,
    id: 1,
    title: 'Test Movie',
    titleSlug: 'test-movie',
    monitored: true,
    hasFile: true,
    isAvailable: true,
    imdbId: 'tt0137523',
    folderName: '/movies/Test Movie (2024)',
    path: '/movies/Test Movie (2024)',
    profileId: 1,
    qualityProfileId: 1,
    added: '2024-01-01T00:00:00Z',
    tags: [],
    ...overrides,
  };
}

describe('Radarr scan with music rows in the table', () => {
  it('leaves music rows as they are and scans and cleans up movies as it does without them', async () => {
    const repository = getRepository(Media);
    await repository.save(
      new Media({
        tmdbId: 550,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.PROCESSING,
      })
    );
    await repository.save(
      new Media({
        tmdbId: 551,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.PROCESSING,
      })
    );
    // the rows a cleanup of processing media would reach, were they movies
    const { artist, album } = await saveMusicRows(MediaStatus.PROCESSING);
    const before = await rawMediaRows([artist.id, album.id]);

    configureRadarr();
    confirmedTmdbIds.length = 0;
    getMoviesImpl = async () => [
      fakeRadarrMovie({ tmdbId: 550, id: 1 }),
      fakeRadarrMovie({ tmdbId: 552, id: 2, title: 'New Movie' }),
    ];

    await runWithMockTimers(() => radarrScanner.run());

    assert.strictEqual(
      (await repository.findOneByOrFail({ tmdbId: 550 })).status,
      MediaStatus.AVAILABLE
    );
    assert.strictEqual(
      (await repository.findOneByOrFail({ tmdbId: 551 })).status,
      MediaStatus.UNKNOWN,
      'a processing movie missing from Radarr is reset, as without music rows'
    );
    assert.strictEqual(
      (await repository.findOneByOrFail({ tmdbId: 552 })).status,
      MediaStatus.AVAILABLE
    );
    assert.deepStrictEqual(confirmedTmdbIds, [551]);
    await assertRowsUnchanged([artist, album], before);
    assert.strictEqual(await repository.count(), 5);
  });

  it('scans and cleans up the same with an available music row', async () => {
    const repository = getRepository(Media);
    const { artist, album } = await saveMusicRows(MediaStatus.AVAILABLE);
    const before = await rawMediaRows([artist.id, album.id]);

    configureRadarr();
    getMoviesImpl = async () => [fakeRadarrMovie({ tmdbId: 560, id: 3 })];

    await runWithMockTimers(() => radarrScanner.run());

    assert.strictEqual(
      (await repository.findOneByOrFail({ tmdbId: 560 })).status,
      MediaStatus.AVAILABLE
    );
    await assertRowsUnchanged([artist, album], before);
  });
});
