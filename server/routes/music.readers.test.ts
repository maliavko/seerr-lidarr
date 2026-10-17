import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it } from 'node:test';

import TheMovieDb from '@server/api/themoviedb';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import { radarrServer, sonarrServer } from '@server/test/servers';
import {
  MethodStubs,
  authenticated,
  createRoutesApp,
  loginAs,
  saveMusicRows,
} from '@server/test/musicRows';
import type { Express } from 'express';
import collectionRoutes from './collection';
import discoverRoutes from './discover';
import movieRoutes from './movie';
import personRoutes from './person';
import searchRoutes from './search';
import tvRoutes from './tv';

// The movie, TV, person, collection, discover and search routes read the media
// table through Media.getRelatedMedia and Media.getMedia by TMDB id. With a
// music artist row and a music album row in the table each answers exactly what
// it answers without them, and carries the media rows of the movies and shows it
// lists (D-84, D-8).

const MOVIE_ID = 9101;
const TV_ID = 9102;
const OTHER_MOVIE_ID = 9103;

let app: Express;

before(() => {
  app = createRoutesApp({
    '/movie': authenticated(movieRoutes),
    '/tv': authenticated(tvRoutes),
    '/person': authenticated(personRoutes),
    '/collection': authenticated(collectionRoutes),
    '/discover': authenticated(discoverRoutes),
    '/search': authenticated(searchRoutes),
  });
});

setupTestDb();

const stubs = new MethodStubs();

function movieResult(id: number) {
  return {
    id,
    media_type: 'movie',
    title: `Movie ${id}`,
    original_title: `Movie ${id}`,
    release_date: '2024-01-01',
    overview: 'overview',
    genre_ids: [],
    poster_path: '/p.jpg',
    backdrop_path: '/b.jpg',
    vote_average: 7,
    vote_count: 10,
    popularity: 1,
    adult: false,
    video: false,
    original_language: 'en',
  };
}

function tvResult(id: number) {
  return {
    id,
    media_type: 'tv',
    name: `Show ${id}`,
    original_name: `Show ${id}`,
    first_air_date: '2024-01-01',
    overview: 'overview',
    genre_ids: [],
    poster_path: '/p.jpg',
    backdrop_path: '/b.jpg',
    vote_average: 7,
    vote_count: 10,
    popularity: 1,
    original_language: 'en',
    origin_country: ['US'],
  };
}

function personResult(id: number) {
  return {
    id,
    media_type: 'person',
    name: `Person ${id}`,
    popularity: 1,
    profile_path: '/pp.jpg',
    adult: false,
    known_for: [],
  };
}

function page(results: unknown[]) {
  return { page: 1, total_pages: 1, total_results: results.length, results };
}

const MOVIES = () => page([movieResult(MOVIE_ID), movieResult(OTHER_MOVIE_ID)]);
const SHOWS = () => page([tvResult(TV_ID)]);

function movieDetails(movieId: number) {
  return {
    id: movieId,
    genres: [],
    original_language: 'en',
    overview: 'overview',
    keywords: { keywords: [] },
    external_ids: {},
    release_dates: { results: [] },
    credits: { cast: [], crew: [] },
    production_companies: [],
    production_countries: [],
    spoken_languages: [],
    videos: { results: [] },
  };
}

function tvDetails(tvId: number) {
  return {
    id: tvId,
    genres: [],
    original_language: 'en',
    overview: 'overview',
    keywords: { results: [] },
    external_ids: {},
    content_ratings: { results: [] },
    credits: { cast: [], crew: [] },
    aggregate_credits: { cast: [], crew: [] },
    seasons: [],
    networks: [],
    production_companies: [],
    production_countries: [],
    spoken_languages: [],
    origin_country: [],
    episode_run_time: [],
    created_by: [],
    videos: { results: [] },
  };
}

interface ReaderRoute {
  name: string;
  url: string;
  // the TMDB answers the route reads, by method
  tmdb: Record<string, () => unknown>;
  // ids that must carry a mediaInfo in the answer
  withMediaInfo: number[];
}

const READERS: ReaderRoute[] = [
  {
    name: 'GET /movie/:id',
    url: `/movie/${MOVIE_ID}`,
    tmdb: { getMovie: () => movieDetails(MOVIE_ID) },
    withMediaInfo: [MOVIE_ID],
  },
  {
    name: 'GET /movie/:id/recommendations',
    url: `/movie/${OTHER_MOVIE_ID}/recommendations`,
    tmdb: { getMovieRecommendations: MOVIES },
    withMediaInfo: [MOVIE_ID],
  },
  {
    name: 'GET /movie/:id/similar',
    url: `/movie/${OTHER_MOVIE_ID}/similar`,
    tmdb: { getMovieSimilar: MOVIES },
    withMediaInfo: [MOVIE_ID],
  },
  {
    name: 'GET /tv/:id',
    url: `/tv/${TV_ID}`,
    tmdb: { getTvShow: () => tvDetails(TV_ID) },
    withMediaInfo: [TV_ID],
  },
  {
    name: 'GET /tv/:id/recommendations',
    url: '/tv/9199/recommendations',
    tmdb: { getTvRecommendations: SHOWS },
    withMediaInfo: [TV_ID],
  },
  {
    name: 'GET /tv/:id/similar',
    url: '/tv/9199/similar',
    tmdb: { getTvSimilar: SHOWS },
    withMediaInfo: [TV_ID],
  },
  {
    name: 'GET /person/:id/combined_credits',
    url: '/person/9300/combined_credits',
    tmdb: {
      getPersonCombinedCredits: () => ({
        id: 9300,
        cast: [movieResult(MOVIE_ID), tvResult(TV_ID)].map((r) => ({
          ...r,
          credit_id: `c-${r.id}`,
          character: 'Someone',
        })),
        crew: [movieResult(OTHER_MOVIE_ID)].map((r) => ({
          ...r,
          credit_id: `k-${r.id}`,
          job: 'Director',
          department: 'Directing',
        })),
      }),
    },
    withMediaInfo: [MOVIE_ID, TV_ID],
  },
  {
    name: 'GET /collection/:id',
    url: '/collection/9400',
    tmdb: {
      getCollection: () => ({
        id: 9400,
        name: 'Collection',
        overview: 'overview',
        poster_path: '/p.jpg',
        backdrop_path: '/b.jpg',
        parts: [movieResult(MOVIE_ID), movieResult(OTHER_MOVIE_ID)],
      }),
    },
    withMediaInfo: [MOVIE_ID],
  },
  {
    name: 'GET /search',
    url: '/search?query=anything',
    tmdb: {
      searchMulti: () =>
        page([
          movieResult(MOVIE_ID),
          tvResult(TV_ID),
          personResult(9500),
          movieResult(OTHER_MOVIE_ID),
        ]),
    },
    withMediaInfo: [MOVIE_ID, TV_ID],
  },
  {
    name: 'GET /discover/movies',
    url: '/discover/movies',
    tmdb: { getDiscoverMovies: MOVIES },
    withMediaInfo: [MOVIE_ID],
  },
  {
    name: 'GET /discover/movies/upcoming',
    url: '/discover/movies/upcoming',
    tmdb: { getDiscoverMovies: MOVIES },
    withMediaInfo: [MOVIE_ID],
  },
  {
    name: 'GET /discover/movies/language/:language',
    url: '/discover/movies/language/en',
    tmdb: {
      getLanguages: () => [
        { iso_639_1: 'en', english_name: 'English', name: 'English' },
      ],
      getDiscoverMovies: MOVIES,
    },
    withMediaInfo: [MOVIE_ID],
  },
  {
    name: 'GET /discover/movies/genre/:genreId',
    url: '/discover/movies/genre/28',
    tmdb: {
      getMovieGenres: () => [{ id: 28, name: 'Action' }],
      getDiscoverMovies: MOVIES,
    },
    withMediaInfo: [MOVIE_ID],
  },
  {
    name: 'GET /discover/movies/studio/:studioId',
    url: '/discover/movies/studio/1',
    tmdb: {
      getStudio: () => ({
        id: 1,
        name: 'Studio',
        description: '',
        headquarters: '',
        homepage: '',
        logo_path: '',
        origin_country: 'US',
        parent_company: null,
      }),
      getDiscoverMovies: MOVIES,
    },
    withMediaInfo: [MOVIE_ID],
  },
  {
    name: 'GET /discover/tv',
    url: '/discover/tv',
    tmdb: { getDiscoverTv: SHOWS },
    withMediaInfo: [TV_ID],
  },
  {
    name: 'GET /discover/tv/upcoming',
    url: '/discover/tv/upcoming',
    tmdb: { getDiscoverTv: SHOWS },
    withMediaInfo: [TV_ID],
  },
  {
    name: 'GET /discover/tv/language/:language',
    url: '/discover/tv/language/en',
    tmdb: {
      getLanguages: () => [
        { iso_639_1: 'en', english_name: 'English', name: 'English' },
      ],
      getDiscoverTv: SHOWS,
    },
    withMediaInfo: [TV_ID],
  },
  {
    name: 'GET /discover/tv/genre/:genreId',
    url: '/discover/tv/genre/18',
    tmdb: {
      getTvGenres: () => [{ id: 18, name: 'Drama' }],
      getDiscoverTv: SHOWS,
    },
    withMediaInfo: [TV_ID],
  },
  {
    name: 'GET /discover/tv/network/:networkId',
    url: '/discover/tv/network/1',
    tmdb: {
      getNetwork: () => ({
        id: 1,
        name: 'Network',
        headquarters: '',
        homepage: '',
        logo_path: '',
        origin_country: 'US',
      }),
      getDiscoverTv: SHOWS,
    },
    withMediaInfo: [TV_ID],
  },
  {
    name: 'GET /discover/trending',
    url: '/discover/trending',
    tmdb: {
      getAllTrending: () =>
        page([
          movieResult(MOVIE_ID),
          tvResult(TV_ID),
          personResult(9500),
          movieResult(OTHER_MOVIE_ID),
        ]),
    },
    withMediaInfo: [MOVIE_ID, TV_ID],
  },
  {
    name: 'GET /discover/keyword/:keywordId/movies',
    url: '/discover/keyword/1/movies',
    tmdb: {
      getKeywordDetails: () => ({ id: 1, name: 'keyword' }),
      getMoviesByKeyword: MOVIES,
    },
    withMediaInfo: [MOVIE_ID],
  },
];

async function saveMovieAndTv() {
  const repository = getRepository(Media);

  await repository.save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: MOVIE_ID,
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.UNKNOWN,
    })
  );
  await repository.save(
    new Media({
      mediaType: MediaType.TV,
      tmdbId: TV_ID,
      status: MediaStatus.PROCESSING,
      status4k: MediaStatus.UNKNOWN,
    })
  );
}

function hasMediaInfo(body: unknown, tmdbId: number): boolean {
  const walk = (value: unknown): boolean => {
    if (Array.isArray(value)) {
      return value.some(walk);
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const info = record.mediaInfo as { tmdbId?: number } | undefined;
      if (record.id === tmdbId && info && info.tmdbId === tmdbId) {
        return true;
      }
      return Object.values(record).some(walk);
    }
    return false;
  };

  return walk(body);
}

describe('Routes that read the media table by TMDB id, with music rows in it', () => {
  beforeEach(() => {
    stubs.restore();
    getSettings().radarr = [radarrServer()];
    getSettings().sonarr = [sonarrServer()];
  });

  afterEach(() => {
    stubs.restore();
  });

  for (const reader of READERS) {
    it(`${reader.name} answers what it answers without them, with its media rows`, async () => {
      for (const [method, answer] of Object.entries(reader.tmdb)) {
        stubs.stub(TheMovieDb.prototype, method, async () => answer());
      }
      await saveMovieAndTv();
      const agent = await loginAs(app);

      const without = await agent.get(reader.url);
      assert.strictEqual(without.status, 200, JSON.stringify(without.body));
      for (const id of reader.withMediaInfo) {
        assert.ok(
          hasMediaInfo(without.body, id),
          `${reader.url} carries no mediaInfo for ${id} without music rows: the case proves nothing`
        );
      }

      const { artist, album } = await saveMusicRows();
      const withMusic = await agent.get(reader.url);

      assert.strictEqual(withMusic.status, 200, JSON.stringify(withMusic.body));
      assert.deepStrictEqual(withMusic.body, without.body);
      const serialised = JSON.stringify(withMusic.body);
      assert.ok(!serialised.includes('musicBrainzId'));
      assert.ok(!serialised.includes(artist.musicBrainzId as string));
      assert.ok(!serialised.includes(album.musicBrainzId as string));
    });
  }
});
