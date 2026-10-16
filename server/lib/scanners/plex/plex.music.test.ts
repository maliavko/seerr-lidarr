import animeList from '@server/api/animelist';
import type {
  PlexLibrary,
  PlexLibraryItem,
  PlexMetadata,
} from '@server/api/plexapi';
import PlexAPI from '@server/api/plexapi';
import TheMovieDb from '@server/api/themoviedb';
import type { TmdbTvDetails } from '@server/api/themoviedb/interfaces';
import { MediaStatus, MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { plexFullScanner } from '@server/lib/scanners/plex';
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

// A music artist row and a music album row in the media table: the Plex scan
// neither fails on them nor touches them, and does for movies and shows what it
// does without them (D-84, D-8).

Object.defineProperty(animeList, 'sync', {
  value: async () => {},
  configurable: true,
  writable: true,
});

const MOVIE_TMDB_ID = 9601;
const SHOW_TMDB_ID = 9602;

Object.defineProperty(PlexAPI.prototype, 'getLibraries', {
  get() {
    return async (): Promise<PlexLibrary[]> => [
      { key: 'movies', title: 'Movies', type: 'movie', agent: 'plex' },
      { key: 'shows', title: 'Shows', type: 'show', agent: 'plex' },
    ];
  },
  set() {},
  configurable: true,
});

Object.defineProperty(PlexAPI.prototype, 'getLibraryContents', {
  get() {
    return async (id: string) =>
      id === 'movies'
        ? { totalSize: 1, items: [plexMovieItem()] }
        : { totalSize: 1, items: [plexShowItem()] };
  },
  set() {},
  configurable: true,
});

Object.defineProperty(PlexAPI.prototype, 'getMetadata', {
  get() {
    return async (key: string): Promise<PlexMetadata | undefined> =>
      key === 'show-key' ? plexShowMetadata() : undefined;
  },
  set() {},
  configurable: true,
});

Object.defineProperty(PlexAPI.prototype, 'getChildrenMetadata', {
  get() {
    return async () => [];
  },
  set() {},
  configurable: true,
});

const getTvShowImpl = async (): Promise<TmdbTvDetails> => fakeTmdbShow();

for (const method of ['getTvShow', 'getTvShowForScan'] as const) {
  Object.defineProperty(TheMovieDb.prototype, method, {
    get() {
      return getTvShowImpl;
    },
    set() {},
    configurable: true,
  });

  // plexFullScanner built its own TheMovieDb on import, before the stubs above
  Object.defineProperty(plexFullScanner.tmdb, method, {
    value: getTvShowImpl,
    configurable: true,
  });
}

setupTestDb();

function fakeTmdbShow(): TmdbTvDetails {
  return {
    id: SHOW_TMDB_ID,
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

function plexMovieItem(): PlexLibraryItem {
  return {
    ratingKey: 'movie-key',
    title: 'Test Movie',
    guid: 'plex://movie/test-movie',
    Guid: [{ id: `tmdb://${MOVIE_TMDB_ID}` }],
    addedAt: 1700000000,
    updatedAt: 1700000000,
    type: 'movie',
    Media: [],
  } as PlexLibraryItem;
}

function plexShowItem(): PlexLibraryItem {
  return {
    ratingKey: 'show-key',
    title: 'Test Show',
    guid: 'plex://show/test-show',
    addedAt: 1700000000,
    updatedAt: 1700000000,
    type: 'show',
    Media: [],
  };
}

function plexShowMetadata(): PlexMetadata {
  return {
    ratingKey: 'show-key',
    title: 'Test Show',
    guid: 'plex://show/test-show',
    type: 'show',
    Guid: [{ id: `tmdb://${SHOW_TMDB_ID}` }],
    Children: { size: 12, Metadata: [] },
    index: 1,
    leafCount: 0,
    viewedLeafCount: 0,
    addedAt: 1700000000,
    updatedAt: 1700000000,
    Media: [],
  };
}

describe('Plex scan with music rows in the table', () => {
  for (const musicStatus of [
    MediaStatus.PROCESSING,
    MediaStatus.AVAILABLE,
    MediaStatus.PARTIALLY_AVAILABLE,
  ]) {
    it(`leaves music rows (status ${musicStatus}) as they are and scans movies and shows as it does without them`, async () => {
      const settings = getSettings();
      settings.main.mediaServerType = MediaServerType.PLEX;
      settings.radarr = [];
      settings.sonarr = [];
      settings.plex = {
        ...settings.plex,
        ip: '127.0.0.1',
        port: 32400,
        libraries: [
          { id: 'movies', name: 'Movies', enabled: true, type: 'movie' },
          { id: 'shows', name: 'Shows', enabled: true, type: 'show' },
        ],
      };

      const repository = getRepository(Media);
      const { artist, album } = await saveMusicRows(musicStatus);
      const before = await rawMediaRows([artist.id, album.id]);

      await runWithMockTimers(() => plexFullScanner.run());

      const movie = await repository.findOneByOrFail({ tmdbId: MOVIE_TMDB_ID });
      assert.strictEqual(movie.mediaType, MediaType.MOVIE);
      assert.strictEqual(movie.status, MediaStatus.AVAILABLE);
      assert.strictEqual(movie.ratingKey, 'movie-key');

      const show = await repository.findOneByOrFail({ tmdbId: SHOW_TMDB_ID });
      assert.strictEqual(show.mediaType, MediaType.TV);

      assert.strictEqual(await repository.count(), 4);
      await assertRowsUnchanged([artist, album], before);
    });
  }
});
