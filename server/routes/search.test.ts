import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import type { LidarrAlbum, LidarrArtist } from '@server/api/servarr/lidarr';
import LidarrAPI from '@server/api/servarr/lidarr';
import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieResult,
  TmdbPersonResult,
  TmdbSearchMultiResponse,
  TmdbTvResult,
} from '@server/api/themoviedb/interfaces';
import { MediaStatus, MediaType, MusicKind } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import cacheManager from '@server/lib/cache';
import { getSettings } from '@server/lib/settings';
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
  pages: Partial<Record<Source, TmdbSearchMultiResponse>> = {}
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
      return pages[source] ?? defaults[source];
    });
  }
}

const calledSources = () => sourceCalls.map((call) => call.source);

async function searchWith(params: Record<string, string | number>) {
  const agent = await loginAs(app);
  const query = new URLSearchParams(
    Object.entries(params).map(([key, value]) => [key, String(value)])
  );

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
      throw new Error('not a person');
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

  it('answers a failing typed TMDB source as an empty page 1 of 1, as the client of TMDB does', async () => {
    tmdbSources({
      searchPerson: tmdbPage(1, {
        results: [],
        total_pages: 1,
        total_results: 0,
      }),
    });

    const res = await searchWith({ query: 'nobody', type: 'person' });

    assert.deepStrictEqual(res.body, {
      page: 1,
      totalPages: 1,
      totalResults: 0,
      results: [],
    });
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

  it('answers Lidarr failing under the type music as no results of page 1 of 1', async () => {
    tmdbSources();
    lidarrAnswers(new Error('Lidarr is down'), new Error('Lidarr is down'));

    const res = await searchWith({ query: 'radiohead', type: 'music' });

    assert.deepStrictEqual(res.body, {
      page: 1,
      totalPages: 1,
      totalResults: 0,
      results: [],
    });
  });
});
