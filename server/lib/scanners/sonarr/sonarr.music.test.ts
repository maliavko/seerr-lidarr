import type { SonarrSeries } from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import type { TmdbTvDetails } from '@server/api/themoviedb/interfaces';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import Season from '@server/entity/Season';
import { sonarrScanner } from '@server/lib/scanners/sonarr';
import type { SonarrSettings } from '@server/lib/settings';
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

// A music artist row and a music album row in the media table: the Sonarr scan
// neither fails on them nor touches them, and does for shows what it does
// without them (D-84, D-8).

let getSeriesImpl: () => Promise<SonarrSeries[]> = async () => [];
Object.defineProperty(SonarrAPI.prototype, 'getSeries', {
  set() {},
  get() {
    return async () => getSeriesImpl();
  },
  configurable: true,
});

const confirmedTvdbIds: unknown[] = [];
Object.defineProperty(SonarrAPI.prototype, 'getLibrarySeriesByTvdbId', {
  set() {},
  get() {
    return async (tvdbId: unknown) => {
      confirmedTvdbIds.push(tvdbId);
      return [];
    };
  },
  configurable: true,
});

function fakeTmdbShow(tmdbId: number): TmdbTvDetails {
  return {
    id: tmdbId,
    content_ratings: { results: [] },
    created_by: [],
    episode_run_time: [],
    first_air_date: '2024-01-01',
    genres: [],
    homepage: '',
    in_production: false,
    languages: ['en'],
    last_air_date: '2024-01-01',
    name: 'Test Show',
    networks: [],
    number_of_episodes: 10,
    number_of_seasons: 1,
    origin_country: ['US'],
    original_language: 'en',
    original_name: 'Test Show',
    overview: '',
    popularity: 0,
    production_companies: [],
    production_countries: [],
    spoken_languages: [],
    seasons: [
      {
        id: 1,
        air_date: '2024-01-01',
        episode_count: 10,
        name: 'Season 1',
        overview: '',
        season_number: 1,
      },
    ],
    status: 'Ended',
    type: 'Scripted',
    vote_average: 0,
    vote_count: 0,
    aggregate_credits: { cast: [] },
    credits: { crew: [] },
    external_ids: {},
    keywords: { results: [] },
    videos: { results: [] },
  };
}

// the show of tvdb id N is show 3000 + N on TMDB
const getTvShowImpl = async (args: { tvId: number }) => fakeTmdbShow(args.tvId);
const getShowByTvdbIdImpl = async (args: { tvdbId: number }) =>
  fakeTmdbShow(3000 + args.tvdbId);

Object.defineProperty(TheMovieDb.prototype, 'getShowByTvdbIdForScan', {
  set() {},
  get() {
    return getShowByTvdbIdImpl;
  },
  configurable: true,
});

for (const method of ['getTvShow', 'getTvShowForScan'] as const) {
  Object.defineProperty(TheMovieDb.prototype, method, {
    set() {},
    get() {
      return getTvShowImpl;
    },
    configurable: true,
  });
  // both are assigned in the constructor, so the prototype stubs miss the
  // instance sonarrScanner built when it was first imported
  Object.defineProperty(sonarrScanner.tmdb, method, {
    value: getTvShowImpl,
    configurable: true,
  });
}

setupTestDb();

function fakeSonarrSeries(tvdbId: number): SonarrSeries {
  return {
    tvdbId,
    id: tvdbId,
    title: 'Test Show',
    titleSlug: 'test-show',
    monitored: true,
    seasons: [
      {
        seasonNumber: 1,
        monitored: true,
        statistics: {
          episodeFileCount: 10,
          totalEpisodeCount: 10,
          episodeCount: 10,
          percentOfEpisodes: 100,
          sizeOnDisk: 0,
          previousAiring: undefined,
        },
      },
    ],
  } as SonarrSeries;
}

function configureSonarr(): void {
  const settings = getSettings();
  settings.sonarr = [
    {
      id: 0,
      name: 'Sonarr 0',
      hostname: 'localhost',
      port: 8989,
      apiKey: 'test-key',
      baseUrl: '',
      useSsl: false,
      activeProfileId: 1,
      activeDirectory: '/tv',
      activeLanguageProfileId: 1,
      activeAnimeProfileId: undefined,
      activeAnimeDirectory: '',
      activeAnimeLanguageProfileId: undefined,
      animeTags: [],
      is4k: false,
      enableSeasonFolders: true,
      tags: [],
      isDefault: true,
      syncEnabled: true,
      preventSearch: false,
      externalUrl: '',
    },
  ] as unknown as SonarrSettings[];
  settings.radarr = [];
}

async function saveProcessingShow(tmdbId: number, tvdbId: number) {
  return getRepository(Media).save(
    new Media({
      tmdbId,
      tvdbId,
      mediaType: MediaType.TV,
      status: MediaStatus.PROCESSING,
      seasons: [
        new Season({
          seasonNumber: 1,
          status: MediaStatus.PROCESSING,
          status4k: MediaStatus.UNKNOWN,
        }),
      ],
    })
  );
}

describe('Sonarr scan with music rows in the table', () => {
  for (const musicStatus of [
    MediaStatus.PROCESSING,
    MediaStatus.PARTIALLY_AVAILABLE,
  ]) {
    it(`leaves music rows (status ${musicStatus}) as they are and scans and cleans up shows as it does without them`, async () => {
      const repository = getRepository(Media);
      await saveProcessingShow(3100, 100);
      await saveProcessingShow(3200, 200);
      const { artist, album } = await saveMusicRows(musicStatus);
      const before = await rawMediaRows([artist.id, album.id]);

      configureSonarr();
      confirmedTvdbIds.length = 0;
      getSeriesImpl = async () => [
        fakeSonarrSeries(100),
        fakeSonarrSeries(300),
      ];

      await runWithMockTimers(() => sonarrScanner.run());

      const scanned = await repository.findOneOrFail({
        where: { tmdbId: 3100 },
        relations: { seasons: true },
      });
      assert.strictEqual(scanned.status, MediaStatus.AVAILABLE);
      assert.strictEqual(scanned.seasons[0].status, MediaStatus.AVAILABLE);

      const orphan = await repository.findOneOrFail({
        where: { tmdbId: 3200 },
        relations: { seasons: true },
      });
      assert.strictEqual(
        orphan.status,
        MediaStatus.UNKNOWN,
        'a processing show missing from Sonarr is reset, as without music rows'
      );
      assert.deepStrictEqual(confirmedTvdbIds, [200]);
      await assertRowsUnchanged([artist, album], before);
    });
  }
});
