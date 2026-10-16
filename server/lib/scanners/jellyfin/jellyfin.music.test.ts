import animeList from '@server/api/animelist';
import type {
  JellyfinLibraryItem,
  JellyfinLibraryItemExtended,
} from '@server/api/jellyfin';
import JellyfinAPI from '@server/api/jellyfin';
import TheMovieDb from '@server/api/themoviedb';
import type { TmdbTvDetails } from '@server/api/themoviedb/interfaces';
import { MediaStatus, MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { jellyfinFullScanner } from '@server/lib/scanners/jellyfin';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import {
  assertRowsUnchanged,
  rawMediaRows,
  saveMusicRows,
} from '@server/test/musicRows';
import { runWithMockTimers } from '@server/test/runWithMockTimers';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

// A music artist row and a music album row in the media table: the Jellyfin and
// Emby scan neither fails on them nor touches them, and does for movies and
// shows what it does without them (D-84, D-8).

Object.defineProperty(animeList, 'sync', {
  value: async () => {},
  configurable: true,
  writable: true,
});

const MOVIE_TMDB_ID = 9701;
const SHOW_TMDB_ID = 9702;

const item = (
  id: string,
  type: string,
  extra: Partial<JellyfinLibraryItem> = {}
): JellyfinLibraryItem =>
  ({
    Name: `Item ${id}`,
    Id: id,
    Type: type,
    HasSubtitles: false,
    LocationType: 'FileSystem',
    MediaType: 'Video',
    ...extra,
  }) as JellyfinLibraryItem;

Object.defineProperty(JellyfinAPI.prototype, 'getLibraryContents', {
  get() {
    return async (id: string): Promise<JellyfinLibraryItem[]> =>
      id === 'movies'
        ? [
            item('jf-movie', 'Movie'),
            // what a Jellyfin music library lists: no scan reads it (BAR)
            item('jf-artist', 'MusicArtist'),
            item('jf-album', 'MusicAlbum'),
          ]
        : [item('jf-show', 'Series')];
  },
  set() {},
  configurable: true,
});

Object.defineProperty(JellyfinAPI.prototype, 'getItemData', {
  get() {
    return async (
      id: string
    ): Promise<JellyfinLibraryItemExtended | undefined> => {
      if (id === 'jf-movie') {
        return {
          ...item('jf-movie', 'Movie'),
          ProviderIds: { Tmdb: String(MOVIE_TMDB_ID) },
          DateCreated: '2024-01-01T00:00:00Z',
          MediaSources: [
            {
              MediaStreams: [{ Type: 'Video', Width: 1920 }],
            },
          ],
        } as unknown as JellyfinLibraryItemExtended;
      }
      if (id === 'jf-show') {
        return {
          ...item('jf-show', 'Series'),
          ProviderIds: { Tmdb: String(SHOW_TMDB_ID) },
        } as JellyfinLibraryItemExtended;
      }
      return undefined;
    };
  },
  set() {},
  configurable: true,
});

for (const method of ['getSeasons', 'getEpisodes'] as const) {
  Object.defineProperty(JellyfinAPI.prototype, method, {
    get() {
      return async () => [];
    },
    set() {},
    configurable: true,
  });
}

Object.defineProperty(JellyfinAPI.prototype, 'setUserId', {
  get() {
    return () => {};
  },
  set() {},
  configurable: true,
});

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

const getTvShowImpl = async (): Promise<TmdbTvDetails> => fakeTmdbShow();

for (const method of ['getTvShow', 'getTvShowForScan'] as const) {
  Object.defineProperty(TheMovieDb.prototype, method, {
    get() {
      return getTvShowImpl;
    },
    set() {},
    configurable: true,
  });

  // both are assigned in the constructor, so the prototype stubs miss the
  // instance jellyfinFullScanner built when it was first imported
  Object.defineProperty(jellyfinFullScanner.tmdb, method, {
    value: getTvShowImpl,
    configurable: true,
  });
}

setupTestDb();

describe('Jellyfin scan with music rows in the table', () => {
  beforeEach(async () => {
    const userRepository = getRepository(User);
    const admin = await userRepository.findOneOrFail({ where: { id: 1 } });
    admin.jellyfinUserId = 'admin-user-id';
    admin.jellyfinDeviceId = 'admin-device-id';
    await userRepository.save(admin);
  });

  for (const serverType of [MediaServerType.JELLYFIN, MediaServerType.EMBY]) {
    for (const musicStatus of [
      MediaStatus.PROCESSING,
      MediaStatus.AVAILABLE,
      MediaStatus.PARTIALLY_AVAILABLE,
    ]) {
      it(`leaves music rows (status ${musicStatus}) as they are and scans movies and shows as it does without them (${MediaServerType[serverType]})`, async () => {
        const settings = getSettings();
        settings.main.mediaServerType = serverType;
        settings.radarr = [];
        settings.sonarr = [];
        settings.jellyfin = {
          ...settings.jellyfin,
          apiKey: 'test-api-key',
          libraries: [
            { id: 'movies', name: 'Movies', enabled: true, type: 'movie' },
            { id: 'shows', name: 'Shows', enabled: true, type: 'show' },
          ],
        };

        const repository = getRepository(Media);
        const { artist, album } = await saveMusicRows(musicStatus);
        const before = await rawMediaRows([artist.id, album.id]);

        await runWithMockTimers(() => jellyfinFullScanner.run());

        const movie = await repository.findOneByOrFail({
          tmdbId: MOVIE_TMDB_ID,
        });
        assert.strictEqual(movie.mediaType, MediaType.MOVIE);
        assert.strictEqual(movie.status, MediaStatus.AVAILABLE);
        assert.strictEqual(movie.jellyfinMediaId, 'jf-movie');

        const show = await repository.findOneByOrFail({ tmdbId: SHOW_TMDB_ID });
        assert.strictEqual(show.mediaType, MediaType.TV);

        assert.strictEqual(
          await repository.count(),
          4,
          'the scan made a row for a music library item'
        );
        await assertRowsUnchanged([artist, album], before);
      });
    }
  }
});
