import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import type { LidarrMetadataArtist } from '@server/api/lidarrmetadata';
import { getLidarrMetadata } from '@server/api/lidarrmetadata';
import type { ListenBrainzSimilarArtist } from '@server/api/listenbrainz';
import ListenBrainzAPI from '@server/api/listenbrainz';
import type {
  LidarrAlbum,
  LidarrArtist,
  LidarrHistoryEvent,
  LidarrHistoryPage,
  LidarrTrack,
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
import { albumCameInAt } from '@server/lib/albumCameInAt';
import cacheManager from '@server/lib/cache';
import { sliderClock } from '@server/lib/musicSliders';
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

let fileSeq = 0;

const trackFile = (
  albumId: number,
  dateAdded: string,
  id = albumId * 1000 + fileSeq++
): LidarrTrackFile => ({
  id,
  albumId,
  dateAdded,
});

// A fake Lidarr holding albums with their files and history events, answering
// as Lidarr does: the album's history by its ids, its tracks with the file each
// holds, and the import history newest first page by page.
interface FakeAlbum {
  n: number;
  // each file held: its date and the track it holds
  files: { dateAdded: string; trackId: number }[];
  events: LidarrHistoryEvent[];
  // the album's tracks now, Lidarr's ids (the tracks of its files where none
  // are given): a history may name tracks the album no longer has
  tracksNow?: number[];
}

// Lidarr's id of the i-th file of fake album a
const fakeFileId = (a: FakeAlbum, i: number) => a.n * 1000 + 500 + i;

const tracksNowOf = (a: FakeAlbum) =>
  a.tracksNow ?? a.files.map((f) => f.trackId);

let eventSeq = 0;

const event = (
  eventType: 'trackFileImported' | 'trackFileDeleted',
  date: string,
  trackId: number,
  reason?: string,
  // the id of the file the event is of, as Lidarr writes it: a string
  fileId?: string
): LidarrHistoryEvent => ({
  id: ++eventSeq,
  date,
  eventType,
  trackId,
  data: {
    ...(reason === undefined ? {} : { reason }),
    ...(fileId === undefined ? {} : { fileId }),
  },
});

// Lidarr's id of the artist that holds fake album n: never n itself, so a read
// by the album's id in the artist's place is told from one by its artist's
const ownerOf = (n: number) => n + 100;

const fakeLidarr = (fake: FakeAlbum[], importPageSize?: number): Answers => {
  const fileId = fakeFileId;
  const imports = fake
    .flatMap((a) =>
      a.events
        .filter((e) => e.eventType === 'trackFileImported')
        .map((e) => ({ ...e, albumId: a.n, artistId: ownerOf(a.n) }))
    )
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || b.id - a.id);

  return {
    albums: fake.map((a) =>
      lidarrAlbum(a.n, a.files.length, {
        artistId: ownerOf(a.n),
        artist: lidarrArtist(ownerOf(a.n)),
      })
    ),
    trackFiles: fake.flatMap((a) =>
      a.files.map((f, i) => trackFile(a.n, f.dateAdded, fileId(a, i)))
    ),
    // Lidarr answers an album's history under its own artist's id only
    history: (artistId, albumId) =>
      (artistId === ownerOf(albumId)
        ? (fake.find((a) => a.n === albumId)?.events ?? [])
        : []
      ).map((e) => ({
        ...e,
        albumId,
        artistId,
      })),
    tracks: (albumId) => {
      const a = fake.find((x) => x.n === albumId) as FakeAlbum;

      return tracksNowOf(a).map((trackId, i) => {
        const held = a.files.findIndex((f) => f.trackId === trackId);

        return {
          id: trackId,
          albumId,
          title: `Track ${trackId}`,
          trackNumber: String(i + 1),
          absoluteTrackNumber: i + 1,
          mediumNumber: 1,
          duration: 1000,
          hasFile: held >= 0,
          ...(held >= 0 ? { trackFileId: fileId(a, held) } : {}),
        };
      });
    },
    importHistory: (page, pageSize) => {
      const size = importPageSize ?? pageSize;

      return {
        page,
        pageSize: size,
        totalRecords: imports.length,
        records: imports.slice((page - 1) * size, page * size),
      };
    },
  };
};

// the order the pure helper gives, album by album, all read: the oracle the
// route's answer is held against
const expectedOrder = (fake: FakeAlbum[]) =>
  fake
    .map((a, index) => ({
      n: a.n,
      index,
      time:
        albumCameInAt(
          a.events,
          a.files.map((f, i) => ({
            id: fakeFileId(a, i),
            dateAdded: f.dateAdded,
            trackIds: [f.trackId],
          })),
          tracksNowOf(a)
        ) ?? -Infinity,
    }))
    .sort((a, b) => b.time - a.time || a.index - b.index)
    .map((a) => a.n);

interface Answers {
  albums?: LidarrAlbum[] | Error;
  trackFiles?: LidarrTrackFile[] | Error;
  // a promise is a read the test settles itself, never settled a read that never answers
  artists?: LidarrArtist[] | Error | Promise<LidarrArtist[]>;
  // an album's history by Lidarr's artist and album ids, its tracks by album id
  history?: (artistId: number, albumId: number) => LidarrHistoryEvent[] | Error;
  tracks?: (albumId: number) => LidarrTrack[] | Error;
  // a page (1-based) of the import history
  importHistory?: (page: number, pageSize: number) => LidarrHistoryPage | Error;
  similar?: ListenBrainzSimilarArtist[];
  // what ListenBrainz answers for each artist asked about, in place of similar
  similarOf?: (
    mbid: string
  ) => ListenBrainzSimilarArtist[] | Promise<ListenBrainzSimilarArtist[]>;
  // Lidarr's metadata service, by artist MusicBrainz id
  metadata?: (
    mbid: string
  ) => LidarrMetadataArtist | null | Error | Promise<LidarrMetadataArtist>;
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
  const answer = <T>(name: string, args: unknown[], v: T | Error) => {
    calls.push({ name, args });
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
  };

  mock.method(
    LidarrAPI.prototype,
    'getAlbumHistory',
    (artistId: number, albumId: number) =>
      answer(
        'getAlbumHistory',
        [artistId, albumId],
        answers.history ? answers.history(artistId, albumId) : []
      )
  );
  mock.method(LidarrAPI.prototype, 'getTracks', (albumId: number) =>
    answer(
      'getTracks',
      [albumId],
      answers.tracks ? answers.tracks(albumId) : []
    )
  );
  mock.method(
    LidarrAPI.prototype,
    'getImportHistory',
    (page: number, pageSize: number) =>
      answer(
        'getImportHistory',
        [page, pageSize],
        answers.importHistory
          ? answers.importHistory(page, pageSize)
          : { page, pageSize, totalRecords: 0, records: [] }
      )
  );
  mock.method(
    ListenBrainzAPI.prototype,
    'getSimilarArtists',
    (mbid: string) => {
      calls.push({ name: 'getSimilarArtists', args: [mbid] });

      const v = answers.similarOf
        ? answers.similarOf(mbid)
        : (answers.similar ?? []);

      return Promise.resolve(v);
    }
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
  '/api/v1/music/library/similar',
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
        artists: [lidarrArtist(1)],
        similar: [{ mbid: artistMbid(1), name: 'A', score: 1 }],
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
  it('lists the albums with a track file in the order Lidarr imported them, the last imported first, ties in Lidarr order', async () => {
    answerWith({
      albums: [
        lidarrAlbum(1, 2),
        lidarrAlbum(2, 1),
        lidarrAlbum(3, 0),
        lidarrAlbum(4, 5),
        lidarrAlbum(5, 1),
        lidarrAlbum(6, 1),
      ],
      // no history: each album stands at its earliest file
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
    // 2 and 5 tied at 02-01 in Lidarr's order, 4 (01-15), 1 (01-01), 6
    // (2025-12-31); 3 has no file
    assert.deepStrictEqual(ids(res), [2, 5, 4, 1, 6].map(albumMbid));
  });

  it('places each album at the import that brought it in: a re-imported album first, an upgraded one, one given a new file, and one given a new track not moved', async () => {
    const fake: FakeAlbum[] = [
      // held since it came
      {
        n: 1,
        files: [{ dateAdded: '2026-01-10T00:00:00Z', trackId: 11 }],
        events: [event('trackFileImported', '2026-01-10T00:00:05Z', 11)],
      },
      // every file removed, imported again, the run's records ten minutes
      // after its files' dateAdded
      {
        n: 2,
        files: [{ dateAdded: '2026-03-01T09:00:00Z', trackId: 21 }],
        events: [
          event('trackFileImported', '2026-01-05T00:00:05Z', 21),
          event(
            'trackFileDeleted',
            '2026-02-01T00:00:00Z',
            21,
            'MissingFromDisk'
          ),
          event('trackFileImported', '2026-03-01T09:10:00Z', 21),
        ],
      },
      // a track added later
      {
        n: 3,
        files: [
          { dateAdded: '2026-01-20T00:00:00Z', trackId: 31 },
          { dateAdded: '2026-04-01T00:00:00Z', trackId: 32 },
        ],
        events: [
          event('trackFileImported', '2026-01-20T00:00:05Z', 31),
          event('trackFileImported', '2026-04-01T00:00:05Z', 32),
        ],
      },
      // a file upgraded
      {
        n: 4,
        files: [{ dateAdded: '2026-05-01T00:00:00Z', trackId: 41 }],
        events: [
          event('trackFileImported', '2026-01-25T00:00:05Z', 41),
          event('trackFileDeleted', '2026-05-01T00:00:00Z', 41, 'Upgrade'),
          event('trackFileImported', '2026-05-01T00:00:05Z', 41),
        ],
      },
      // found by a scan of the disk: no history
      {
        n: 5,
        files: [{ dateAdded: '2026-02-10T00:00:00Z', trackId: 51 }],
        events: [],
      },
    ];
    answerWith(fakeLidarr(fake));
    const agent = await loginAs(app);

    const res = await agent.get('/api/v1/music/recentlyadded');

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(ids(res), [2, 5, 4, 3, 1].map(albumMbid));
    assert.deepStrictEqual(called('getAlbumHistory')[0].args.length, 2);
  });

  it("hands the helper the album's tracks now: an album imported with tracks it no longer has and imported again with its tracks now stands at the second import (F2-SD-10's case 2)", async () => {
    const fake: FakeAlbum[] = [
      // imported 10-09 with tracks 11, 12 (replaced since, their files removed
      // and no deletion recorded), imported again 10-16 as tracks 13, 14
      {
        n: 1,
        files: [
          { dateAdded: '2026-10-16T23:21:01Z', trackId: 13 },
          { dateAdded: '2026-10-16T23:21:01Z', trackId: 14 },
        ],
        tracksNow: [13, 14, 15],
        events: [
          event('trackFileImported', '2026-10-09T04:48:59Z', 11),
          event('trackFileImported', '2026-10-09T04:48:59Z', 12),
          event('trackFileImported', '2026-10-16T23:21:01Z', 13),
          event('trackFileImported', '2026-10-16T23:21:01Z', 14),
        ],
      },
      // imported between the two
      {
        n: 2,
        files: [{ dateAdded: '2026-10-12T00:00:00Z', trackId: 21 }],
        events: [event('trackFileImported', '2026-10-12T00:00:05Z', 21)],
      },
    ];
    answerWith(fakeLidarr(fake));
    const agent = await loginAs(app);

    const res = await agent.get('/api/v1/music/recentlyadded');

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(ids(res), [1, 2].map(albumMbid));
  });

  it("stands an album emptied of its files after an Upgrade deletion of one track and the import of another, and imported again, at that last import (QA S181's case)", async () => {
    const fake: FakeAlbum[] = [
      {
        n: 1,
        files: [{ dateAdded: '2026-03-01T00:00:00Z', trackId: 11 }],
        tracksNow: [11, 12],
        events: [
          event('trackFileImported', '2026-01-01T00:00:05Z', 11),
          event('trackFileDeleted', '2026-01-02T00:00:00Z', 11, 'Upgrade'),
          event('trackFileImported', '2026-01-02T00:00:02Z', 12),
          event('trackFileDeleted', '2026-02-01T00:00:00Z', 12, 'Manual'),
          event('trackFileImported', '2026-03-01T00:00:05Z', 11),
        ],
      },
      // imported between the first import and the last
      {
        n: 2,
        files: [{ dateAdded: '2026-02-10T00:00:00Z', trackId: 21 }],
        events: [event('trackFileImported', '2026-02-10T00:00:05Z', 21)],
      },
    ];
    answerWith(fakeLidarr(fake));
    const agent = await loginAs(app);

    const res = await agent.get('/api/v1/music/recentlyadded');

    assert.deepStrictEqual(ids(res), [1, 2].map(albumMbid));
  });

  it("counts a track of the album Lidarr holds no file of among its tracks now: its import is not replaced by another track's", async () => {
    const fake: FakeAlbum[] = [
      // tracks 11 and 12 imported 01-01 (their files lost, no deletion
      // recorded), track 13 imported 02-01: the album has all three, so the
      // import of 13 is no coming-in
      {
        n: 1,
        files: [{ dateAdded: '2026-02-01T00:00:00Z', trackId: 13 }],
        tracksNow: [11, 12, 13],
        events: [
          event('trackFileImported', '2026-01-01T00:00:05Z', 11),
          event('trackFileImported', '2026-01-01T00:00:06Z', 12),
          event('trackFileImported', '2026-02-01T00:00:05Z', 13),
        ],
      },
      {
        n: 2,
        files: [{ dateAdded: '2026-01-15T00:00:00Z', trackId: 21 }],
        events: [event('trackFileImported', '2026-01-15T00:00:05Z', 21)],
      },
    ];
    answerWith(fakeLidarr(fake));
    const agent = await loginAs(app);

    const res = await agent.get('/api/v1/music/recentlyadded');

    assert.deepStrictEqual(ids(res), [2, 1].map(albumMbid));
  });

  it("hands the helper each held file under Lidarr's own track-file id, so that its mark is its import record by data.fileId (F2-D-561)", async () => {
    // album 1 holds one file, Lidarr's id fakeFileId(album, 0), of track 11,
    // whose row is dated 01-10 (created anew by a re-match) and whose import
    // record, by data.fileId, is dated 01-05; track 11 was imported again 02-05
    // (that file since removed). By its file id the mark is 01-05 and the album
    // stands at 01-05, below album 2 (01-20); by its track the mark would be
    // 02-05 and it would stand first.
    const album1: FakeAlbum = {
      n: 1,
      files: [{ dateAdded: '2026-01-10T00:00:00Z', trackId: 11 }],
      events: [],
    };
    const own = String(fakeFileId(album1, 0));

    album1.events = [
      event('trackFileImported', '2026-01-05T00:00:00Z', 11, undefined, own),
      event('trackFileDeleted', '2026-01-20T00:00:00Z', 11, 'Manual'),
      event(
        'trackFileImported',
        '2026-02-05T00:00:00Z',
        11,
        undefined,
        String(fakeFileId(album1, 0) + 77)
      ),
    ];
    const fake: FakeAlbum[] = [
      album1,
      {
        n: 2,
        files: [{ dateAdded: '2026-01-20T00:00:00Z', trackId: 21 }],
        events: [
          event(
            'trackFileImported',
            '2026-01-20T00:00:05Z',
            21,
            undefined,
            String(fakeFileId({ n: 2 } as FakeAlbum, 0))
          ),
        ],
      },
    ];
    answerWith(fakeLidarr(fake));
    const agent = await loginAs(app);

    const res = await agent.get('/api/v1/music/recentlyadded');

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(ids(res), [2, 1].map(albumMbid));
  });

  it('stands albums of one import run by their own recorded times, the one imported last first', async () => {
    const fake: FakeAlbum[] = [1, 2, 3].map((n) => ({
      n,
      files: [{ dateAdded: '2026-06-01T12:00:00Z', trackId: n * 10 }],
      events: [event('trackFileImported', `2026-06-01T12:00:${n}0Z`, n * 10)],
    }));
    answerWith(fakeLidarr(fake));
    const agent = await loginAs(app);

    const res = await agent.get('/api/v1/music/recentlyadded');

    assert.deepStrictEqual(ids(res), [3, 2, 1].map(albumMbid));
  });

  it("reads each album's history by its own artist's id and gives each held file only the tracks that hold it", async () => {
    const fake: FakeAlbum[] = [
      // two files: the first (track 31, held since January) has no import in
      // the history, the second (track 32) was imported in April; the album
      // stands at its earliest held file, not at that import
      {
        n: 1,
        files: [
          { dateAdded: '2026-01-20T00:00:00Z', trackId: 31 },
          { dateAdded: '2026-04-01T00:00:00Z', trackId: 32 },
        ],
        events: [event('trackFileImported', '2026-04-01T00:00:05Z', 32)],
      },
      // imported in February
      {
        n: 2,
        files: [{ dateAdded: '2026-02-01T00:00:00Z', trackId: 21 }],
        events: [event('trackFileImported', '2026-02-01T00:00:05Z', 21)],
      },
      // every file removed and imported again in March: found only by the
      // history read under its artist's id
      {
        n: 3,
        files: [{ dateAdded: '2026-03-01T00:00:00Z', trackId: 41 }],
        events: [
          event('trackFileImported', '2026-01-05T00:00:05Z', 41),
          event('trackFileDeleted', '2026-02-05T00:00:00Z', 41, 'Manual'),
          event('trackFileImported', '2026-03-01T00:00:05Z', 41),
        ],
      },
    ];
    answerWith(fakeLidarr(fake));
    const agent = await loginAs(app);

    const res = await agent.get('/api/v1/music/recentlyadded');

    assert.deepStrictEqual(ids(res), [3, 2, 1].map(albumMbid));
    assert.deepStrictEqual(
      called('getAlbumHistory')
        .map((c) => c.args)
        .sort((a, b) => (a[1] as number) - (b[1] as number)),
      [
        [101, 1],
        [102, 2],
        [103, 3],
      ]
    );
  });

  it('reads an album by its earliest held file, not its latest, in deciding where it may stand', async () => {
    const fake = thirty();
    // a 31st album: held since January 1 (imported then), given a second file on
    // June 1 that no import in the history records; its bound is January 1, so
    // the albums above it fill the 20 before it is read
    fake.push({
      n: 31,
      files: [
        { dateAdded: '2026-01-01T00:00:00Z', trackId: 310 },
        { dateAdded: '2026-06-01T00:00:00Z', trackId: 311 },
      ],
      events: [event('trackFileImported', '2026-01-01T00:00:01Z', 310)],
    });
    answerWith(fakeLidarr(fake));
    const agent = await loginAs(app);

    const res = await agent.get('/api/v1/music/recentlyadded');

    assert.deepStrictEqual(ids(res), rightTwenty);
    assert.ok(!called('getAlbumHistory').some((c) => c.args[1] === 31));
  });

  it('stops at the twentieth where the next album can only tie it, reading no more', async () => {
    // 25 albums all imported in one second: no album read can come before the
    // 20 first in Lidarr's order
    const fake: FakeAlbum[] = Array.from({ length: 25 }, (_, i) => ({
      n: i + 1,
      files: [{ dateAdded: '2026-06-01T12:00:00Z', trackId: (i + 1) * 10 }],
      events: [
        event('trackFileImported', '2026-06-01T12:00:01Z', (i + 1) * 10),
      ],
    }));
    answerWith(fakeLidarr(fake));
    const agent = await loginAs(app);

    const res = await agent.get('/api/v1/music/recentlyadded');

    assert.deepStrictEqual(
      ids(res),
      Array.from({ length: 20 }, (_, i) => albumMbid(i + 1))
    );
    assert.strictEqual(called('getAlbumHistory').length, 20);
  });

  it('answers albums of equal times in Lidarr order, not the order they were read in', async () => {
    // album 2 has the later bound (a track added on June 1) and is read first;
    // both came in at the same second
    const fake: FakeAlbum[] = [
      {
        n: 1,
        files: [{ dateAdded: '2026-01-01T00:00:00Z', trackId: 10 }],
        events: [event('trackFileImported', '2026-01-01T00:00:05Z', 10)],
      },
      {
        n: 2,
        files: [
          { dateAdded: '2026-01-01T00:00:00Z', trackId: 20 },
          { dateAdded: '2026-06-01T00:00:00Z', trackId: 21 },
        ],
        events: [
          event('trackFileImported', '2026-01-01T00:00:05Z', 20),
          event('trackFileImported', '2026-06-01T00:00:05Z', 21),
        ],
      },
    ];
    answerWith(fakeLidarr(fake));
    const agent = await loginAs(app);

    const res = await agent.get('/api/v1/music/recentlyadded');

    assert.deepStrictEqual(ids(res), [1, 2].map(albumMbid));
  });

  it('asks the last page of the import history and no page after it', async () => {
    // 3 imports, two to a page: the oldest album, never imported later, cannot
    // be placed from the first page
    const fake: FakeAlbum[] = [1, 2, 3].map((n) => ({
      n,
      files: [{ dateAdded: `2026-01-0${n}T00:00:00Z`, trackId: n * 10 }],
      events: [event('trackFileImported', `2026-01-0${n}T00:00:05Z`, n * 10)],
    }));
    // and a fourth, found by a scan before them all: no import to read
    fake.push({
      n: 4,
      files: [{ dateAdded: '2025-12-01T00:00:00Z', trackId: 40 }],
      events: [],
    });
    answerWith(fakeLidarr(fake, 2));
    const agent = await loginAs(app);

    const res = await agent.get('/api/v1/music/recentlyadded');

    assert.deepStrictEqual(ids(res), [3, 2, 1, 4].map(albumMbid));
    assert.deepStrictEqual(
      called('getImportHistory').map((c) => c.args[0]),
      [1, 2]
    );
  });

  it('ends where a page of the import history comes back empty, however many records it says it holds', async () => {
    const fake: FakeAlbum[] = [
      {
        n: 1,
        files: [{ dateAdded: '2026-01-10T00:00:00Z', trackId: 11 }],
        events: [],
      },
    ];
    answerWith({
      ...fakeLidarr(fake),
      importHistory: (page, pageSize) => {
        if (page > 20) {
          return new Error(
            'asked page after page of an answer with no records'
          );
        }

        return { page, pageSize, totalRecords: 100000, records: [] };
      },
    });
    const agent = await loginAs(app);

    const res = await agent.get('/api/v1/music/recentlyadded');

    assert.deepStrictEqual(ids(res), [albumMbid(1)]);
  });

  it('places an album whose files carry no readable date after those that do, and answers nothing where none holds a file', async () => {
    answerWith({
      albums: [lidarrAlbum(1, 1), lidarrAlbum(2, 1), lidarrAlbum(3, 1)],
      // album 1 has no track file answered, album 3's file is from 1960
      trackFiles: [
        trackFile(2, '2026-01-01T00:00:00Z'),
        trackFile(3, '1960-01-01T00:00:00Z'),
      ],
    });
    const agent = await loginAs(app);

    const res = await agent.get('/api/v1/music/recentlyadded');

    assert.deepStrictEqual(ids(res), [2, 3, 1].map(albumMbid));
    mock.restoreAll();

    answerWith({ albums: [lidarrAlbum(1, 0), lidarrAlbum(2, 0)] });
    const none = await agent.get('/api/v1/music/recentlyadded');

    assert.deepStrictEqual(none.body, { results: [] });
  });

  // 30 albums imported one a day in January; 3 came back on March 1 (its
  // time), 7 was given a second track on March 15 (its latest import is the
  // latest of all, its time is not)
  const thirty = (): FakeAlbum[] => {
    const day = (n: number) => `2026-01-${String(n).padStart(2, '0')}`;
    const fake: FakeAlbum[] = Array.from({ length: 30 }, (_, i) => {
      const n = i + 1;

      return {
        n,
        files: [{ dateAdded: `${day(n)}T00:00:00Z`, trackId: n * 10 }],
        events: [event('trackFileImported', `${day(n)}T00:00:05Z`, n * 10)],
      };
    });

    fake[2].files = [{ dateAdded: '2026-03-01T00:00:00Z', trackId: 30 }];
    fake[2].events = [
      event('trackFileImported', '2026-01-03T00:00:05Z', 30),
      event('trackFileDeleted', '2026-02-01T00:00:00Z', 30, 'Manual'),
      event('trackFileImported', '2026-03-01T00:10:00Z', 30),
    ];
    fake[6].files.push({ dateAdded: '2026-03-15T00:00:00Z', trackId: 71 });
    fake[6].events.push(event('trackFileImported', '2026-03-15T00:00:05Z', 71));

    return fake;
  };
  const rightTwenty = [3, ...Array.from({ length: 19 }, (_, i) => 30 - i)].map(
    albumMbid
  );

  it('still answers the right 20 in the right order where it stops early, reading fewer albums than Lidarr holds', async () => {
    const fake = thirty();
    answerWith(fakeLidarr(fake));
    const agent = await loginAs(app);

    const res = await agent.get('/api/v1/music/recentlyadded');

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(
      ids(res),
      expectedOrder(fake).slice(0, 20).map(albumMbid)
    );
    assert.deepStrictEqual(ids(res), rightTwenty);
    // 7 and 3 first (the latest bounds), then 30 down to 8 in fives; 6 and the
    // albums before it are never read
    assert.strictEqual(called('getAlbumHistory').length, 25);
    assert.strictEqual(called('getTracks').length, 25);
    assert.strictEqual(called('getImportHistory').length, 1);
  });

  it('reads further pages of the import history only as the order needs, and answers the same 20', async () => {
    const fake = thirty();
    // 32 records, newest first, ten to a page: Mar 15, Mar 1, Jan 30..23 |
    // Jan 22..14, 13 | ... - the order is decided before the last page
    answerWith(fakeLidarr(fake, 10));
    const agent = await loginAs(app);

    const res = await agent.get('/api/v1/music/recentlyadded');

    assert.deepStrictEqual(ids(res), rightTwenty);
    assert.deepStrictEqual(
      called('getImportHistory').map((c) => c.args[0]),
      [1, 2, 3]
    );
  });

  it('answers {results: []} and logs where a history, a track list or the import history cannot be read', async () => {
    const fake: FakeAlbum[] = [
      {
        n: 1,
        files: [{ dateAdded: '2026-01-10T00:00:00Z', trackId: 11 }],
        events: [event('trackFileImported', '2026-01-10T00:00:05Z', 11)],
      },
    ];
    const cases: [string, Partial<Answers>][] = [
      ['album history', { history: () => new Error('[Lidarr] history') }],
      ['tracks', { tracks: () => new Error('[Lidarr] tracks') }],
      [
        'import history',
        { importHistory: () => new Error('[Lidarr] import history') },
      ],
    ];

    for (const [, failing] of cases) {
      const error = mock.method(logger, 'error', () => logger);
      answerWith({ ...fakeLidarr(fake), ...failing });
      const agent = await loginAs(app);

      const res = await agent.get('/api/v1/music/recentlyadded');

      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body, { results: [] });
      assert.strictEqual(error.mock.callCount(), 1);
      assert.match(String(error.mock.calls[0].arguments[0]), /recently added/);
      mock.restoreAll();
    }
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

// A clock the test drives: the route reads the time and sets its timers on it
// (sliderClock), so a deadline is passed by advancing it, never by waiting.
function driveClock() {
  let now = 0;
  // once a test has failed, every timer fires at once, so the route ends
  let released = false;
  const timers = new Set<{ at: number; fn: () => void }>();

  mock.method(sliderClock, 'now', () => now);
  mock.method(sliderClock, 'setTimer', (ms: number, fn: () => void) => {
    const timer = { at: now + ms, fn };

    if (released) {
      queueMicrotask(fn);
    }

    timers.add(timer);

    return () => timers.delete(timer);
  });

  return {
    // the times the timers still set are due at
    due: () => [...timers].map((timer) => timer.at).sort((a, b) => a - b),
    // waits (really) until the route has got as far as a condition says
    async until(condition: () => boolean) {
      for (let i = 0; i < 800 && !condition(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      if (!condition()) {
        // let the route end, so that a failing test does not hang the run
        released = true;
        this.advanceTo(Number.MAX_SAFE_INTEGER);
      }

      assert.ok(condition(), 'the route did not get there');
    },
    advanceTo(to: number) {
      now = to;

      for (const timer of [...timers]
        .filter((t) => t.at <= to)
        .sort((a, b) => a.at - b.at)) {
        timers.delete(timer);
        timer.fn();
      }
    },
  };
}

describe('GET /music/library/similar', () => {
  const PATH = '/api/v1/music/library/similar';
  // an artist Lidarr holds: id n; one it does not: n from 1000
  const library = (n: number) =>
    Array.from({ length: n }, (_, i) => lidarrArtist(i + 1));
  const outsider = (n: number, score: number): ListenBrainzSimilarArtist => ({
    mbid: artistMbid(1000 + n),
    name: `Outsider ${n}`,
    score,
  });
  const get = (agent: Awaited<ReturnType<typeof loginAs>>) => agent.get(PATH);
  const asked = () => called('getSimilarArtists').map((c) => c.args[0]);
  const never = <T>() => new Promise<T>(() => undefined);

  it("answers the artists similar to the library's, none of which Lidarr holds, as search-shaped artists with the metadata service's poster", async () => {
    answerWith({
      artists: library(2),
      similarOf: (mbid) =>
        mbid === artistMbid(1)
          ? [outsider(1, 50), { ...outsider(2, 40) }]
          : [outsider(1, 30)],
      metadata: (mbid) =>
        mbid === outsider(2, 0).mbid
          ? null
          : metadataWithPoster(`https://img.example/poster-${mbid}.jpg`),
    });
    const agent = await loginAs(app);

    const res = await get(agent);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.results, [
      {
        id: outsider(1, 0).mbid,
        mediaType: 'artist',
        name: 'Outsider 1',
        imageUrl: `https://img.example/poster-${outsider(1, 0).mbid}.jpg`,
      },
      { id: outsider(2, 0).mbid, mediaType: 'artist', name: 'Outsider 2' },
    ]);
  });

  it('reads the similar artists of at most 30 library artists, spread over the whole library by its ids, the same part at every load', async () => {
    // Lidarr answers in no order of ids
    const held = library(100).reverse();
    answerWith({ artists: held, similarOf: () => [] });
    const agent = await loginAs(app);

    await get(agent);
    const first = asked();
    calls = [];
    await get(agent);

    const expected = Array.from({ length: 30 }, (_, i) =>
      artistMbid(Math.floor((i * 100) / 30) + 1)
    );
    assert.deepStrictEqual([...first].sort(), [...expected].sort());
    assert.deepStrictEqual([...asked()].sort(), [...expected].sort());
    assert.ok(first.includes(artistMbid(1)) && first.includes(artistMbid(97)));
  });

  it('reads every artist of a library of 30 or fewer, each once', async () => {
    answerWith({ artists: library(25), similarOf: () => [] });
    const agent = await loginAs(app);

    await get(agent);

    assert.deepStrictEqual(
      [...asked()].sort(),
      library(25)
        .map((a) => a.foreignArtistId)
        .sort()
    );
  });

  it('reads the similar artists 6 at a time', async () => {
    let inFlight = 0;
    let most = 0;
    answerWith({
      artists: library(30),
      similarOf: () => {
        inFlight += 1;
        most = Math.max(most, inFlight);

        return new Promise((resolve) =>
          setTimeout(() => {
            inFlight -= 1;
            resolve([]);
          }, 2)
        );
      },
    });
    const agent = await loginAs(app);

    await get(agent);

    assert.strictEqual(asked().length, 30);
    assert.strictEqual(most, 6);
  });

  it("leaves out every artist Lidarr holds, the whole library and not only the part read, whatever ListenBrainz's answer holds", async () => {
    answerWith({
      artists: library(100),
      similarOf: () => [
        // 50 is held but not among the 30 read; 51 is held and read
        { mbid: artistMbid(50), name: 'Held, not read', score: 999 },
        { mbid: artistMbid(51), name: 'Held, read', score: 998 },
        outsider(1, 10),
      ],
    });
    const agent = await loginAs(app);

    const res = await get(agent);

    assert.ok(!asked().includes(artistMbid(50)), 'artist 50 is not read');
    assert.ok(asked().includes(artistMbid(51)), 'artist 51 is read');
    assert.deepStrictEqual(ids(res), [outsider(1, 0).mbid]);
  });

  it('reads the library at each call: an artist added to Lidarr leaves the answer from the next call', async () => {
    const held = library(2);
    answerWith({
      artists: held,
      similarOf: () => [outsider(1, 5), outsider(2, 4)],
    });
    const agent = await loginAs(app);

    const first = await get(agent);
    // Lidarr now holds the first artist the slider showed
    held.push({
      ...lidarrArtist(500),
      foreignArtistId: outsider(1, 0).mbid,
    });
    const second = await get(agent);

    assert.deepStrictEqual(ids(first), [
      outsider(1, 0).mbid,
      outsider(2, 0).mbid,
    ]);
    assert.deepStrictEqual(ids(second), [outsider(2, 0).mbid]);
    assert.strictEqual(called('getArtists').length, 2);
  });

  it('puts the artist similar to more of the library first, before the one with the better score', async () => {
    answerWith({
      artists: library(3),
      similarOf: (mbid) =>
        ({
          [artistMbid(1)]: [outsider(1, 10), outsider(2, 90)],
          [artistMbid(2)]: [outsider(1, 10)],
          [artistMbid(3)]: [outsider(3, 100)],
        })[mbid] ?? [],
    });
    const agent = await loginAs(app);

    const res = await get(agent);

    // 1 is similar to two library artists (best score 10), 3 to one (100), 2 to one (90)
    assert.deepStrictEqual(ids(res), [
      outsider(1, 0).mbid,
      outsider(3, 0).mbid,
      outsider(2, 0).mbid,
    ]);
  });

  it('puts equal counts by the best score, then by id', async () => {
    answerWith({
      artists: library(2),
      similarOf: (mbid) =>
        mbid === artistMbid(1)
          ? [outsider(9, 50), outsider(8, 50), outsider(7, 80), outsider(6, 20)]
          : [],
    });
    const agent = await loginAs(app);

    const res = await get(agent);

    assert.deepStrictEqual(ids(res), [
      outsider(7, 0).mbid,
      outsider(8, 0).mbid,
      outsider(9, 0).mbid,
      outsider(6, 0).mbid,
    ]);
  });

  it('answers at most 20', async () => {
    answerWith({
      artists: library(2),
      similarOf: () =>
        Array.from({ length: 30 }, (_, i) => outsider(i + 1, i + 1)),
    });
    const agent = await loginAs(app);

    const res = await get(agent);

    assert.deepStrictEqual(
      ids(res),
      Array.from({ length: 20 }, (_, i) => outsider(30 - i, 0).mbid)
    );
    assert.strictEqual(called('metadata').length, 20);
  });

  it('answers the same for every user: nothing of the user is read', async () => {
    answerWith({ artists: library(2), similarOf: () => [outsider(1, 5)] });
    const admin = await loginAs(app);

    const res = await get(admin);

    assert.deepStrictEqual(ids(res), [outsider(1, 0).mbid]);
    assert.ok(
      called('getArtists').every((c) => c.args.length === 0),
      'Lidarr is asked the same of every user'
    );
  });

  it('answers the status each artist has as an artist: requested by a whole-artist request, none otherwise', async () => {
    answerWith({
      artists: library(1),
      similarOf: () => [outsider(1, 5), outsider(2, 4)],
    });
    const row = await saveRow(
      outsider(1, 0).mbid,
      MusicKind.ARTIST,
      MediaStatus.UNKNOWN
    );
    await requestFor(row, MediaRequestStatus.PENDING);
    const agent = await loginAs(unvalidated);

    const res = await get(agent);

    assert.deepStrictEqual(
      res.body.results.map(
        (r: { mediaInfo?: { status: number } }) => r.mediaInfo?.status
      ),
      [MediaStatus.PENDING, undefined]
    );
  });

  it('leaves out the image of an artist whose image read fails, never the list', async () => {
    const error = mock.method(logger, 'error', () => logger);
    answerWith({
      artists: library(1),
      similarOf: () => [outsider(1, 5), outsider(2, 4)],
      metadata: (mbid) =>
        mbid === outsider(1, 0).mbid
          ? new Error('[Lidarr Metadata] boom')
          : metadataWithPoster('https://img.example/p2.jpg'),
    });
    const agent = await loginAs(app);

    const res = await get(agent);

    assert.deepStrictEqual(
      res.body.results.map((r: { imageUrl?: string }) => r.imageUrl),
      [undefined, 'https://img.example/p2.jpg']
    );
    assert.strictEqual(error.mock.callCount(), 1);
  });

  it('answers {results: []} where Lidarr holds no artist, reading nothing of ListenBrainz', async () => {
    answerWith({ artists: [], similarOf: () => [outsider(1, 5)] });
    const agent = await loginAs(app);

    const res = await get(agent);

    assert.deepStrictEqual(res.body, { results: [] });
    assert.strictEqual(asked().length, 0);
  });

  it('answers {results: []} and logs where Lidarr fails to list its artists', async () => {
    const error = mock.method(logger, 'error', () => logger);
    answerWith({ artists: new Error('[Lidarr] boom') });
    const agent = await loginAs(app);

    const res = await get(agent);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { results: [] });
    assert.ok(error.mock.callCount() >= 1);
  });

  it('answers {results: []} where every read of ListenBrainz fails (the client answers none)', async () => {
    answerWith({ artists: library(5), similarOf: () => [] });
    const agent = await loginAs(app);

    const res = await get(agent);

    assert.deepStrictEqual(res.body, { results: [] });
    assert.strictEqual(called('metadata').length, 0);
  });

  describe('the deadlines, counted from when the route began', () => {
    it('sends the answer by 6 seconds from reads that never answer, counting those that answered, and begins no read after it', async () => {
      const clock = driveClock();
      // the reads that do not answer in time answer, empty, after the deadline
      const late: (() => void)[] = [];
      answerWith({
        artists: library(30),
        similarOf: (mbid) =>
          mbid === artistMbid(1) || mbid === artistMbid(2)
            ? [outsider(1, 50), outsider(2, 40)]
            : new Promise((resolve) => late.push(() => resolve([]))),
        metadata: () => metadataWithPoster('https://img.example/p.jpg'),
      });
      const agent = await loginAs(app);

      const answer = get(agent).then((res) => res);
      await clock.until(() => clock.due().includes(6000));
      // two answered; six now wait for ever
      assert.strictEqual(asked().length, 8);
      clock.advanceTo(6000);
      const res = await answer;

      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(ids(res), [
        outsider(1, 0).mbid,
        outsider(2, 0).mbid,
      ]);
      late.forEach((answerNow) => answerNow());
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.strictEqual(asked().length, 8, 'no read began after the deadline');
    });

    it('sends the answer by 8 seconds from an image read that never answers, that image none, the other images kept', async () => {
      const clock = driveClock();
      answerWith({
        artists: library(2),
        similarOf: () => [outsider(1, 50), outsider(2, 40)],
        metadata: (mbid) =>
          mbid === outsider(1, 0).mbid
            ? never()
            : metadataWithPoster('https://img.example/p2.jpg'),
      });
      const agent = await loginAs(app);

      const answer = get(agent).then((res) => res);
      // the reads of ListenBrainz answered at once; the image still waited for is due
      // 8 seconds from the route's start, not 8 seconds from when the images began
      await clock.until(() => clock.due().length > 0);
      assert.deepStrictEqual(clock.due(), [8000]);
      clock.advanceTo(8000);
      const res = await answer;

      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(
        res.body.results.map((r: { name: string; imageUrl?: string }) => [
          r.name,
          r.imageUrl,
        ]),
        [
          ['Outsider 1', undefined],
          ['Outsider 2', 'https://img.example/p2.jpg'],
        ]
      );
    });

    it('waits for the images until 8 seconds from the route start where the reads of ListenBrainz ran to their 6', async () => {
      const clock = driveClock();
      answerWith({
        artists: library(3),
        similarOf: (mbid) =>
          mbid === artistMbid(1) ? [outsider(1, 5)] : never(),
        metadata: () => never(),
      });
      const agent = await loginAs(app);

      const answer = get(agent).then((res) => res);
      await clock.until(() => clock.due().includes(6000));
      clock.advanceTo(6000);
      // the image is due at 8000 from the start, 2 seconds from now
      await clock.until(() => clock.due().includes(8000));
      assert.deepStrictEqual(clock.due(), [8000]);
      clock.advanceTo(8000);
      const res = await answer;

      assert.deepStrictEqual(res.body.results, [
        { id: outsider(1, 0).mbid, mediaType: 'artist', name: 'Outsider 1' },
      ]);
    });

    it('answers {results: []} by 6 seconds where Lidarr never lists its artists, reading nothing of ListenBrainz', async () => {
      const clock = driveClock();
      const error = mock.method(logger, 'error', () => logger);
      answerWith({ artists: never(), similarOf: () => [outsider(1, 5)] });
      const agent = await loginAs(app);

      const answer = get(agent).then((res) => res);
      await clock.until(() => clock.due().includes(6000));
      clock.advanceTo(6000);
      const res = await answer;

      assert.deepStrictEqual(res.body, { results: [] });
      assert.strictEqual(asked().length, 0);
      assert.ok(error.mock.callCount() >= 1);
    });

    it('gives the reads of ListenBrainz what is left of the 6 seconds when Lidarr listed its artists late', async () => {
      const clock = driveClock();
      let list: (artists: LidarrArtist[]) => void = () => undefined;
      answerWith({
        artists: new Promise<LidarrArtist[]>((resolve) => (list = resolve)),
        similarOf: () => never(),
      });
      const agent = await loginAs(app);

      const answer = get(agent).then((res) => res);
      await clock.until(() => clock.due().includes(6000));
      clock.advanceTo(4000);
      list(library(2));
      // the reads are due at 6000 from the start, 2 seconds from when they began
      await clock.until(() => asked().length === 2);
      assert.deepStrictEqual(clock.due(), [6000]);
      clock.advanceTo(6000);
      const res = await answer;

      assert.deepStrictEqual(res.body, { results: [] });
    });
  });
});

describe('GET /music/artist/:mbid/similar', () => {
  const similarOf = (n: number): ListenBrainzSimilarArtist => ({
    mbid: artistMbid(n),
    name: `Similar ${n}`,
    score: 100 - n,
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
