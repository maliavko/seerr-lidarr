import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import type { LidarrMetadataArtist } from '@server/api/lidarrmetadata';
import { getLidarrMetadata } from '@server/api/lidarrmetadata';
import type {
  MusicBrainzRelease,
  MusicBrainzReleaseGroup,
} from '@server/api/musicbrainz';
import { getMusicBrainz } from '@server/api/musicbrainz';
import type {
  LidarrAlbum,
  LidarrArtist,
  LidarrTrack,
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
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express, { Router } from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import session from 'express-session';
import yaml from 'js-yaml';
import request from 'supertest';
import authRoutes from './auth';
import musicRoutes from './music';

const API_SPEC_PATH = join(__dirname, '../../seerr-api.yml');

const RADIOHEAD = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const OK_COMPUTER = 'b1392450-e666-3926-a536-22c65f834433';
const KID_A = 'e75c0549-ad55-39e3-8025-c72c5d4a3c5d';
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

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

// The routes as routes/index.ts mounts them behind authentication, with the
// OpenAPI validator of server/index.ts in front of them and validating what
// they answer too, so seerr-api.yml is held to describe the answers (PIL-API).
// A request's requestedBy is filtered of its email as /movie/:id's is, which
// the User schema already requires: the one test with a request answers
// unvalidated.
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
      // sign-in is the routes' own check (isAuthenticated), not the validator's
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

async function loginAs(app: Express, email = 'admin@seerr.dev') {
  const settings = getSettings();
  const prior = settings.main.localLogin;
  settings.main.localLogin = true;

  try {
    const agent = request.agent(app);
    const res = await agent
      .post('/auth/local')
      .send({ email, password: 'test1234' });
    assert.strictEqual(res.status, 200);
    return agent;
  } finally {
    settings.main.localLogin = prior;
  }
}

interface Answers {
  getArtists?: LidarrArtist[] | Error;
  getAlbums?: LidarrAlbum[] | Error;
  lookupArtistByMbid?: LidarrArtist | null | Error;
  lookupAlbumByMbid?: LidarrAlbum | null | Error;
  getTracks?: LidarrTrack[] | Error;
  artistAlbums?: MusicBrainzReleaseGroup[] | Error;
  release?: MusicBrainzRelease | Error;
  // Lidarr's metadata service: an artist, an Error, or null for an unknown id
  metadata?: LidarrMetadataArtist | null | Error;
}

const RELEASE: MusicBrainzRelease = {
  id: '30702389-5c67-4438-9ea0-2351c8de0f1d',
  title: 'OK Computer',
  media: [
    {
      position: 1,
      tracks: [
        { id: 't1', number: '1', position: 1, title: 'Airbag', length: 284000 },
        {
          id: 't2',
          number: '2',
          position: 2,
          title: 'Paranoid Android',
          length: null,
        },
      ],
    },
  ],
};

let lidarrCalls: string[];

// Lidarr's and MusicBrainz's answers, as the service finds them
function answerWith(answers: Answers) {
  const proto = LidarrAPI.prototype;
  const reply =
    <T>(call: string, value: T | Error | undefined, fallback: T) =>
    () => {
      lidarrCalls.push(call);
      const v = value === undefined ? fallback : value;
      return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
    };

  mock.method(proto, 'getArtists', reply('getArtists', answers.getArtists, []));
  mock.method(proto, 'getAlbums', reply('getAlbums', answers.getAlbums, []));
  mock.method(
    proto,
    'lookupArtistByMbid',
    reply('lookupArtistByMbid', answers.lookupArtistByMbid, null)
  );
  mock.method(
    proto,
    'lookupAlbumByMbid',
    reply('lookupAlbumByMbid', answers.lookupAlbumByMbid, null)
  );
  mock.method(proto, 'getTracks', reply('getTracks', answers.getTracks, []));
  mock.method(
    getLidarrMetadata(),
    'getArtist',
    reply('lidarrmetadata artist', answers.metadata, null)
  );
  mock.method(
    getMusicBrainz(),
    'getArtistAlbums',
    reply('musicbrainz artist albums', answers.artistAlbums, [])
  );
  mock.method(
    getMusicBrainz(),
    'getRelease',
    reply('musicbrainz release', answers.release, RELEASE)
  );
}

// Lidarr's metadata service's answer for Radiohead, recorded from api.lidarr.audio
const radioheadMetadata = () =>
  JSON.parse(
    readFileSync(
      join(
        __dirname,
        '..',
        'api',
        'lidarrmetadata',
        'lidarrmetadata.fixtures',
        'artist-radiohead.json'
      ),
      'utf8'
    )
  ) as LidarrMetadataArtist;
const heldArtist = () => lidarrFixture<LidarrArtist[]>('artists')[0];
const heldAlbums = () => lidarrFixture<LidarrAlbum[]>('albums');
const lookedUpArtist = () =>
  lidarrFixture<LidarrArtist[]>('artist-lookup-mbid')[0];
const lookedUpAlbum = () =>
  lidarrFixture<LidarrAlbum[]>('album-lookup-mbid')[0];

let app: Express;
let unvalidated: Express;

before(() => {
  app = createApp();
  unvalidated = createApp({ validateResponses: false });
});

setupTestDb();

beforeEach(() => {
  lidarrCalls = [];
  getSettings().lidarr = [{ ...server }];
  cacheManager.getCache('lidarr').flush();
  cacheManager.getCache('musicbrainz').flush();
  cacheManager.getCache('lidarrmetadata').flush();
});

afterEach(() => mock.restoreAll());

async function saveMusicMedia(
  mbid: string,
  kind: MusicKind,
  status: MediaStatus,
  artistMbid?: string
): Promise<Media> {
  return getRepository(Media).save(
    new Media({
      mediaType: MediaType.MUSIC,
      musicBrainzId: mbid,
      musicKind: kind,
      artistMusicBrainzId: artistMbid,
      status,
      status4k: MediaStatus.UNKNOWN,
    })
  );
}

describe('GET /music/artist/:mbid', () => {
  it('is behind authentication', async () => {
    answerWith({ lookupArtistByMbid: lookedUpArtist() });

    const res = await request(unvalidated).get(
      `/api/v1/music/artist/${RADIOHEAD}`
    );

    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(lidarrCalls, []);
  });

  it('answers every field D-101 sets for an artist Lidarr does not hold, its albums from MusicBrainz', async () => {
    const lookup = lookedUpArtist();
    answerWith({
      lookupArtistByMbid: lookup,
      artistAlbums: [
        {
          id: OK_COMPUTER,
          title: 'OK Computer',
          'primary-type': 'Album',
          'secondary-types': [],
          'first-release-date': '1997-05-21',
        },
        { id: KID_A, title: 'Kid A', 'primary-type': 'Album' },
      ],
    });

    const agent = await loginAs(app);
    const res = await agent.get(`/api/v1/music/artist/${RADIOHEAD}`);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, {
      id: RADIOHEAD,
      name: 'Radiohead',
      overview: lookup.overview,
      imageUrl:
        'https://images.lidarr.audio/cache/https://assets.fanart.tv/fanart/radiohead-4faa76dca1bba.jpg',
      backdropUrl:
        'https://images.lidarr.audio/cache/https://assets.fanart.tv/fanart/radiohead-4e68f40838818.jpg',
      artistType: 'Group',
      genres: lookup.genres,
      inLidarr: false,
      albums: [
        // the dated album first, an undated one last
        {
          id: OK_COMPUTER,
          title: 'OK Computer',
          releaseDate: '1997-05-21',
          albumType: 'Album',
          secondaryTypes: [],
          coverUrl: `https://coverartarchive.org/release-group/${OK_COMPUTER}/front-250`,
        },
        {
          id: KID_A,
          title: 'Kid A',
          albumType: 'Album',
          secondaryTypes: [],
          coverUrl: `https://coverartarchive.org/release-group/${KID_A}/front-250`,
        },
      ],
    });
    assert.ok(lookup.genres && lookup.genres.length > 1);
    assert.ok(!('mediaInfo' in res.body), 'no media row, no mediaInfo');
  });

  it("answers an artist Lidarr holds from Lidarr's record and its albums, with the image, backdrop and overview from Lidarr's metadata service", async () => {
    const albums = heldAlbums();
    const service = radioheadMetadata();
    answerWith({
      getArtists: [heldArtist()],
      getAlbums: albums,
      lookupArtistByMbid: lookedUpArtist(),
      metadata: service,
    });

    const agent = await loginAs(app);
    const res = await agent.get(`/api/v1/music/artist/${RADIOHEAD}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.id, RADIOHEAD);
    assert.strictEqual(res.body.name, 'Radiohead');
    assert.strictEqual(res.body.inLidarr, true);
    assert.strictEqual(res.body.artistType, 'Group');
    assert.strictEqual(
      res.body.imageUrl,
      service.images?.find((image) => image.CoverType === 'Poster')?.Url
    );
    assert.strictEqual(
      res.body.backdropUrl,
      service.images?.find((image) => image.CoverType === 'Fanart')?.Url
    );
    assert.match(res.body.imageUrl, /^https:\/\/images\.lidarr\.audio\//);
    assert.match(res.body.backdropUrl, /^https:\/\/images\.lidarr\.audio\//);
    assert.strictEqual(res.body.overview, service.overview);
    // never the lookup of a held artist
    assert.ok(!lidarrCalls.includes('lookupArtistByMbid'));
    assert.ok(lidarrCalls.includes('lidarrmetadata artist'));
    assert.ok(!('disambiguation' in res.body), 'an empty one is left out');
    assert.deepStrictEqual(
      res.body.albums.map((a: { id: string }) => a.id),
      // the latest release first
      [...albums]
        .sort(
          (a, b) =>
            (b.releaseDate ?? '').localeCompare(a.releaseDate ?? '') ||
            a.title.localeCompare(b.title)
        )
        .map((a) => a.foreignAlbumId)
    );
    for (const album of res.body.albums) {
      assert.deepStrictEqual(
        Object.keys(album)
          .filter((k) => k !== 'mediaInfo')
          .sort(),
        [
          'albumType',
          'coverUrl',
          'id',
          'releaseDate',
          'secondaryTypes',
          'title',
          'trackCount',
        ]
      );
    }
    assert.ok(!lidarrCalls.includes('musicbrainz artist albums'));
  });

  it('carries the media row of the artist as its mediaInfo, with its requests', async () => {
    answerWith({ lookupArtistByMbid: lookedUpArtist() });
    const media = await saveMusicMedia(
      RADIOHEAD,
      MusicKind.ARTIST,
      MediaStatus.PARTIALLY_AVAILABLE
    );
    const owner = await getRepository(User).findOneByOrFail({
      email: 'admin@seerr.dev',
    });
    await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.MUSIC,
        media,
        requestedBy: owner,
        modifiedBy: owner,
        status: MediaRequestStatus.PENDING,
        is4k: false,
      })
    );

    const agent = await loginAs(unvalidated);
    const res = await agent.get(`/api/v1/music/artist/${RADIOHEAD}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.mediaInfo.id, media.id);
    assert.strictEqual(
      res.body.mediaInfo.status,
      MediaStatus.PARTIALLY_AVAILABLE
    );
    assert.strictEqual(res.body.mediaInfo.mediaType, 'music');
    assert.strictEqual(res.body.mediaInfo.musicBrainzId, RADIOHEAD);
    assert.strictEqual(res.body.mediaInfo.musicKind, 'artist');
    assert.strictEqual(res.body.mediaInfo.tmdbId, null);
    assert.strictEqual(res.body.mediaInfo.requests.length, 1);
    assert.strictEqual(
      res.body.mediaInfo.requests[0].status,
      MediaRequestStatus.PENDING
    );
  });

  it('does not take the album row of the same id for the artist', async () => {
    answerWith({ lookupArtistByMbid: lookedUpArtist() });
    await saveMusicMedia(RADIOHEAD, MusicKind.ALBUM, MediaStatus.AVAILABLE);

    const agent = await loginAs(app);
    const res = await agent.get(`/api/v1/music/artist/${RADIOHEAD}`);

    assert.strictEqual(res.status, 200);
    assert.ok(!('mediaInfo' in res.body));
  });

  it("gives each album of the artist the media row of that album, read apart from the artist's", async () => {
    answerWith({
      lookupArtistByMbid: lookedUpArtist(),
      artistAlbums: [
        { id: OK_COMPUTER, title: 'OK Computer', 'primary-type': 'Album' },
        { id: KID_A, title: 'Kid A', 'primary-type': 'Album' },
      ],
    });
    const album = await saveMusicMedia(
      OK_COMPUTER,
      MusicKind.ALBUM,
      MediaStatus.AVAILABLE,
      RADIOHEAD
    );
    // an artist row of the same id as an album must not stand for it
    await saveMusicMedia(KID_A, MusicKind.ARTIST, MediaStatus.AVAILABLE);

    const agent = await loginAs(app);
    const res = await agent.get(`/api/v1/music/artist/${RADIOHEAD}`);

    assert.strictEqual(res.status, 200);
    const byId = (id: string) =>
      res.body.albums.find((a: { id: string }) => a.id === id);
    const [first, second] = [byId(OK_COMPUTER), byId(KID_A)];
    assert.strictEqual(first.mediaInfo.id, album.id);
    assert.strictEqual(first.mediaInfo.status, MediaStatus.AVAILABLE);
    assert.strictEqual(first.mediaInfo.musicKind, 'album');
    assert.strictEqual(first.mediaInfo.artistMusicBrainzId, RADIOHEAD);
    assert.ok(!('mediaInfo' in second));
    assert.ok(!('mediaInfo' in res.body));
  });

  it('answers 404 for an id the source does not know', async () => {
    answerWith({ lookupArtistByMbid: null });

    const agent = await loginAs(app);
    const res = await agent.get(`/api/v1/music/artist/${UNKNOWN}`);

    assert.strictEqual(res.status, 404);
    assert.strictEqual(typeof res.body.message, 'string');
  });

  it('answers 404, asking no source, where no Lidarr server is the default', async () => {
    answerWith({ lookupArtistByMbid: lookedUpArtist() });
    getSettings().lidarr = [{ ...server, isDefault: false }];

    const agent = await loginAs(app);
    const res = await agent.get(`/api/v1/music/artist/${RADIOHEAD}`);

    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(lidarrCalls, []);

    getSettings().lidarr = [];
    assert.strictEqual(
      (await agent.get(`/api/v1/music/artist/${RADIOHEAD}`)).status,
      404
    );
    assert.deepStrictEqual(lidarrCalls, []);
  });

  it('answers 500 with its message where the source fails on the artist itself', async () => {
    answerWith({ lookupArtistByMbid: new Error('Lidarr is down') });

    const agent = await loginAs(app);
    const res = await agent.get(`/api/v1/music/artist/${RADIOHEAD}`);

    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.body.message, 'Unable to retrieve artist.');
  });

  it('answers 200 with an empty album list where only the album list fails', async () => {
    answerWith({
      lookupArtistByMbid: lookedUpArtist(),
      artistAlbums: new Error('MusicBrainz is down'),
    });

    const agent = await loginAs(app);
    const res = await agent.get(`/api/v1/music/artist/${RADIOHEAD}`);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.albums, []);
    assert.strictEqual(res.body.name, 'Radiohead');
  });

  it('refuses an id that is not a uuid with 400, asking no source', async () => {
    answerWith({ lookupArtistByMbid: lookedUpArtist() });

    const agent = await loginAs(app);
    const res = await agent.get('/api/v1/music/artist/not-an-id');

    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(lidarrCalls, []);
  });
});

describe('GET /music/album/:mbid', () => {
  it('is behind authentication', async () => {
    answerWith({ lookupAlbumByMbid: lookedUpAlbum() });

    const res = await request(unvalidated).get(
      `/api/v1/music/album/${OK_COMPUTER}`
    );

    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(lidarrCalls, []);
  });

  it('answers every field D-101 sets for an album Lidarr does not hold, its tracks from MusicBrainz', async () => {
    const lookup = lookedUpAlbum();
    answerWith({ lookupAlbumByMbid: lookup });

    const agent = await loginAs(app);
    const res = await agent.get(`/api/v1/music/album/${OK_COMPUTER}`);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, {
      id: OK_COMPUTER,
      title: 'OK Computer',
      artist: { id: RADIOHEAD, name: 'Radiohead' },
      releaseDate: '1997-05-21T00:00:00Z',
      albumType: 'Album',
      secondaryTypes: [],
      coverUrl: lookup.images?.find((i) => i.coverType === 'cover')?.remoteUrl,
      genres: lookup.genres,
      inLidarr: false,
      tracks: [
        { disc: 1, position: 1, number: '1', title: 'Airbag', length: 284000 },
        { disc: 1, position: 2, number: '2', title: 'Paranoid Android' },
      ],
    });
    assert.ok(lookup.genres && lookup.genres.length > 1);
  });

  it("answers an album Lidarr holds with Lidarr's tracks, number, disc, position and length", async () => {
    const held = {
      ...lookedUpAlbum(),
      id: 45,
      overview: 'The third album.',
      disambiguation: 'remaster',
    };
    answerWith({
      lookupAlbumByMbid: held,
      getTracks: lidarrFixture<LidarrTrack[]>('tracks'),
    });

    const agent = await loginAs(app);
    const res = await agent.get(`/api/v1/music/album/${OK_COMPUTER}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.inLidarr, true);
    assert.strictEqual(res.body.overview, 'The third album.');
    assert.strictEqual(res.body.disambiguation, 'remaster');
    assert.deepStrictEqual(res.body.tracks[0], {
      disc: 1,
      position: 1,
      number: 'A1',
      title: 'Airbag',
      length: 284000,
    });
    assert.ok(res.body.tracks.length > 1);
    assert.ok(!lidarrCalls.includes('musicbrainz release'));
  });

  it('carries the media row of the album as its mediaInfo, and none without one', async () => {
    answerWith({ lookupAlbumByMbid: lookedUpAlbum() });

    const agent = await loginAs(app);
    const without = await agent.get(`/api/v1/music/album/${OK_COMPUTER}`);

    assert.strictEqual(without.status, 200);
    assert.ok(!('mediaInfo' in without.body));

    const media = await saveMusicMedia(
      OK_COMPUTER,
      MusicKind.ALBUM,
      MediaStatus.AVAILABLE,
      RADIOHEAD
    );
    // the artist row of that id is not the album's
    await saveMusicMedia(OK_COMPUTER, MusicKind.ARTIST, MediaStatus.PENDING);

    const res = await agent.get(`/api/v1/music/album/${OK_COMPUTER}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.mediaInfo.id, media.id);
    assert.strictEqual(res.body.mediaInfo.status, MediaStatus.AVAILABLE);
    assert.strictEqual(res.body.mediaInfo.musicKind, 'album');
    assert.strictEqual(res.body.mediaInfo.musicBrainzId, OK_COMPUTER);
    assert.strictEqual(res.body.mediaInfo.artistMusicBrainzId, RADIOHEAD);
    assert.deepStrictEqual(res.body.mediaInfo.requests, []);
  });

  it('answers 404 for an id the source does not know', async () => {
    answerWith({ lookupAlbumByMbid: null });

    const agent = await loginAs(app);
    const res = await agent.get(`/api/v1/music/album/${UNKNOWN}`);

    assert.strictEqual(res.status, 404);
    assert.strictEqual(typeof res.body.message, 'string');
  });

  it('answers 404, asking no source, where no Lidarr server is the default', async () => {
    answerWith({ lookupAlbumByMbid: lookedUpAlbum() });
    getSettings().lidarr = [];

    const agent = await loginAs(app);
    const res = await agent.get(`/api/v1/music/album/${OK_COMPUTER}`);

    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(lidarrCalls, []);
  });

  it('answers 500 with its message where the source fails on the album itself', async () => {
    answerWith({ lookupAlbumByMbid: new Error('Lidarr is down') });

    const agent = await loginAs(app);
    const res = await agent.get(`/api/v1/music/album/${OK_COMPUTER}`);

    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.body.message, 'Unable to retrieve album.');
  });

  it('answers 200 with an empty track list where only the tracks fail', async () => {
    answerWith({
      lookupAlbumByMbid: { ...lookedUpAlbum(), id: 45 },
      getTracks: new Error('Lidarr is down'),
    });

    const agent = await loginAs(app);
    const res = await agent.get(`/api/v1/music/album/${OK_COMPUTER}`);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.tracks, []);
    assert.strictEqual(res.body.title, 'OK Computer');
  });

  it('refuses an id that is not a uuid with 400', async () => {
    answerWith({ lookupAlbumByMbid: lookedUpAlbum() });

    const agent = await loginAs(app);
    const res = await agent.get('/api/v1/music/album/12345');

    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(lidarrCalls, []);
  });
});

describe('seerr-api.yml', () => {
  it("describes MediaInfo's three music properties as optional, nullable strings of music rows (D-121)", () => {
    const spec = yaml.load(readFileSync(API_SPEC_PATH, 'utf8')) as {
      components: {
        schemas: {
          MediaInfo: {
            required?: string[];
            properties: Record<string, { type: string; nullable?: boolean }>;
          };
        };
      };
    };
    const mediaInfo = spec.components.schemas.MediaInfo;

    for (const name of ['musicBrainzId', 'musicKind', 'artistMusicBrainzId']) {
      assert.strictEqual(mediaInfo.properties[name]?.type, 'string', name);
      assert.strictEqual(mediaInfo.properties[name]?.nullable, true, name);
      assert.ok(!(mediaInfo.required ?? []).includes(name), name);
    }
  });
});
