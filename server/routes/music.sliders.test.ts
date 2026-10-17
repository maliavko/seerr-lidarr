import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import type { LidarrMetadataArtist } from '@server/api/lidarrmetadata';
import { getLidarrMetadata } from '@server/api/lidarrmetadata';
import type {
  ListenBrainzPopularAlbum,
  ListenBrainzSimilarArtist,
} from '@server/api/listenbrainz';
import ListenBrainzAPI from '@server/api/listenbrainz';
import { getMusicBrainz } from '@server/api/musicbrainz';
import type {
  LidarrAlbum,
  LidarrArtist,
  LidarrTrackFile,
} from '@server/api/servarr/lidarr';
import LidarrAPI from '@server/api/servarr/lidarr';
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
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express, { Router } from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import session from 'express-session';
import request from 'supertest';
import authRoutes from './auth';
import musicRoutes from './music';

// The three music slider routes (F2-D-92), read as the client reads them, with
// the OpenAPI validator in front validating what they answer too (PIL-API).
// Lidarr, ListenBrainz and Lidarr's metadata service answer from here, never
// live.

const API_SPEC_PATH = join(__dirname, '../../seerr-api.yml');

const RADIOHEAD = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';

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

function createApp({ validateResponses = true } = {}): Express {
  const app = express();
  app.use(express.json());
  app.use(
    session({ secret: 'test-secret', resave: false, saveUninitialized: false })
  );
  app.use(checkUser);
  app.use('/auth', authRoutes);

  const api = Router();
  api.use(
    OpenApiValidator.middleware({
      apiSpec: API_SPEC_PATH,
      validateRequests: true,
      validateResponses,
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
  api.use('/music', isAuthenticated(), musicRoutes);
  app.use('/api/v1', api);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res.status(err.status ?? 500).json({ message: err.message });
    }
  );

  return app;
}

async function loginAs(app: Express) {
  const settings = getSettings();
  const prior = settings.main.localLogin;
  settings.main.localLogin = true;

  try {
    const agent = request.agent(app);
    const res = await agent
      .post('/auth/local')
      .send({ email: 'admin@seerr.dev', password: 'test1234' });
    assert.strictEqual(res.status, 200);
    return agent;
  } finally {
    settings.main.localLogin = prior;
  }
}

const uuid = (prefix: string, n: number) =>
  `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const albumMbid = (n: number) => uuid('bbbbbbbb', n);
const artistMbid = (n: number) => uuid('aaaaaaaa', n);

const lidarrArtist = (n: number): LidarrArtist => ({
  id: n,
  foreignArtistId: artistMbid(n),
  artistName: `Artist ${n}`,
  images: [],
  links: [],
  genres: [],
  monitored: true,
  monitorNewItems: 'all',
});

// an album Lidarr holds: id n, files files
const lidarrAlbum = (
  n: number,
  files: number,
  extra: Partial<LidarrAlbum> = {}
): LidarrAlbum => ({
  id: n,
  foreignAlbumId: albumMbid(n),
  artistId: n,
  artist: lidarrArtist(n),
  title: `Album ${n}`,
  secondaryTypes: [],
  images: [],
  monitored: true,
  statistics: {
    trackFileCount: files,
    trackCount: 10,
    totalTrackCount: 10,
    sizeOnDisk: 0,
    percentOfTracks: files * 10,
  },
  ...extra,
});

const trackFile = (albumId: number, dateAdded: string): LidarrTrackFile => ({
  id: albumId * 100 + Math.floor(Math.random() * 99),
  albumId,
  dateAdded,
});

interface Answers {
  albums?: LidarrAlbum[] | Error;
  trackFiles?: LidarrTrackFile[] | Error;
  artists?: LidarrArtist[] | Error;
  popular?: ListenBrainzPopularAlbum[];
  similar?: ListenBrainzSimilarArtist[];
  // Lidarr's metadata service, by artist MusicBrainz id
  metadata?: (mbid: string) => LidarrMetadataArtist | null | Error;
}

let calls: { name: string; args: unknown[] }[];

function answerWith(answers: Answers) {
  const reply =
    <T>(name: string, value: T | Error | undefined, fallback: T) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
      const v = value === undefined ? fallback : value;
      return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
    };

  mock.method(
    LidarrAPI.prototype,
    'getAlbums',
    reply('getAlbums', answers.albums, [])
  );
  mock.method(
    LidarrAPI.prototype,
    'getTrackFiles',
    reply('getTrackFiles', answers.trackFiles, [])
  );
  mock.method(
    LidarrAPI.prototype,
    'getArtists',
    reply('getArtists', answers.artists, [])
  );
  mock.method(
    ListenBrainzAPI.prototype,
    'getPopularAlbums',
    reply('getPopularAlbums', answers.popular, [])
  );
  mock.method(
    ListenBrainzAPI.prototype,
    'getSimilarArtists',
    reply('getSimilarArtists', answers.similar, [])
  );
  mock.method(getLidarrMetadata(), 'getArtist', (mbid: string) => {
    calls.push({ name: 'metadata', args: [mbid] });
    const v = answers.metadata ? answers.metadata(mbid) : null;
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
  });
}

const metadataWithPoster = (url: string): LidarrMetadataArtist => ({
  id: 'x',
  artistname: 'x',
  images: [
    { CoverType: 'Fanart', Url: 'https://img.example/fanart.jpg' },
    { CoverType: 'Poster', Url: url },
  ],
});

const called = (name: string) => calls.filter((c) => c.name === name);

let app: Express;
let unvalidated: Express;

before(() => {
  app = createApp();
  unvalidated = createApp({ validateResponses: false });
});

setupTestDb();

beforeEach(() => {
  calls = [];
  getSettings().lidarr = [{ ...server }];
  cacheManager.getCache('lidarr').flush();
  cacheManager.getCache('lidarrmetadata').flush();
});

afterEach(() => mock.restoreAll());

const ids = (res: request.Response) =>
  (res.body.results as { id: string }[]).map((r) => r.id);

async function saveRow(
  mbid: string,
  kind: MusicKind,
  status: MediaStatus,
  artist?: string
) {
  return getRepository(Media).save(
    new Media({
      mediaType: MediaType.MUSIC,
      musicBrainzId: mbid,
      musicKind: kind,
      artistMusicBrainzId: artist,
      status,
      status4k: MediaStatus.UNKNOWN,
    })
  );
}

async function requestFor(media: Media, status: MediaRequestStatus) {
  const owner = await getRepository(User).findOneByOrFail({
    email: 'admin@seerr.dev',
  });

  return getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.MUSIC,
      media,
      requestedBy: owner,
      modifiedBy: owner,
      status,
      is4k: false,
    })
  );
}

for (const path of [
  '/api/v1/music/recentlyadded',
  '/api/v1/music/popular',
  `/api/v1/music/artist/${RADIOHEAD}/similar`,
]) {
  describe(`GET ${path.replace(RADIOHEAD, ':mbid')}`, () => {
    it('is refused to a user not signed in', async () => {
      answerWith({});
      const res = await request(unvalidated).get(path);

      assert.strictEqual(res.status, 403);
    });

    it('answers {results: []} without a default Lidarr server, reading nothing', async () => {
      getSettings().lidarr = [{ ...server, isDefault: false }];
      answerWith({
        albums: [lidarrAlbum(1, 3)],
        trackFiles: [trackFile(1, '2026-01-01T00:00:00Z')],
        popular: [
          {
            mbid: albumMbid(1),
            title: 'A',
            coverUrl: 'https://coverartarchive.org/x.jpg',
          },
        ],
        similar: [{ mbid: artistMbid(1), name: 'A' }],
      });
      const agent = await loginAs(app);

      const res = await agent.get(path);

      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body, { results: [] });
      assert.strictEqual(calls.length, 0);
    });

    it('answers {results: []} with no Lidarr server at all', async () => {
      getSettings().lidarr = [];
      answerWith({});
      const agent = await loginAs(app);

      const res = await agent.get(path);

      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body, { results: [] });
    });
  });
}

describe('GET /music/recentlyadded', () => {
  it('lists the albums with a track file, the album whose newest file is newest first, ties in Lidarr order', async () => {
    answerWith({
      albums: [
        lidarrAlbum(1, 2),
        lidarrAlbum(2, 1),
        lidarrAlbum(3, 0),
        lidarrAlbum(4, 5),
        lidarrAlbum(5, 1),
        lidarrAlbum(6, 1),
      ],
      trackFiles: [
        trackFile(1, '2026-03-01T00:00:00Z'),
        trackFile(1, '2026-01-01T00:00:00Z'),
        trackFile(2, '2026-02-01T00:00:00Z'),
        trackFile(4, '2026-01-15T00:00:00Z'),
        trackFile(4, '2026-04-01T00:00:00Z'),
        trackFile(5, '2026-02-01T00:00:00Z'),
        trackFile(6, '2025-12-31T00:00:00Z'),
      ],
    });
    const agent = await loginAs(app);

    const res = await agent.get('/api/v1/music/recentlyadded');

    assert.strictEqual(res.status, 200);
    // 4 (newest file 04-01), 1 (03-01), then 2 and 5 tied at 02-01 in Lidarr's
    // order, 6 (2025-12-31); 3 has no file
    assert.deepStrictEqual(ids(res), [4, 1, 2, 5, 6].map(albumMbid));
  });

  it('asks the track files of the albums that hold a file only', async () => {
    answerWith({
      albums: [lidarrAlbum(1, 0), lidarrAlbum(2, 1), lidarrAlbum(3, 4)],
      trackFiles: [trackFile(2, '2026-01-01T00:00:00Z')],
    });
    const agent = await loginAs(app);

    await agent.get('/api/v1/music/recentlyadded');

    assert.strictEqual(called('getTrackFiles').length, 1);
    assert.deepStrictEqual(called('getTrackFiles')[0].args, [[2, 3]]);
  });

  it('reads no track file where no album holds one', async () => {
    answerWith({ albums: [lidarrAlbum(1, 0), lidarrAlbum(2, 0)] });
    const agent = await loginAs(app);

    const res = await agent.get('/api/v1/music/recentlyadded');

    assert.deepStrictEqual(res.body, { results: [] });
    assert.strictEqual(called('getTrackFiles').length, 0);
  });

  it('answers the 20 newest of more than 20', async () => {
    const albums = Array.from({ length: 25 }, (_, i) => lidarrAlbum(i + 1, 1));
    answerWith({
      albums,
      // album n gained its file on day n: 25 is the newest
      trackFiles: albums.map((a) =>
        trackFile(
          a.id as number,
          `2026-01-${String(a.id as number).padStart(2, '0')}T00:00:00Z`
        )
      ),
    });
    const agent = await loginAs(app);

    const res = await agent.get('/api/v1/music/recentlyadded');

    assert.strictEqual(res.body.results.length, 20);
    assert.deepStrictEqual(
      ids(res),
      Array.from({ length: 20 }, (_, i) => albumMbid(25 - i))
    );
  });

  it('answers search-shaped albums: id, title, artist, release date, cover as an http(s) URL', async () => {
    answerWith({
      albums: [
        lidarrAlbum(1, 1, {
          releaseDate: '1997-05-21T00:00:00Z',
          albumType: 'Album',
          images: [
            {
              coverType: 'cover',
              url: '/MediaCover/1/cover.jpg',
              remoteUrl: 'https://img.example/cover-1.jpg',
            },
          ],
        }),
        lidarrAlbum(2, 1, { remoteCover: 'https://img.example/remote-2.jpg' }),
        lidarrAlbum(3, 1, {
          images: [{ coverType: 'cover', url: '/MediaCover/3/cover.jpg' }],
        }),
      ],
      trackFiles: [
        trackFile(1, '2026-03-01T00:00:00Z'),
        trackFile(2, '2026-02-01T00:00:00Z'),
        trackFile(3, '2026-01-01T00:00:00Z'),
      ],
    });
    const agent = await loginAs(app);

    const res = await agent.get('/api/v1/music/recentlyadded');

    assert.deepStrictEqual(res.body.results, [
      {
        id: albumMbid(1),
        mediaType: 'album',
        title: 'Album 1',
        artistId: artistMbid(1),
        artistName: 'Artist 1',
        releaseDate: '1997-05-21T00:00:00Z',
        albumType: 'Album',
        coverUrl: 'https://img.example/cover-1.jpg',
      },
      {
        id: albumMbid(2),
        mediaType: 'album',
        title: 'Album 2',
        artistId: artistMbid(2),
        artistName: 'Artist 2',
        coverUrl: 'https://img.example/remote-2.jpg',
      },
      {
        id: albumMbid(3),
        mediaType: 'album',
        title: 'Album 3',
        artistId: artistMbid(3),
        artistName: 'Artist 3',
        coverUrl: `https://coverartarchive.org/release-group/${albumMbid(3)}/front-250`,
      },
    ]);
  });

  it("takes an album's artist from Lidarr's artists by artistId where the album gives none", async () => {
    answerWith({
      albums: [
        lidarrAlbum(1, 1, { artist: undefined, artistId: 7 }),
        lidarrAlbum(2, 1),
      ],
      artists: [lidarrArtist(5), lidarrArtist(7)],
      trackFiles: [
        trackFile(1, '2026-02-01T00:00:00Z'),
        trackFile(2, '2026-01-01T00:00:00Z'),
      ],
    });
    const agent = await loginAs(app);

    const res = await agent.get('/api/v1/music/recentlyadded');

    assert.strictEqual(res.body.results[0].artistId, artistMbid(7));
    assert.strictEqual(res.body.results[0].artistName, 'Artist 7');
    assert.strictEqual(res.body.results[1].artistId, artistMbid(2));
    assert.strictEqual(called('getArtists').length, 1);
  });

  it('reads no artist list where every album carries its artist', async () => {
    answerWith({
      albums: [lidarrAlbum(1, 1)],
      trackFiles: [trackFile(1, '2026-02-01T00:00:00Z')],
    });
    const agent = await loginAs(app);

    await agent.get('/api/v1/music/recentlyadded');

    assert.strictEqual(called('getArtists').length, 0);
  });

  it('carries the status the server computes: available as its row records, requested, and none for an item nothing is known of', async () => {
    answerWith({
      albums: [lidarrAlbum(1, 1), lidarrAlbum(2, 1), lidarrAlbum(3, 1)],
      trackFiles: [
        trackFile(1, '2026-03-01T00:00:00Z'),
        trackFile(2, '2026-02-01T00:00:00Z'),
        trackFile(3, '2026-01-01T00:00:00Z'),
      ],
    });
    await saveRow(
      albumMbid(1),
      MusicKind.ALBUM,
      MediaStatus.AVAILABLE,
      artistMbid(1)
    );
    // a stored pending is never what music shows: a pending request is
    const row2 = await saveRow(
      albumMbid(2),
      MusicKind.ALBUM,
      MediaStatus.PROCESSING,
      artistMbid(2)
    );
    await requestFor(row2, MediaRequestStatus.PENDING);
    const agent = await loginAs(unvalidated);

    const res = await agent.get('/api/v1/music/recentlyadded');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(
      res.body.results[0].mediaInfo.status,
      MediaStatus.AVAILABLE
    );
    assert.strictEqual(
      res.body.results[0].mediaInfo.musicBrainzId,
      albumMbid(1)
    );
    assert.strictEqual(
      res.body.results[1].mediaInfo.status,
      MediaStatus.PENDING
    );
    assert.strictEqual(res.body.results[2].mediaInfo, undefined);
  });

  it('reads Lidarr at each call, keeping nothing', async () => {
    answerWith({
      albums: [lidarrAlbum(1, 1)],
      trackFiles: [trackFile(1, '2026-02-01T00:00:00Z')],
    });
    const agent = await loginAs(app);

    await agent.get('/api/v1/music/recentlyadded');
    await agent.get('/api/v1/music/recentlyadded');

    assert.strictEqual(called('getAlbums').length, 2);
    assert.strictEqual(called('getTrackFiles').length, 2);
  });

  it('answers {results: []} and logs where Lidarr fails to list its albums', async () => {
    const error = mock.method(logger, 'error', () => logger);
    answerWith({ albums: new Error('[Lidarr] Failed to retrieve albums') });
    const agent = await loginAs(app);

    const res = await agent.get('/api/v1/music/recentlyadded');

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { results: [] });
    assert.strictEqual(error.mock.callCount(), 1);
    assert.match(String(error.mock.calls[0].arguments[0]), /recently added/);
  });

  it('answers {results: []} and logs where a batch of track files fails, listing no album', async () => {
    const error = mock.method(logger, 'error', () => logger);
    answerWith({
      albums: [lidarrAlbum(1, 1)],
      trackFiles: new Error('[Lidarr] Failed to retrieve track files'),
    });
    const agent = await loginAs(app);

    const res = await agent.get('/api/v1/music/recentlyadded');

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { results: [] });
    assert.strictEqual(error.mock.callCount(), 1);
  });
});

describe('GET /music/popular', () => {
  const popular = (n: number): ListenBrainzPopularAlbum => ({
    mbid: albumMbid(n),
    title: `Popular ${n}`,
    artistMbid: artistMbid(n),
    artistName: `Artist ${n}`,
    coverUrl: `https://coverartarchive.org/release-group/${albumMbid(n)}/front-250`,
  });

  it("answers ListenBrainz's albums as search-shaped albums, most listened first", async () => {
    answerWith({ popular: [popular(3), popular(1), popular(2)] });
    const agent = await loginAs(app);

    const res = await agent.get('/api/v1/music/popular');

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.results, [
      {
        id: albumMbid(3),
        mediaType: 'album',
        title: 'Popular 3',
        artistId: artistMbid(3),
        artistName: 'Artist 3',
        coverUrl: `https://coverartarchive.org/release-group/${albumMbid(3)}/front-250`,
      },
      ...[1, 2].map((n) => ({
        id: albumMbid(n),
        mediaType: 'album',
        title: `Popular ${n}`,
        artistId: artistMbid(n),
        artistName: `Artist ${n}`,
        coverUrl: `https://coverartarchive.org/release-group/${albumMbid(n)}/front-250`,
      })),
    ]);
    // read from ListenBrainz alone: no Lidarr read
    assert.strictEqual(called('getAlbums').length, 0);
  });

  it('answers at most 20', async () => {
    answerWith({
      popular: Array.from({ length: 30 }, (_, i) => popular(i + 1)),
    });
    const agent = await loginAs(app);

    const res = await agent.get('/api/v1/music/popular');

    assert.strictEqual(res.body.results.length, 20);
    assert.deepStrictEqual(
      ids(res),
      Array.from({ length: 20 }, (_, i) => albumMbid(i + 1))
    );
  });

  it("resolves each album's status with its artist: available as its row records, requested, none otherwise", async () => {
    answerWith({ popular: [popular(1), popular(2), popular(3)] });
    await saveRow(
      albumMbid(1),
      MusicKind.ALBUM,
      MediaStatus.AVAILABLE,
      artistMbid(1)
    );
    const row2 = await saveRow(
      albumMbid(2),
      MusicKind.ALBUM,
      MediaStatus.UNKNOWN,
      artistMbid(2)
    );
    await requestFor(row2, MediaRequestStatus.APPROVED);
    const agent = await loginAs(unvalidated);

    const res = await agent.get('/api/v1/music/popular');

    assert.strictEqual(
      res.body.results[0].mediaInfo.status,
      MediaStatus.AVAILABLE
    );
    assert.strictEqual(
      res.body.results[1].mediaInfo.status,
      MediaStatus.PROCESSING
    );
    assert.strictEqual(res.body.results[2].mediaInfo, undefined);
  });

  it("covers an album by a whole-artist request of its entry's first artist", async () => {
    answerWith({ popular: [popular(1)] });
    // the albums of the artist, as MusicBrainz lists them for an artist Lidarr
    // does not hold
    mock.method(getMusicBrainz(), 'getArtistAlbums', async () => [
      { id: albumMbid(1), title: 'Popular 1' },
    ]);
    const artistRow = await saveRow(
      artistMbid(1),
      MusicKind.ARTIST,
      MediaStatus.UNKNOWN
    );
    await requestFor(artistRow, MediaRequestStatus.PENDING);
    const agent = await loginAs(unvalidated);

    const res = await agent.get('/api/v1/music/popular');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(
      res.body.results[0].mediaInfo.status,
      MediaStatus.PENDING
    );
  });

  it('answers {results: []} where ListenBrainz gives nothing', async () => {
    answerWith({ popular: [] });
    const agent = await loginAs(app);

    const res = await agent.get('/api/v1/music/popular');

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { results: [] });
  });

  it('answers {results: []} and logs where reading fails past the client', async () => {
    const error = mock.method(logger, 'error', () => logger);
    answerWith({});
    mock.method(ListenBrainzAPI.prototype, 'getPopularAlbums', async () => {
      throw new Error('boom');
    });
    const agent = await loginAs(app);

    const res = await agent.get('/api/v1/music/popular');

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { results: [] });
    assert.strictEqual(error.mock.callCount(), 1);
  });
});

describe('GET /music/artist/:mbid/similar', () => {
  const similarOf = (n: number): ListenBrainzSimilarArtist => ({
    mbid: artistMbid(n),
    name: `Similar ${n}`,
  });
  const get = (agent: Awaited<ReturnType<typeof loginAs>>) =>
    agent.get(`/api/v1/music/artist/${RADIOHEAD}/similar`);

  it("asks ListenBrainz for the artist and answers its artists as search-shaped artists, most similar first, with the metadata service's poster", async () => {
    answerWith({
      similar: [similarOf(2), similarOf(1), similarOf(3)],
      metadata: (mbid) =>
        mbid === artistMbid(3)
          ? null
          : metadataWithPoster(`https://img.example/poster-${mbid}.jpg`),
    });
    const agent = await loginAs(app);

    const res = await get(agent);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(called('getSimilarArtists')[0].args, [RADIOHEAD]);
    assert.deepStrictEqual(res.body.results, [
      {
        id: artistMbid(2),
        mediaType: 'artist',
        name: 'Similar 2',
        imageUrl: `https://img.example/poster-${artistMbid(2)}.jpg`,
      },
      {
        id: artistMbid(1),
        mediaType: 'artist',
        name: 'Similar 1',
        imageUrl: `https://img.example/poster-${artistMbid(1)}.jpg`,
      },
      { id: artistMbid(3), mediaType: 'artist', name: 'Similar 3' },
    ]);
  });

  it('answers at most 20', async () => {
    answerWith({
      similar: Array.from({ length: 30 }, (_, i) => similarOf(i + 1)),
    });
    const agent = await loginAs(app);

    const res = await get(agent);

    assert.strictEqual(res.body.results.length, 20);
    assert.deepStrictEqual(
      ids(res),
      Array.from({ length: 20 }, (_, i) => artistMbid(i + 1))
    );
  });

  it('leaves out the image of an artist whose image read fails, never the list', async () => {
    const error = mock.method(logger, 'error', () => logger);
    answerWith({
      similar: [similarOf(1), similarOf(2)],
      metadata: (mbid) =>
        mbid === artistMbid(1)
          ? new Error('[Lidarr Metadata] boom')
          : metadataWithPoster('https://img.example/p2.jpg'),
    });
    const agent = await loginAs(app);

    const res = await get(agent);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(
      res.body.results.map((r: { name: string; imageUrl?: string }) => [
        r.name,
        r.imageUrl,
      ]),
      [
        ['Similar 1', undefined],
        ['Similar 2', 'https://img.example/p2.jpg'],
      ]
    );
    assert.strictEqual(error.mock.callCount(), 1);
  });

  it('leaves out an image that is not an http(s) URL', async () => {
    answerWith({
      similar: [similarOf(1)],
      metadata: () => metadataWithPoster('/MediaCover/Artists/1/poster.jpg'),
    });
    const agent = await loginAs(app);

    const res = await get(agent);

    assert.strictEqual(res.body.results[0].imageUrl, undefined);
  });

  it('asks the metadata service by the artists MusicBrainz id, side by side, and never a Lidarr lookup', async () => {
    answerWith({ similar: [similarOf(1), similarOf(2)] });
    const agent = await loginAs(app);

    await get(agent);

    assert.deepStrictEqual(
      called('metadata').map((c) => c.args[0]),
      [artistMbid(1), artistMbid(2)]
    );
    assert.strictEqual(called('getArtists').length, 0);
  });

  it("resolves each artist's status as an artist: available or partially available as its row records, requested by a whole-artist request, none otherwise", async () => {
    answerWith({
      similar: [similarOf(1), similarOf(2), similarOf(3), similarOf(4)],
    });
    await saveRow(artistMbid(1), MusicKind.ARTIST, MediaStatus.AVAILABLE);
    await saveRow(
      artistMbid(2),
      MusicKind.ARTIST,
      MediaStatus.PARTIALLY_AVAILABLE
    );
    const row3 = await saveRow(
      artistMbid(3),
      MusicKind.ARTIST,
      MediaStatus.UNKNOWN
    );
    await requestFor(row3, MediaRequestStatus.PENDING);
    const agent = await loginAs(unvalidated);

    const res = await get(agent);

    assert.deepStrictEqual(
      res.body.results.map(
        (r: { mediaInfo?: { status: number } }) => r.mediaInfo?.status
      ),
      [
        MediaStatus.AVAILABLE,
        MediaStatus.PARTIALLY_AVAILABLE,
        MediaStatus.PENDING,
        undefined,
      ]
    );
  });

  it('answers {results: []} where ListenBrainz knows none', async () => {
    answerWith({ similar: [] });
    const agent = await loginAs(app);

    const res = await get(agent);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { results: [] });
    assert.strictEqual(called('metadata').length, 0);
  });

  it('is refused 400 for an id that is not a UUID', async () => {
    answerWith({});
    const agent = await loginAs(app);

    const res = await agent.get('/api/v1/music/artist/not-an-id/similar');

    assert.strictEqual(res.status, 400);
  });
});
