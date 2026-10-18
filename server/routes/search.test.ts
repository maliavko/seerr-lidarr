import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import ExternalAPI from '@server/api/externalapi';
import type { LidarrAlbum, LidarrArtist } from '@server/api/servarr/lidarr';
import LidarrAPI from '@server/api/servarr/lidarr';
import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieResult,
  TmdbPersonResult,
  TmdbSearchMultiResponse,
  TmdbTvResult,
} from '@server/api/themoviedb/interfaces';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
  MusicKind,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import cacheManager from '@server/lib/cache';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { mapAlbumResult, mapArtistResult } from '@server/models/Search';
import { setupTestDb } from '@server/test/db';
import {
  MethodStubs,
  authenticated,
  createRoutesApp,
  loginAs,
} from '@server/test/musicRows';
import { radarrServer, sonarrServer } from '@server/test/servers';
import type { Express } from 'express';
import { Router } from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import searchRoutes from './search';

const API_SPEC_PATH = join(__dirname, '../../seerr-api.yml');

const RADIOHEAD = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const OK_COMPUTER = 'b1392450-e666-3926-a536-22c65f834433';

const lidarrFixture = <T>(name: string): T =>
  JSON.parse(
    readFileSync(
      join(
        __dirname,
        '..',
        'api',
        'servarr',
        'lidarr.fixtures',
        `${name}.json`
      ),
      'utf8'
    )
  ) as T;

const server = {
  id: 1,
  name: 'Test Lidarr',
  hostname: '127.0.0.1',
  port: 18686,
  apiKey: 'test-key',
  useSsl: false,
  baseUrl: '',
  activeProfileId: 1,
  activeProfileName: 'Any',
  activeMetadataProfileId: 1,
  activeMetadataProfileName: 'Standard',
  activeDirectory: '/music',
  isDefault: true,
};

const movie: TmdbMovieResult = {
  id: 11,
  media_type: 'movie',
  adult: false,
  genre_ids: [18],
  original_language: 'en',
  original_title: 'Original Movie',
  overview: 'A movie.',
  popularity: 10,
  release_date: '1999-03-31',
  title: 'Movie',
  video: false,
  vote_average: 7.5,
  vote_count: 100,
  backdrop_path: '/movie-backdrop.jpg',
  poster_path: '/movie-poster.jpg',
};

const tv: TmdbTvResult = {
  id: 22,
  media_type: 'tv',
  first_air_date: '2001-01-01',
  genre_ids: [10765],
  name: 'Show',
  origin_country: ['US'],
  original_language: 'en',
  original_name: 'Original Show',
  overview: 'A show.',
  popularity: 20,
  vote_average: 8,
  vote_count: 200,
  backdrop_path: '/tv-backdrop.jpg',
  poster_path: '/tv-poster.jpg',
};

const person: TmdbPersonResult = {
  id: 33,
  media_type: 'person',
  name: 'Person',
  popularity: 5,
  adult: false,
  profile_path: '/person.jpg',
  known_for: [movie, tv],
};

// what the search answers today for those three TMDB results (D-8), written
// out whole
const MOVIE_ANSWER = {
  id: 11,
  mediaType: 'movie',
  adult: false,
  genreIds: [18],
  originalLanguage: 'en',
  originalTitle: 'Original Movie',
  overview: 'A movie.',
  popularity: 10,
  releaseDate: '1999-03-31',
  title: 'Movie',
  video: false,
  voteAverage: 7.5,
  voteCount: 100,
  backdropPath: '/movie-backdrop.jpg',
  posterPath: '/movie-poster.jpg',
};

const TV_ANSWER = {
  id: 22,
  firstAirDate: '2001-01-01',
  genreIds: [10765],
  mediaType: 'tv',
  name: 'Show',
  originCountry: ['US'],
  originalLanguage: 'en',
  originalName: 'Original Show',
  overview: 'A show.',
  popularity: 20,
  voteAverage: 8,
  voteCount: 200,
  backdropPath: '/tv-backdrop.jpg',
  posterPath: '/tv-poster.jpg',
};

const PERSON_ANSWER = {
  id: 33,
  name: 'Person',
  popularity: 5,
  adult: false,
  mediaType: 'person',
  profilePath: '/person.jpg',
  knownFor: [{ ...MOVIE_ANSWER, mediaType: 'movie' }, { ...TV_ANSWER }],
};

const tmdbPage = (
  page: number,
  overrides: Partial<TmdbSearchMultiResponse> = {}
): TmdbSearchMultiResponse => ({
  page,
  total_pages: 3,
  total_results: 60,
  results: [movie, tv, person],
  ...overrides,
});

const artistFixture = () => lidarrFixture<LidarrArtist[]>('artist-lookup-term');
const albumFixture = () => lidarrFixture<LidarrAlbum[]>('album-lookup-term');

let app: Express;
const stubs = new MethodStubs();
let tmdbCalls: unknown[][];
let lidarrCalls: string[];

// The search route behind authentication with the OpenAPI validator of
// server/index.ts in front of it, validating what it answers too, so that
// seerr-api.yml is held to describe the answers (PIL-API).
function createApp(): Express {
  const api = Router();
  api.use(
    OpenApiValidator.middleware({
      apiSpec: API_SPEC_PATH,
      validateRequests: true,
      validateResponses: true,
      validateSecurity: false,
    })
  );
  api.use((_req, res, next) => {
    const original = res.json;
    res.json = function json(body) {
      return original.call(this, JSON.parse(JSON.stringify(body)));
    };
    next();
  });
  api.use('/search', searchRoutes);

  return createRoutesApp({ '/api/v1': authenticated(api) });
}

before(() => {
  app = createApp();
});

setupTestDb();

function tmdbAnswers(answer: () => Promise<TmdbSearchMultiResponse>) {
  stubs.stub(TheMovieDb.prototype, 'searchMulti', async (...args) => {
    tmdbCalls.push(args);
    return answer();
  });
}

function lidarrAnswers(
  artists: LidarrArtist[] | Error,
  albums: LidarrAlbum[] | Error
) {
  const reply =
    <T>(call: string, value: T | Error) =>
    (term: string) => {
      lidarrCalls.push(`${call} ${term}`);
      return value instanceof Error
        ? Promise.reject(value)
        : Promise.resolve(value);
    };

  mock.method(LidarrAPI.prototype, 'lookupArtists', reply('artists', artists));
  mock.method(LidarrAPI.prototype, 'lookupAlbums', reply('albums', albums));
}

beforeEach(() => {
  tmdbCalls = [];
  lidarrCalls = [];
  getSettings().radarr = [radarrServer()];
  getSettings().sonarr = [sonarrServer()];
  getSettings().lidarr = [{ ...server }];
  cacheManager.getCache('lidarr').flush();
});

afterEach(() => {
  stubs.restore();
  mock.restoreAll();
});

async function search(query: string, page?: number) {
  const agent = await loginAs(app);

  return agent.get(
    `/api/v1/search?query=${encodeURIComponent(query)}${page ? `&page=${page}` : ''}`
  );
}

describe('GET /search with a default Lidarr server', () => {
  it('adds the artists and then the albums after the results of TMDB on the first page, counted in totalResults', async () => {
    tmdbAnswers(async () => tmdbPage(1));
    lidarrAnswers(artistFixture(), albumFixture());

    const res = await search('radiohead', 1);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.page, 1);
    assert.strictEqual(res.body.totalPages, 3);
    assert.strictEqual(res.body.totalResults, 60 + 3 + 2);
    assert.deepStrictEqual(
      res.body.results.map((r: { mediaType: string }) => r.mediaType),
      ['movie', 'tv', 'person', 'artist', 'artist', 'artist', 'album', 'album']
    );
    assert.deepStrictEqual(res.body.results.slice(0, 3), [
      MOVIE_ANSWER,
      TV_ANSWER,
      PERSON_ANSWER,
    ]);
    assert.deepStrictEqual(lidarrCalls.sort(), [
      'albums radiohead',
      'artists radiohead',
    ]);
    assert.strictEqual(tmdbCalls.length, 1);
  });

  it('answers an artist as {id, mediaType, name, overview, imageUrl} and an album as {id, mediaType, title, artistId, artistName, releaseDate, albumType, coverUrl}', async () => {
    tmdbAnswers(async () => tmdbPage(1));
    const artists = artistFixture();
    const albums = albumFixture();
    lidarrAnswers(artists, albums);

    const res = await search('radiohead', 1);

    assert.strictEqual(res.status, 200);
    const [artist, , , album] = res.body.results.slice(3);

    // the overview is the service's summary's to carry (see the work log)
    const { overview, ...artistFields } = artist;
    assert.ok(overview === undefined || typeof overview === 'string');
    assert.deepStrictEqual(artistFields, {
      id: RADIOHEAD,
      mediaType: 'artist',
      name: 'Radiohead',
      imageUrl:
        'https://images.lidarr.audio/cache/https://assets.fanart.tv/fanart/radiohead-4faa76dca1bba.jpg',
    });
    assert.deepStrictEqual(album, {
      id: OK_COMPUTER,
      mediaType: 'album',
      title: 'OK Computer',
      artistId: RADIOHEAD,
      artistName: 'Radiohead',
      releaseDate: '1997-05-21T00:00:00Z',
      albumType: 'Album',
      coverUrl: albums[0].images?.find((i) => i.coverType === 'cover')
        ?.remoteUrl,
    });
    assert.ok(!('mediaInfo' in artist) && !('mediaInfo' in album));
  });

  it('gives each music result the media row of its id and kind as its mediaInfo, and none where there is no row', async () => {
    tmdbAnswers(async () => tmdbPage(1));
    lidarrAnswers(artistFixture(), albumFixture());
    const repository = getRepository(Media);
    const artistRow = await repository.save(
      new Media({
        mediaType: MediaType.MUSIC,
        musicBrainzId: RADIOHEAD,
        musicKind: MusicKind.ARTIST,
        status: MediaStatus.PARTIALLY_AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    const albumRow = await repository.save(
      new Media({
        mediaType: MediaType.MUSIC,
        musicBrainzId: OK_COMPUTER,
        musicKind: MusicKind.ALBUM,
        artistMusicBrainzId: RADIOHEAD,
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    // a row of the same id and the other kind stands for neither
    await repository.save(
      new Media({
        mediaType: MediaType.MUSIC,
        musicBrainzId: OK_COMPUTER,
        musicKind: MusicKind.ARTIST,
        status: MediaStatus.PENDING,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    const res = await search('radiohead', 1);

    assert.strictEqual(res.status, 200);
    const results = res.body.results;
    const artist = results.find(
      (r: { id: string; mediaType: string }) =>
        r.mediaType === 'artist' && r.id === RADIOHEAD
    );
    const album = results.find(
      (r: { id: string; mediaType: string }) =>
        r.mediaType === 'album' && r.id === OK_COMPUTER
    );

    assert.strictEqual(artist.mediaInfo.id, artistRow.id);
    assert.strictEqual(
      artist.mediaInfo.status,
      MediaStatus.PARTIALLY_AVAILABLE
    );
    assert.strictEqual(artist.mediaInfo.musicBrainzId, RADIOHEAD);
    assert.strictEqual(artist.mediaInfo.musicKind, 'artist');
    assert.strictEqual(album.mediaInfo.id, albumRow.id);
    assert.strictEqual(album.mediaInfo.status, MediaStatus.AVAILABLE);
    assert.strictEqual(album.mediaInfo.artistMusicBrainzId, RADIOHEAD);
    assert.strictEqual(
      results.filter((r: { mediaInfo?: unknown }) => r.mediaInfo).length,
      2
    );
  });

  it('counts music in totalResults and keeps totalPages at least 1 where TMDB found nothing', async () => {
    tmdbAnswers(async () =>
      tmdbPage(1, { total_pages: 0, total_results: 0, results: [] })
    );
    lidarrAnswers(artistFixture(), albumFixture());

    const res = await search('radiohead', 1);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.totalPages, 1);
    assert.strictEqual(res.body.totalResults, 5);
    assert.strictEqual(res.body.results.length, 5);
  });

  it('adds no music on a later page, and asks Lidarr nothing', async () => {
    tmdbAnswers(async () => tmdbPage(2));
    lidarrAnswers(artistFixture(), albumFixture());

    const res = await search('radiohead', 2);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, {
      page: 2,
      totalPages: 3,
      totalResults: 60,
      results: [MOVIE_ANSWER, TV_ANSWER, PERSON_ANSWER],
    });
    assert.deepStrictEqual(lidarrCalls, []);
  });

  it('adds no music to an id search, and asks Lidarr nothing', async () => {
    stubs.stub(TheMovieDb.prototype, 'getMovie', async () => ({
      id: 603,
      genres: [],
      title: 'The Matrix',
      overview: '',
      original_title: 'The Matrix',
      release_date: '1999-03-31',
      adult: false,
      video: false,
      popularity: 1,
      vote_average: 1,
      vote_count: 1,
      original_language: 'en',
    }));
    stubs.stub(TheMovieDb.prototype, 'getTvShow', async () => {
      throw new Error('not a show');
    });
    stubs.stub(TheMovieDb.prototype, 'getPerson', async () => {
      throw new Error('not a person');
    });
    lidarrAnswers(artistFixture(), albumFixture());

    const res = await search('tmdb:603', 1);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(
      res.body.results.map((r: { mediaType: string }) => r.mediaType),
      ['movie']
    );
    assert.strictEqual(res.body.totalResults, 1);
    assert.deepStrictEqual(lidarrCalls, []);
  });

  it('answers the artists alone when the album lookup fails, the albums alone when the artist lookup fails', async () => {
    tmdbAnswers(async () => tmdbPage(1));

    lidarrAnswers(artistFixture(), new Error('Lidarr is down'));
    const first = await search('radiohead', 1);

    assert.strictEqual(first.status, 200);
    assert.deepStrictEqual(
      first.body.results
        .slice(3)
        .map((r: { mediaType: string }) => r.mediaType),
      ['artist', 'artist', 'artist']
    );
    assert.strictEqual(first.body.totalResults, 63);

    mock.restoreAll();
    cacheManager.getCache('lidarr').flush();
    lidarrAnswers(new Error('Lidarr is down'), albumFixture());
    const second = await search('radiohead', 1);

    assert.deepStrictEqual(
      second.body.results
        .slice(3)
        .map((r: { mediaType: string }) => r.mediaType),
      ['album', 'album']
    );
    assert.strictEqual(second.body.totalResults, 62);
  });

  it('answers a TMDB failure as it does today, 500, music or not', async () => {
    tmdbAnswers(async () => {
      throw new Error('TMDB is down');
    });
    lidarrAnswers(artistFixture(), albumFixture());

    const res = await search('radiohead', 1);

    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.body.message, 'Unable to retrieve search results.');
  });
});

describe('the music of a search where reading it fails', () => {
  it('leaves the other results as they are when the media rows of the music cannot be read', async () => {
    tmdbAnswers(async () => tmdbPage(1));
    lidarrAnswers(artistFixture(), albumFixture());
    mock.method(Media, 'getRelatedMusicMedia', async () => {
      throw new Error('database is gone');
    });

    const res = await search('radiohead', 1);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, {
      page: 1,
      totalPages: 3,
      totalResults: 60,
      results: [MOVIE_ANSWER, TV_ANSWER, PERSON_ANSWER],
    });
  });
});

describe('mapArtistResult and mapAlbumResult', () => {
  it('carry an artist summary of an overview into the result', () => {
    assert.deepStrictEqual(
      mapArtistResult({
        id: RADIOHEAD,
        name: 'Radiohead',
        inLidarr: false,
        overview: 'An English rock band.',
        imageUrl: 'https://example.test/a.jpg',
      }),
      {
        id: RADIOHEAD,
        mediaType: 'artist',
        name: 'Radiohead',
        overview: 'An English rock band.',
        imageUrl: 'https://example.test/a.jpg',
        mediaInfo: undefined,
      }
    );
  });

  it('leave an album without its artist or cover as a result without them', () => {
    assert.deepStrictEqual(
      mapAlbumResult({
        id: OK_COMPUTER,
        title: 'OK Computer',
        secondaryTypes: [],
        inLidarr: false,
      }),
      {
        id: OK_COMPUTER,
        mediaType: 'album',
        title: 'OK Computer',
        artistId: undefined,
        artistName: undefined,
        releaseDate: undefined,
        albumType: undefined,
        coverUrl: undefined,
        mediaInfo: undefined,
      }
    );
  });
});

describe('GET /search answers exactly as today with no music', () => {
  const TODAY = {
    page: 1,
    totalPages: 3,
    totalResults: 60,
    results: [MOVIE_ANSWER, TV_ANSWER, PERSON_ANSWER],
  };

  it('with no Lidarr server saved, asking Lidarr nothing', async () => {
    getSettings().lidarr = [];
    tmdbAnswers(async () => tmdbPage(1));
    lidarrAnswers(artistFixture(), albumFixture());

    const res = await search('radiohead', 1);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, TODAY);
    assert.deepStrictEqual(lidarrCalls, []);
  });

  it('with Lidarr servers none of which is the default', async () => {
    getSettings().lidarr = [{ ...server, isDefault: false }];
    tmdbAnswers(async () => tmdbPage(1));
    lidarrAnswers(artistFixture(), albumFixture());

    const res = await search('radiohead', 1);

    assert.deepStrictEqual(res.body, TODAY);
    assert.deepStrictEqual(lidarrCalls, []);
  });

  it('with Lidarr failing on both lookups', async () => {
    tmdbAnswers(async () => tmdbPage(1));
    lidarrAnswers(new Error('Lidarr is down'), new Error('Lidarr is down'));

    const res = await search('radiohead', 1);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, TODAY);
  });

  it('with Lidarr finding nothing', async () => {
    tmdbAnswers(async () => tmdbPage(1));
    lidarrAnswers([], []);

    const res = await search('zzzzqqqq', 1);

    assert.deepStrictEqual(res.body, TODAY);
  });

  it('for a movie and a TV show with media rows, whose mediaInfo carries no music key', async () => {
    const repository = getRepository(Media);
    await repository.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 11,
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    await repository.save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId: 22,
        tvdbId: 77,
        status: MediaStatus.PARTIALLY_AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    tmdbAnswers(async () => tmdbPage(1));

    lidarrAnswers(artistFixture(), albumFixture());
    const withMusic = await search('radiohead', 1);
    mock.restoreAll();
    getSettings().lidarr = [];
    const without = await search('radiohead', 1);

    assert.strictEqual(withMusic.status, 200);
    assert.deepStrictEqual(
      withMusic.body.results.slice(0, 3),
      without.body.results
    );
    const [movieResult, tvResult] = without.body.results;
    assert.strictEqual(movieResult.mediaInfo.tmdbId, 11);
    assert.strictEqual(tvResult.mediaInfo.tvdbId, 77);
    for (const result of [movieResult, tvResult]) {
      for (const key of ['musicBrainzId', 'musicKind', 'artistMusicBrainzId']) {
        assert.ok(!(key in result.mediaInfo), `${key} on a movie or TV row`);
      }
    }
  });
});

// ---- the type and the kinds shown (F2-D-21, F2-D-31) ----

type Source = 'searchMulti' | 'searchMovies' | 'searchTvShows' | 'searchPerson';

const SOURCES: Source[] = [
  'searchMulti',
  'searchMovies',
  'searchTvShows',
  'searchPerson',
];

// every TMDB source answers its own page; the sources called are recorded
let sourceCalls: { source: Source; args: unknown[] }[];

function tmdbSources(
  pages: Partial<Record<Source, TmdbSearchMultiResponse | Error>> = {}
) {
  const defaults: Record<Source, TmdbSearchMultiResponse> = {
    searchMulti: tmdbPage(1),
    searchMovies: tmdbPage(1, { results: [movie], total_pages: 4 }),
    searchTvShows: tmdbPage(1, { results: [tv], total_pages: 5 }),
    searchPerson: tmdbPage(1, { results: [person], total_pages: 6 }),
  };

  for (const source of SOURCES) {
    stubs.stub(TheMovieDb.prototype, source, async (...args) => {
      sourceCalls.push({ source, args });
      const answer = pages[source] ?? defaults[source];

      if (answer instanceof Error) {
        throw answer;
      }

      return answer;
    });
  }
}

const calledSources = () => sourceCalls.map((call) => call.source);

async function searchWith(params: Record<string, string | number>) {
  const agent = await loginAs(app);
  const query = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join('&');

  return agent.get(`/api/v1/search?${query}`);
}

const kindsOf = (res: { body: { results: { mediaType: string }[] } }) =>
  res.body.results.map((r) => r.mediaType);

function servers(shown: { movie?: boolean; tv?: boolean; music?: boolean }) {
  const settings = getSettings();
  settings.radarr = shown.movie ? [radarrServer()] : [];
  settings.sonarr = shown.tv ? [sonarrServer()] : [];
  settings.lidarr = shown.music ? [{ ...server }] : [];
}

// what TheMovieDb throws for an id TMDB does not hold: its error with the
// answer's 404 beneath it as the cause
const tmdbNotFound = () =>
  new Error(
    '[TMDB] Failed to fetch details: Request failed with status code 404',
    {
      cause: Object.assign(new Error('Request failed with status code 404'), {
        response: { status: 404 },
      }),
    }
  );

describe('GET /search by type', () => {
  beforeEach(() => {
    sourceCalls = [];
  });

  it('reads each type from its own source and from no other, with that source page and page count', async () => {
    const expected: [string, Source, string, number][] = [
      ['movie', 'searchMovies', 'movie', 4],
      ['tv', 'searchTvShows', 'tv', 5],
      ['person', 'searchPerson', 'person', 6],
    ];

    for (const [type, source, kind, totalPages] of expected) {
      sourceCalls = [];
      lidarrCalls = [];
      tmdbSources();
      lidarrAnswers(artistFixture(), albumFixture());

      const res = await searchWith({ query: 'matrix', type, page: 2 });

      assert.strictEqual(res.status, 200, type);
      assert.deepStrictEqual(calledSources(), [source], type);
      assert.deepStrictEqual(lidarrCalls, [], type);
      assert.deepStrictEqual(kindsOf(res), [kind], type);
      assert.strictEqual(res.body.totalPages, totalPages, type);
      assert.strictEqual(res.body.totalResults, 60, type);
      // the page asked and the query go to the source
      assert.deepStrictEqual(
        (sourceCalls[0].args[0] as { query: string; page: number }).query,
        'matrix'
      );
      assert.strictEqual((sourceCalls[0].args[0] as { page: number }).page, 2);
      mock.restoreAll();
      stubs.restore();
    }
  });

  it('answers a typed TMDB result as the kind of its type, with its media row as today', async () => {
    await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 11,
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    tmdbSources();

    const res = await searchWith({ query: 'movie', type: 'movie' });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.results, [
      {
        ...MOVIE_ANSWER,
        mediaInfo: res.body.results[0].mediaInfo,
      },
    ]);
    assert.strictEqual(res.body.results[0].mediaInfo.tmdbId, 11);
    assert.strictEqual(
      res.body.results[0].mediaInfo.status,
      MediaStatus.AVAILABLE
    );
  });

  it('answers the results of TMDB own searches of movies, TV and people, which carry no media_type, as the kind of their type', async () => {
    // TMDB's /search/movie, /search/tv and /search/person do not set
    // media_type (only /search/multi does); the route sets it from the type
    const bare = <T extends { media_type?: string }>(result: T) => {
      const copy = { ...result };
      delete copy.media_type;
      return copy;
    };
    const cases: [string, Source, TmdbSearchMultiResponse['results']][] = [
      ['movie', 'searchMovies', [bare(movie)] as never],
      ['tv', 'searchTvShows', [bare(tv)] as never],
      ['person', 'searchPerson', [bare(person)] as never],
    ];

    for (const [type, source, results] of cases) {
      sourceCalls = [];
      tmdbSources({ [source]: tmdbPage(1, { results, total_pages: 3 }) });

      const res = await searchWith({ query: 'matrix', type });

      assert.strictEqual(res.status, 200, type);
      assert.deepStrictEqual(kindsOf(res), [type], type);
      assert.strictEqual(res.body.totalPages, 3, type);
      mock.restoreAll();
      stubs.restore();
    }
  });

  it('answers the type music as page 1 of 1 of the default Lidarr artists and then albums, TMDB unread', async () => {
    tmdbSources();
    lidarrAnswers(artistFixture(), albumFixture());

    const res = await searchWith({ query: 'radiohead', type: 'music' });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(calledSources(), []);
    assert.deepStrictEqual(kindsOf(res), [
      'artist',
      'artist',
      'artist',
      'album',
      'album',
    ]);
    assert.strictEqual(res.body.page, 1);
    assert.strictEqual(res.body.totalPages, 1);
    assert.strictEqual(res.body.totalResults, 5);
  });

  it('answers a later page of the type music as no results of 1 page, asking Lidarr nothing', async () => {
    tmdbSources();
    lidarrAnswers(artistFixture(), albumFixture());

    const res = await searchWith({
      query: 'radiohead',
      type: 'music',
      page: 2,
    });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, {
      page: 2,
      totalPages: 1,
      totalResults: 0,
      results: [],
    });
    assert.deepStrictEqual(lidarrCalls, []);
    assert.deepStrictEqual(calledSources(), []);
  });

  it('answers a type whose kind is not shown as no type', async () => {
    const hidden: [string, Parameters<typeof servers>[0]][] = [
      ['movie', { tv: true, music: true }],
      ['tv', { movie: true, music: true }],
      ['music', { movie: true, tv: true }],
      ['person', { music: true }],
    ];

    for (const [type, shown] of hidden) {
      sourceCalls = [];
      lidarrCalls = [];
      servers(shown);
      tmdbSources();
      lidarrAnswers(artistFixture(), albumFixture());

      const typed = await searchWith({ query: 'radiohead', type, page: 1 });
      const untyped = await searchWith({ query: 'radiohead', page: 1 });

      assert.strictEqual(typed.status, 200, type);
      assert.deepStrictEqual(typed.body, untyped.body, type);
      if (type !== 'person') {
        assert.ok(
          calledSources().every((source) => source === 'searchMulti'),
          `${type}: ${calledSources()}`
        );
      }
      mock.restoreAll();
      stubs.restore();
      cacheManager.getCache('lidarr').flush();
    }
  });

  it('reads a hidden person type as music where only music is shown, not as a TMDB search', async () => {
    servers({ music: true });
    tmdbSources();
    lidarrAnswers(artistFixture(), albumFixture());

    const res = await searchWith({ query: 'radiohead', type: 'person' });

    assert.deepStrictEqual(calledSources(), []);
    assert.deepStrictEqual(kindsOf(res), [
      'artist',
      'artist',
      'artist',
      'album',
      'album',
    ]);
  });

  it('answers a type of an id query as that type of its provider results only', async () => {
    tmdbSources();
    stubs.stub(TheMovieDb.prototype, 'getMovie', async () => ({
      id: 603,
      genres: [],
      title: 'The Matrix',
      overview: '',
      original_title: 'The Matrix',
      release_date: '1999-03-31',
      adult: false,
      video: false,
      popularity: 1,
      vote_average: 1,
      vote_count: 1,
      original_language: 'en',
    }));
    stubs.stub(TheMovieDb.prototype, 'getTvShow', async () => ({
      id: 603,
      name: 'Matrix Show',
      genres: [],
      overview: '',
      original_name: 'Matrix Show',
      first_air_date: '2001-01-01',
      popularity: 1,
      vote_average: 1,
      vote_count: 1,
      original_language: 'en',
      origin_country: [],
      number_of_seasons: 1,
    }));
    stubs.stub(TheMovieDb.prototype, 'getPerson', async () => {
      throw tmdbNotFound();
    });
    lidarrAnswers(artistFixture(), albumFixture());

    const untyped = await searchWith({ query: 'tmdb:603' });
    const movieOnly = await searchWith({ query: 'tmdb:603', type: 'movie' });
    const tvOnly = await searchWith({ query: 'tmdb:603', type: 'tv' });
    const personOnly = await searchWith({ query: 'tmdb:603', type: 'person' });

    assert.deepStrictEqual(kindsOf(untyped).sort(), ['movie', 'tv']);
    assert.deepStrictEqual(kindsOf(movieOnly), ['movie']);
    assert.deepStrictEqual(kindsOf(tvOnly), ['tv']);
    assert.deepStrictEqual(kindsOf(personOnly), []);
    assert.deepStrictEqual(movieOnly.body.page, 1);
    assert.deepStrictEqual(movieOnly.body.totalPages, 1);
    // an id query is read from its id provider, no search source is read
    assert.deepStrictEqual(calledSources(), []);
    assert.deepStrictEqual(lidarrCalls, []);
  });

  it('answers the type music of an id query by Lidarr search of the query, reading no id provider', async () => {
    tmdbSources();
    const getMovie = stubs.stub(TheMovieDb.prototype, 'getMovie', async () => {
      throw new Error('read');
    });
    lidarrAnswers(artistFixture(), albumFixture());

    const res = await searchWith({ query: 'tmdb:603', type: 'music' });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(lidarrCalls.sort(), [
      'albums tmdb:603',
      'artists tmdb:603',
    ]);
    assert.deepStrictEqual(getMovie.calls, []);
    assert.deepStrictEqual(calledSources(), []);
  });

  it('accepts each of movie, tv, music and person as type and refuses another, in seerr-api.yml', async () => {
    tmdbSources();
    lidarrAnswers([], []);

    for (const type of ['movie', 'tv', 'music', 'person']) {
      const res = await searchWith({ query: 'x', type });
      assert.strictEqual(res.status, 200, type);
    }
    for (const type of ['artist', 'album', 'all', '', 'Movie']) {
      const res = await searchWith({ query: 'x', type });
      assert.strictEqual(res.status, 400, `type=${type}`);
    }
  });
});

describe('GET /search leaves out the kinds not shown', () => {
  beforeEach(() => {
    sourceCalls = [];
  });

  it('leaves out each result of a kind not shown from the mixed search, keeping the page, the page count and the total as read', async () => {
    const cases: [Parameters<typeof servers>[0], string[]][] = [
      [{ movie: true }, ['movie', 'person']],
      [{ tv: true }, ['tv', 'person']],
      [{ movie: true, tv: true }, ['movie', 'tv', 'person']],
      [
        { movie: true, music: true },
        ['movie', 'person', 'artist', 'artist', 'artist', 'album', 'album'],
      ],
    ];

    for (const [shown, kinds] of cases) {
      servers(shown);
      tmdbSources();
      lidarrAnswers(artistFixture(), albumFixture());

      const res = await searchWith({ query: 'radiohead', page: 1 });

      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(kindsOf(res), kinds, JSON.stringify(shown));
      assert.strictEqual(res.body.page, 1);
      assert.strictEqual(res.body.totalPages, 3);
      assert.strictEqual(
        res.body.totalResults,
        60 + (shown.music ? 5 : 0),
        JSON.stringify(shown)
      );
      mock.restoreAll();
      stubs.restore();
      cacheManager.getCache('lidarr').flush();
    }
  });

  it('keeps the page and the page count of a page the filtering empties', async () => {
    servers({ movie: true });
    tmdbSources({
      searchMulti: tmdbPage(2, { results: [tv, tv], total_pages: 7 }),
    });

    const res = await searchWith({ query: 'shows', page: 2 });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, {
      page: 2,
      totalPages: 7,
      totalResults: 60,
      results: [],
    });
  });

  it('leaves out the artists and albums of an id search path and of every type where music is not shown', async () => {
    servers({ movie: true, tv: true });
    tmdbSources();
    lidarrAnswers(artistFixture(), albumFixture());

    const res = await searchWith({ query: 'radiohead', page: 1 });

    assert.deepStrictEqual(kindsOf(res), ['movie', 'tv', 'person']);
    assert.deepStrictEqual(lidarrCalls, []);
  });

  it('reads no TMDB and no id provider where neither movie nor tv is shown, music shown: the answer of the type music', async () => {
    servers({ music: true });
    tmdbSources();
    const providers = [
      'getMovie',
      'getTvShow',
      'getPerson',
      'getByExternalId',
    ].map((name) =>
      stubs.stub(TheMovieDb.prototype, name, async () => {
        throw new Error('read');
      })
    );
    lidarrAnswers(artistFixture(), albumFixture());

    const plain = await searchWith({ query: 'radiohead', page: 1 });
    const later = await searchWith({ query: 'radiohead', page: 3 });
    const byId = await searchWith({ query: 'tmdb:603', page: 1 });
    const typed = await searchWith({ query: 'radiohead', type: 'music' });

    assert.deepStrictEqual(calledSources(), []);
    for (const provider of providers) {
      assert.deepStrictEqual(provider.calls, []);
    }
    assert.deepStrictEqual(plain.body, typed.body);
    assert.strictEqual(plain.body.totalPages, 1);
    assert.strictEqual(plain.body.results.length, 5);
    assert.deepStrictEqual(later.body, {
      page: 3,
      totalPages: 1,
      totalResults: 0,
      results: [],
    });
    assert.strictEqual(byId.status, 200);
  });

  it('reads no source at all where no kind is shown: page 1 of 1 and no results, for every type and every query', async () => {
    servers({});
    tmdbSources();
    lidarrAnswers(artistFixture(), albumFixture());
    const getMovie = stubs.stub(TheMovieDb.prototype, 'getMovie', async () => {
      throw new Error('read');
    });

    const paramSets: Record<string, string | number>[] = [
      { query: 'radiohead' },
      { query: 'radiohead', page: 4 },
      { query: 'radiohead', type: 'movie' },
      { query: 'radiohead', type: 'tv' },
      { query: 'radiohead', type: 'music' },
      { query: 'radiohead', type: 'person' },
      { query: 'tmdb:603' },
    ];
    for (const params of paramSets) {
      const res = await searchWith(params);

      assert.strictEqual(res.status, 200, JSON.stringify(params));
      assert.deepStrictEqual(
        res.body,
        { page: 1, totalPages: 1, totalResults: 0, results: [] },
        JSON.stringify(params)
      );
    }
    assert.deepStrictEqual(calledSources(), []);
    assert.deepStrictEqual(lidarrCalls, []);
    assert.deepStrictEqual(getMovie.calls, []);
  });
});

// ---- where the source an answer is read from fails (F2-D-401) ----

const DOWN = () => new Error('TMDB is down');
const LIDARR_DOWN = () => new Error('Lidarr is down');

const nothing = (overrides: Partial<TmdbSearchMultiResponse> = {}) =>
  tmdbPage(1, {
    results: [],
    total_pages: 1,
    total_results: 0,
    ...overrides,
  });

const movieDetails = {
  id: 603,
  genres: [],
  title: 'The Matrix',
  overview: '',
  original_title: 'The Matrix',
  release_date: '1999-03-31',
  adult: false,
  video: false,
  popularity: 1,
  vote_average: 1,
  vote_count: 1,
  original_language: 'en',
};

const tvDetails = {
  id: 603,
  name: 'Matrix Show',
  genres: [],
  overview: '',
  original_name: 'Matrix Show',
  first_air_date: '2001-01-01',
  popularity: 1,
  vote_average: 1,
  vote_count: 1,
  original_language: 'en',
  origin_country: [],
  number_of_seasons: 1,
};

// what a read of the id providers gives: details found, or the error thrown
function idReads(reads: { movie?: unknown; tv?: unknown; person?: unknown }) {
  const names = {
    movie: 'getMovie',
    tv: 'getTvShow',
    person: 'getPerson',
  } as const;

  for (const kind of ['movie', 'tv', 'person'] as const) {
    const read = reads[kind] ?? tmdbNotFound();

    stubs.stub(TheMovieDb.prototype, names[kind], async () => {
      if (read instanceof Error) {
        throw read;
      }

      return read;
    });
  }
}

const readFailure = () =>
  new Error('[TMDB] Failed to fetch details: connect ECONNREFUSED', {
    cause: new Error('connect ECONNREFUSED'),
  });

// the errors the route logs once for a failed search
function apiErrorLogs() {
  const spy = mock.method(logger, 'error', () => logger);

  return () =>
    spy.mock.calls
      .map(
        (call) => (call.arguments as unknown[])[1] as Record<string, unknown>
      )
      .filter((meta) => meta?.label === 'API');
}

// the one error the route logged for a failed search
const onlyLog = (logged: () => Record<string, unknown>[]) => {
  assert.strictEqual(logged().length, 1);

  return logged()[0] as Record<string, unknown>;
};

const FAILED = 'Unable to retrieve search results.';

function assertFailed(
  res: { status: number; body: Record<string, unknown> },
  label: string
) {
  assert.strictEqual(res.status, 500, label);
  assert.strictEqual(res.body.message, FAILED, label);
  assert.ok(!('results' in res.body), `${label}: no page of results`);
}

// The covering of the first album of albumFixture() made undecided: a
// whole-artist request of its artist stands and Lidarr cannot list its
// artists, so the album cannot be built into a result (F2-D-441); the second
// album's artist has no request and builds.
const UNDECIDED_ALBUM = 'b1392450-e666-3926-a536-22c65f834433';
const DECIDED_ALBUM = 'a5e4bd1a-63c9-4dfc-9e63-ed0c3dc049be';

async function makeFirstAlbumUndecided() {
  const artist = await getRepository(Media).save(
    new Media({
      mediaType: MediaType.MUSIC,
      musicBrainzId: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
      musicKind: MusicKind.ARTIST,
      status: MediaStatus.UNKNOWN,
      status4k: MediaStatus.UNKNOWN,
    })
  );
  const owner = await getRepository(User).findOneByOrFail({
    email: 'admin@seerr.dev',
  });
  await getRepository(MediaRequest).save(
    new MediaRequest({
      type: artist.mediaType,
      media: artist,
      requestedBy: owner,
      modifiedBy: owner,
      status: MediaRequestStatus.PENDING,
      is4k: false,
    })
  );
  mock.method(LidarrAPI.prototype, 'getArtists', async () => {
    throw new Error('Lidarr is down');
  });
}

const idsOf = (res: { body: { results: { id: unknown }[] } }) =>
  res.body.results.map((result) => result.id);

const resultsOf = (res: { body: { results: unknown[] } }) => res.body.results;

describe('GET /search where TMDB fails', () => {
  beforeEach(() => {
    sourceCalls = [];
  });

  const cases: [string, Source, Record<string, string>][] = [
    ['movie', 'searchMovies', { type: 'movie' }],
    ['tv', 'searchTvShows', { type: 'tv' }],
    ['person', 'searchPerson', { type: 'person' }],
    ['no type', 'searchMulti', {}],
  ];

  for (const [label, source, params] of cases) {
    it(`answers 500, never a page of no results, under ${label}, logged once with the query, the type and the source`, async () => {
      const logged = apiErrorLogs();
      tmdbSources({ [source]: DOWN() });
      lidarrAnswers(artistFixture(), albumFixture());

      const res = await searchWith({ query: 'matrix', ...params });

      assertFailed(res, label);
      assert.deepStrictEqual(calledSources(), [source]);
      const log = onlyLog(logged);
      assert.strictEqual(log.query, 'matrix');
      assert.strictEqual(log.type, params.type ?? 'none');
      assert.match(String(log.source), new RegExp(source));
      assert.strictEqual(log.errorMessage, 'TMDB is down');
    });

    it(`answers 500 under ${label} where TMDB itself cannot be reached, which the route has TheMovieDb throw`, async () => {
      mock.method(
        ExternalAPI.prototype,
        'get' as never,
        (async () => {
          throw new Error('connect ECONNREFUSED');
        }) as never
      );
      lidarrAnswers(artistFixture(), albumFixture());

      const res = await searchWith({ query: 'matrix', ...params });

      assertFailed(res, label);
    });
  }

  it('answers 500 where TMDB fails whatever Lidarr gives, and where the media rows cannot be read', async () => {
    mock.method(
      ExternalAPI.prototype,
      'get' as never,
      (async () => {
        throw new Error('connect ECONNREFUSED');
      }) as never
    );
    lidarrAnswers([], []);

    assertFailed(await searchWith({ query: 'matrix' }), 'Lidarr found nothing');
    assert.deepStrictEqual(lidarrCalls, []);
  });

  it('answers music alone as ever where only music is shown, TMDB being down and unread', async () => {
    servers({ music: true });
    mock.method(
      ExternalAPI.prototype,
      'get' as never,
      (async () => {
        throw new Error('connect ECONNREFUSED');
      }) as never
    );
    lidarrAnswers(artistFixture(), albumFixture());

    for (const params of [{}, { type: 'music' }] as Record<string, string>[]) {
      const res = await searchWith({ query: 'radiohead', ...params });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(resultsOf(res).length, 5);
    }
  });

  it('answers 500 for each id provider whose reads all fail, never 200 with no results', async () => {
    mock.method(
      ExternalAPI.prototype,
      'get' as never,
      (async () => {
        throw new Error('connect ECONNREFUSED');
      }) as never
    );

    for (const query of [
      'tmdb:603',
      'imdb:tt0133093',
      'tvdb:290434',
      'matrix year:1999',
    ]) {
      assertFailed(await searchWith({ query }), query);
    }
  });
});

describe('GET /search where the default Lidarr search is the source', () => {
  const musicOnly: [string, Record<string, string>][] = [
    ['the type music', { type: 'music' }],
    ['no type with only music shown', {}],
  ];

  beforeEach(() => {
    servers({ music: true });
    sourceCalls = [];
    tmdbSources();
  });

  for (const [label, params] of musicOnly) {
    it(`answers 500 under ${label} where both lookups fail, logged once with the query, the type and the source`, async () => {
      const logged = apiErrorLogs();
      lidarrAnswers(LIDARR_DOWN(), LIDARR_DOWN());

      const res = await searchWith({ query: 'radiohead', ...params });

      assertFailed(res, label);
      const log = onlyLog(logged);
      assert.strictEqual(log.query, 'radiohead');
      assert.strictEqual(log.type, 'music');
      assert.match(String(log.source), /Lidarr/);
      assert.deepStrictEqual(calledSources(), []);
    });

    it(`answers 500 under ${label} where one lookup fails and the other finds nothing, whichever fails`, async () => {
      lidarrAnswers(LIDARR_DOWN(), []);
      assertFailed(
        await searchWith({ query: 'radiohead', ...params }),
        `${label}: artists failing`
      );

      mock.restoreAll();
      cacheManager.getCache('lidarr').flush();
      lidarrAnswers([], LIDARR_DOWN());
      assertFailed(
        await searchWith({ query: 'radiohead', ...params }),
        `${label}: albums failing`
      );
    });

    it(`answers 200 under ${label} with what the lookup that answered found, where the other fails`, async () => {
      lidarrAnswers(LIDARR_DOWN(), albumFixture());
      const albums = await searchWith({ query: 'radiohead', ...params });

      assert.strictEqual(albums.status, 200);
      assert.deepStrictEqual(kindsOf(albums), ['album', 'album']);
      assert.strictEqual(albums.body.page, 1);
      assert.strictEqual(albums.body.totalPages, 1);

      mock.restoreAll();
      cacheManager.getCache('lidarr').flush();
      lidarrAnswers(artistFixture(), LIDARR_DOWN());
      const artists = await searchWith({ query: 'radiohead', ...params });

      assert.strictEqual(artists.status, 200);
      assert.deepStrictEqual(kindsOf(artists), ['artist', 'artist', 'artist']);
    });

    it(`answers 500 under ${label} where the results cannot be built`, async () => {
      lidarrAnswers(artistFixture(), albumFixture());
      mock.method(Media, 'getRelatedMusicMedia', async () => {
        throw new Error('database is gone');
      });

      assertFailed(await searchWith({ query: 'radiohead', ...params }), label);
    });

    it(`answers 200 with no results under ${label} where both lookups answer nothing, as today`, async () => {
      lidarrAnswers([], []);

      const res = await searchWith({ query: 'zzzzqqqq', ...params });

      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body, {
        page: 1,
        totalPages: 1,
        totalResults: 0,
        results: [],
      });
    });
  }

  it('answers a later page of the type music as no results of 1 page, Lidarr unread and unfailing', async () => {
    lidarrAnswers(LIDARR_DOWN(), LIDARR_DOWN());

    const res = await searchWith({
      query: 'radiohead',
      type: 'music',
      page: 2,
    });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, {
      page: 2,
      totalPages: 1,
      totalResults: 0,
      results: [],
    });
    assert.deepStrictEqual(lidarrCalls, []);
  });
});

describe("GET /search where the year: provider's two searches partly fail", () => {
  const query = 'matrix year:1999';

  beforeEach(() => {
    sourceCalls = [];
  });

  it('answers 500 where the search of the type asked failed and the results of the other search are not of that type', async () => {
    tmdbSources({ searchMovies: DOWN() });

    assertFailed(await searchWith({ query, type: 'movie' }), 'movie');
  });

  it('answers 500 where one search fails and the other answers nothing, and where both fail', async () => {
    tmdbSources({ searchMovies: DOWN(), searchTvShows: nothing() });
    assertFailed(await searchWith({ query }), 'movies failing');

    mock.restoreAll();
    stubs.restore();
    tmdbSources({ searchMovies: nothing(), searchTvShows: DOWN() });
    assertFailed(await searchWith({ query }), 'TV failing');

    mock.restoreAll();
    stubs.restore();
    tmdbSources({ searchMovies: DOWN(), searchTvShows: DOWN() });
    assertFailed(await searchWith({ query }), 'both failing');
  });

  it('answers the results of the search that answered where they are kept, the failed one logged', async () => {
    tmdbSources({ searchMovies: DOWN() });
    const res = await searchWith({ query });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(kindsOf(res), ['tv']);
    assert.strictEqual(res.body.page, 1);
    assert.strictEqual(res.body.totalPages, 1);
    assert.strictEqual(res.body.totalResults, 1);

    mock.restoreAll();
    stubs.restore();
    tmdbSources({ searchTvShows: DOWN() });
    const typed = await searchWith({ query, type: 'movie' });

    assert.strictEqual(typed.status, 200);
    assert.deepStrictEqual(kindsOf(typed), ['movie']);
  });

  it('fails nothing by a search whose results the answer would not keep: under the type person, and the TV search where tv is not shown', async () => {
    tmdbSources({ searchMovies: DOWN(), searchTvShows: DOWN() });

    const person = await searchWith({ query, type: 'person' });

    assert.strictEqual(person.status, 200);
    assert.deepStrictEqual(resultsOf(person), []);

    mock.restoreAll();
    stubs.restore();
    servers({ movie: true });
    tmdbSources({ searchMovies: nothing(), searchTvShows: DOWN() });
    const noTv = await searchWith({ query });

    assert.strictEqual(noTv.status, 200);
    assert.deepStrictEqual(resultsOf(noTv), []);

    mock.restoreAll();
    stubs.restore();
    tmdbSources({ searchMovies: DOWN() });
    assertFailed(
      await searchWith({ query }),
      'the movie search failing, the TV results of a kind not shown left out'
    );
  });
});

describe("GET /search where the tmdb: provider's three reads partly fail", () => {
  it('answers 500 where a read failed other than by 404 and what answered holds none of the kind asked or shown', async () => {
    idReads({ movie: readFailure(), tv: tvDetails });
    assertFailed(
      await searchWith({ query: 'tmdb:603', type: 'movie' }),
      'type movie, TV found'
    );

    stubs.restore();
    idReads({ movie: readFailure() });
    assertFailed(await searchWith({ query: 'tmdb:603' }), 'no type');
    assertFailed(
      await searchWith({ query: 'tmdb:603', type: 'movie' }),
      'type movie'
    );

    stubs.restore();
    idReads({ person: readFailure() });
    assertFailed(
      await searchWith({ query: 'tmdb:603', type: 'person' }),
      'type person'
    );
  });

  it('tells the read that failed by its kind: a TV read failing fails the type tv, not the type movie', async () => {
    idReads({ movie: movieDetails, tv: readFailure() });
    assertFailed(
      await searchWith({ query: 'tmdb:603', type: 'tv' }),
      'type tv, its read failing'
    );

    stubs.restore();
    idReads({ tv: readFailure() });
    const movie = await searchWith({ query: 'tmdb:603', type: 'movie' });

    assert.strictEqual(movie.status, 200);
    assert.deepStrictEqual(resultsOf(movie), []);
  });

  it('answers what the reads that answered found where it is kept', async () => {
    idReads({ movie: readFailure(), tv: tvDetails });

    const tvOnly = await searchWith({ query: 'tmdb:603', type: 'tv' });
    const both = await searchWith({ query: 'tmdb:603' });

    assert.strictEqual(tvOnly.status, 200);
    assert.deepStrictEqual(kindsOf(tvOnly), ['tv']);
    assert.strictEqual(both.status, 200);
    assert.deepStrictEqual(kindsOf(both), ['tv']);
    assert.strictEqual(both.body.totalResults, 1);
  });

  it('fails nothing by a read whose results the answer would not keep', async () => {
    idReads({ movie: movieDetails, person: readFailure() });

    const movie = await searchWith({ query: 'tmdb:603', type: 'movie' });

    assert.strictEqual(movie.status, 200);
    assert.deepStrictEqual(kindsOf(movie), ['movie']);

    stubs.restore();
    idReads({ person: tmdbNotFound(), movie: readFailure() });
    const person = await searchWith({ query: 'tmdb:603', type: 'person' });

    assert.strictEqual(person.status, 200);
    assert.deepStrictEqual(resultsOf(person), []);
  });

  it('reads a read answered not found, directly or from its cause, as one that found nothing: all three not found is no results, as today', async () => {
    const direct = Object.assign(new Error('Request failed'), {
      response: { status: 404 },
    });

    for (const notFound of [tmdbNotFound(), direct]) {
      stubs.restore();
      idReads({ movie: notFound, tv: notFound, person: notFound });

      const res = await searchWith({ query: 'tmdb:603' });

      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body, {
        page: 1,
        totalPages: 1,
        totalResults: 0,
        results: [],
      });
    }
  });
});

describe('GET /search with imdb: and tvdb: as today', () => {
  it('answers 500 where the lookup fails and the results where it answers', async () => {
    stubs.stub(TheMovieDb.prototype, 'getByExternalId', async () => {
      throw new Error('TMDB is down');
    });
    assertFailed(await searchWith({ query: 'imdb:tt0133093' }), 'imdb');
    assertFailed(await searchWith({ query: 'tvdb:290434' }), 'tvdb');

    stubs.restore();
    stubs.stub(TheMovieDb.prototype, 'getByExternalId', async () => ({
      movie_results: [movie],
      tv_results: [],
      person_results: [],
    }));
    const res = await searchWith({ query: 'imdb:tt0133093' });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(kindsOf(res), ['movie']);
  });
});

describe('GET /search without a type where movie or tv is shown and the default Lidarr search read beside TMDB fails', () => {
  beforeEach(() => {
    sourceCalls = [];
  });

  it('answers 500 where both lookups fail and TMDB answers no results, logged once with the query, the type and the source', async () => {
    const logged = apiErrorLogs();
    tmdbSources({ searchMulti: nothing() });
    lidarrAnswers(LIDARR_DOWN(), LIDARR_DOWN());

    const res = await searchWith({ query: 'children of bodom', page: 1 });

    assertFailed(res, 'TMDB nothing');
    const log = onlyLog(logged);
    assert.strictEqual(log.query, 'children of bodom');
    assert.strictEqual(log.type, 'none');
    assert.match(String(log.source), /Lidarr/);
  });

  it('answers 500 where both lookups fail and TMDB answers only results of a kind not shown', async () => {
    servers({ movie: true, music: true });
    tmdbSources({
      searchMulti: tmdbPage(1, { results: [tv, tv], total_results: 2 }),
    });
    lidarrAnswers(LIDARR_DOWN(), LIDARR_DOWN());

    assertFailed(await searchWith({ query: 'shows', page: 1 }), 'only tv');

    mock.restoreAll();
    stubs.restore();
    servers({ tv: true, music: true });
    tmdbSources({
      searchMulti: tmdbPage(1, { results: [movie], total_results: 1 }),
    });
    lidarrAnswers(LIDARR_DOWN(), LIDARR_DOWN());

    assertFailed(await searchWith({ query: 'films', page: 1 }), 'only movie');
  });

  it('answers 200 with the results of a kind shown, TMDB page and counts and no music, where both lookups fail', async () => {
    tmdbSources();
    lidarrAnswers(LIDARR_DOWN(), LIDARR_DOWN());

    const res = await searchWith({ query: 'radiohead', page: 1 });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, {
      page: 1,
      totalPages: 3,
      totalResults: 60,
      results: [MOVIE_ANSWER, TV_ANSWER, PERSON_ANSWER],
    });

    mock.restoreAll();
    stubs.restore();
    servers({ movie: true, music: true });
    tmdbSources({
      searchMulti: tmdbPage(1, { results: [tv, movie], total_results: 2 }),
    });
    lidarrAnswers(LIDARR_DOWN(), LIDARR_DOWN());
    const filtered = await searchWith({ query: 'radiohead', page: 1 });

    assert.strictEqual(filtered.status, 200);
    assert.deepStrictEqual(kindsOf(filtered), ['movie']);
  });

  it('answers 500 where one lookup fails, the other finds nothing and TMDB answers nothing, whichever fails', async () => {
    tmdbSources({ searchMulti: nothing() });
    lidarrAnswers(LIDARR_DOWN(), []);
    assertFailed(
      await searchWith({ query: 'bodom', page: 1 }),
      'artists failing'
    );

    mock.restoreAll();
    cacheManager.getCache('lidarr').flush();
    lidarrAnswers([], LIDARR_DOWN());
    assertFailed(
      await searchWith({ query: 'bodom', page: 1 }),
      'albums failing'
    );
  });

  it('answers 200 with what the lookup that answered found where the other fails and TMDB answers nothing', async () => {
    tmdbSources({ searchMulti: nothing() });
    lidarrAnswers(LIDARR_DOWN(), albumFixture());

    const res = await searchWith({ query: 'bodom', page: 1 });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(kindsOf(res), ['album', 'album']);
    assert.strictEqual(res.body.page, 1);
    assert.strictEqual(res.body.totalResults, 2);

    mock.restoreAll();
    cacheManager.getCache('lidarr').flush();
    lidarrAnswers(artistFixture(), LIDARR_DOWN());
    const artists = await searchWith({ query: 'bodom', page: 1 });

    assert.strictEqual(artists.status, 200);
    assert.deepStrictEqual(kindsOf(artists), ['artist', 'artist', 'artist']);
  });

  it('answers the results of TMDB and of the lookup that answered after them where one fails', async () => {
    tmdbSources();
    lidarrAnswers(artistFixture(), LIDARR_DOWN());

    const res = await searchWith({ query: 'radiohead', page: 1 });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(kindsOf(res), [
      'movie',
      'tv',
      'person',
      'artist',
      'artist',
      'artist',
    ]);
    assert.strictEqual(res.body.totalPages, 3);
    assert.strictEqual(res.body.totalResults, 63);
  });

  it('answers 200 with no results where TMDB and both lookups answer nothing, as today', async () => {
    tmdbSources({ searchMulti: nothing() });
    lidarrAnswers([], []);

    const res = await searchWith({ query: 'zzzzqqqq', page: 1 });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, {
      page: 1,
      totalPages: 1,
      totalResults: 0,
      results: [],
    });
  });

  it('reads no Lidarr on a later page, which answers TMDB page as before', async () => {
    servers({ movie: true, music: true });
    tmdbSources({
      searchMulti: tmdbPage(2, { results: [tv, tv], total_pages: 4 }),
    });
    lidarrAnswers(LIDARR_DOWN(), LIDARR_DOWN());

    const res = await searchWith({ query: 'shows', page: 2 });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, {
      page: 2,
      totalPages: 4,
      totalResults: 60,
      results: [],
    });
    assert.deepStrictEqual(lidarrCalls, []);
  });

  it('answers a failure of TMDB 500 whatever the lookups give', async () => {
    tmdbSources({ searchMulti: DOWN() });
    lidarrAnswers(artistFixture(), albumFixture());

    assertFailed(await searchWith({ query: 'radiohead', page: 1 }), 'TMDB');
  });

  it('answers 500 where the music the lookups found cannot be built and TMDB answers nothing, logged once with the Lidarr source', async () => {
    const logged = apiErrorLogs();
    tmdbSources({ searchMulti: nothing() });
    lidarrAnswers(artistFixture(), albumFixture());
    mock.method(Media, 'getRelatedMusicMedia', async () => {
      throw new Error('database is gone');
    });

    const res = await searchWith({ query: 'children of bodom', page: 1 });

    assertFailed(res, 'build failing, TMDB nothing');
    const log = onlyLog(logged);
    assert.strictEqual(log.query, 'children of bodom');
    assert.strictEqual(log.type, 'none');
    assert.match(String(log.source), /Lidarr/);
  });

  it('answers 500 where the music cannot be built and TMDB answers only results of a kind not shown', async () => {
    servers({ movie: true, music: true });
    tmdbSources({
      searchMulti: tmdbPage(1, { results: [tv, tv], total_results: 2 }),
    });
    lidarrAnswers(artistFixture(), albumFixture());
    mock.method(Media, 'getRelatedMusicMedia', async () => {
      throw new Error('database is gone');
    });

    assertFailed(await searchWith({ query: 'shows', page: 1 }), 'only tv');
  });

  it('answers 200 with the results of TMDB, its page and counts and no music, where the music cannot be built', async () => {
    const logged = apiErrorLogs();
    tmdbSources();
    lidarrAnswers(artistFixture(), albumFixture());
    mock.method(Media, 'getRelatedMusicMedia', async () => {
      throw new Error('database is gone');
    });

    const res = await searchWith({ query: 'radiohead', page: 1 });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, {
      page: 1,
      totalPages: 3,
      totalResults: 60,
      results: [MOVIE_ANSWER, TV_ANSWER, PERSON_ANSWER],
    });
    assert.strictEqual(logged().length, 0);
  });

  it('answers 500 where the only music found is an album whose covering cannot be decided, TMDB answering nothing, logged once with the Lidarr source', async () => {
    const logged = apiErrorLogs();
    await makeFirstAlbumUndecided();
    tmdbSources({ searchMulti: nothing() });
    lidarrAnswers([], albumFixture().slice(0, 1));

    const res = await searchWith({ query: 'children of bodom', page: 1 });

    assertFailed(res, 'undecided album, TMDB nothing');
    const log = onlyLog(logged);
    assert.strictEqual(log.type, 'none');
    assert.match(String(log.source), /Lidarr/);
  });

  it('answers 200 with TMDB results and the albums that built, its page and counts, where an album cannot be decided, the failed build logged', async () => {
    const warned = mock.method(logger, 'warn', () => logger);
    await makeFirstAlbumUndecided();
    tmdbSources();
    lidarrAnswers([], albumFixture());

    const res = await searchWith({ query: 'radiohead', page: 1 });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(kindsOf(res), ['movie', 'tv', 'person', 'album']);
    assert.deepStrictEqual(idsOf(res).slice(3), [DECIDED_ALBUM]);
    assert.strictEqual(res.body.totalPages, 3);
    assert.strictEqual(res.body.totalResults, 60 + 1);
    assert.ok(
      warned.mock.calls.some((call) =>
        /Lidarr/.test(
          String(
            ((call.arguments as unknown[])[1] as Record<string, unknown>)
              ?.source
          )
        )
      )
    );
  });

  it('answers 500 under the type music where the only music found is an album whose covering cannot be decided, and 200 with the albums that built, the failed build logged', async () => {
    const logged = apiErrorLogs();
    await makeFirstAlbumUndecided();
    lidarrAnswers([], albumFixture().slice(0, 1));

    assertFailed(
      await searchWith({ query: 'radiohead', type: 'music' }),
      'undecided album, type music'
    );
    assert.match(String(onlyLog(logged).source), /Lidarr/);

    mock.restoreAll();
    cacheManager.getCache('lidarr').flush();
    const warned = mock.method(logger, 'warn', () => logger);
    mock.method(LidarrAPI.prototype, 'getArtists', async () => {
      throw new Error('Lidarr is down');
    });
    lidarrAnswers([], albumFixture());

    const res = await searchWith({ query: 'radiohead', type: 'music' });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(idsOf(res), [DECIDED_ALBUM]);
    assert.ok(
      warned.mock.calls.some((call) =>
        /Lidarr/.test(
          String(
            ((call.arguments as unknown[])[1] as Record<string, unknown>)
              ?.source
          )
        )
      )
    );
    assert.ok(!idsOf(res).includes(UNDECIDED_ALBUM));
  });
});
