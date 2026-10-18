import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import { getLidarrMetadata } from '@server/api/lidarrmetadata';
import { getMusicBrainz } from '@server/api/musicbrainz';
import type { LidarrAlbum, LidarrArtist } from '@server/api/servarr/lidarr';
import LidarrAPI from '@server/api/servarr/lidarr';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
  MusicKind,
} from '@server/constants/media';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import OverrideRule from '@server/entity/OverrideRule';
import { User } from '@server/entity/User';
import cacheManager from '@server/lib/cache';
import notificationManager from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import {
  burialUnderOtherProfile,
  listedAlbum,
  savedProfileAnswer,
} from '@server/test/musicProfiles';
import {
  MethodStubs,
  authenticated,
  createRoutesApp,
  loginAs,
} from '@server/test/musicRows';
import type { Express } from 'express';
import { Router } from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import type { EntityManager } from 'typeorm';
import requestRoutes from './request';
import userRoutes from './user';

// The music request's API (D-311, D-301, D-362, D-8): POST /request for music,
// the permissions read on whom a movie request's are, what it refuses, what it
// skips, the routes on a request, the edit, and the lists; each beside a movie
// and a TV request whose answers are unchanged.

const API_SPEC_PATH = join(__dirname, '../../seerr-api.yml');

const RADIOHEAD = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const OK_COMPUTER = 'b1392450-e666-3926-a536-22c65f834433';
const KID_A = 'e75c0549-ad55-39e3-8025-c72c5d4a3c5d';
const AMNESIAC = '7e8e1f5e-6a4b-3e2a-8f0a-3b1b2c5f1d11';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

const fixture = <T>(name: string): T =>
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

const lidarrServer = {
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

function configureRadarr(): void {
  getSettings().radarr = [
    {
      id: 0,
      name: 'Radarr 0',
      hostname: 'localhost',
      port: 7878,
      apiKey: 'test-key',
      baseUrl: '',
      useSsl: false,
      activeProfileId: 1,
      activeDirectory: '/movies',
      is4k: false,
      minimumAvailability: 'released',
      tags: [],
      isDefault: true,
      syncEnabled: true,
      preventSearch: false,
      externalUrl: '',
    } as Partial<RadarrSettings>,
  ] as RadarrSettings[];
}

function configureSonarr(): void {
  getSettings().sonarr = [
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
      animeTags: [],
      is4k: false,
      enableSeasonFolders: true,
      tags: [],
      isDefault: true,
      syncEnabled: true,
      preventSearch: false,
      externalUrl: '',
    } as Partial<SonarrSettings>,
  ] as SonarrSettings[];
}

let validated: Express;
let unvalidated: Express;
const stubs = new MethodStubs();
let tmdbCalls: string[];
let arrCalls: string[];
let musicBrainzCalls: string[];

// The request routes and the user routes behind authentication, with the OpenAPI
// validator of server/index.ts in front of them or not: the validated app holds
// seerr-api.yml to take what the routes take, the other holds the routes' own
// answers.
function createApp(validate: boolean): Express {
  const api = Router();

  if (validate) {
    api.use(
      OpenApiValidator.middleware({
        apiSpec: API_SPEC_PATH,
        validateRequests: true,
        validateSecurity: false,
      })
    );
  }

  api.use((_req, res, next) => {
    const original = res.json;
    res.json = function json(body) {
      return original.call(this, JSON.parse(JSON.stringify(body)));
    };
    next();
  });
  api.use('/request', requestRoutes);
  api.use('/user', userRoutes);

  return createRoutesApp({ '/api/v1': authenticated(api) });
}

before(() => {
  validated = createApp(true);
  unvalidated = createApp(false);
});

setupTestDb();

interface Source {
  // Lidarr holds the artist, and the albums it lists for it
  held?: boolean;
  heldAlbums?: (string | LidarrAlbum)[] | Error;
  // the saved metadata profile as Lidarr answers it
  profile?: 'saved' | 'lacking' | Error;
  // the release groups MusicBrainz lists for the artist
  musicBrainz?: string[] | Error;
  // the lookup of an album or an artist fails
  lookupFails?: boolean;
}

// Lidarr's and MusicBrainz's answers for Radiohead and its albums, as the music
// metadata service reads them; an id of UNKNOWN_ID is not known to the source.
function source({
  held = false,
  heldAlbums = [],
  profile = 'saved',
  musicBrainz = [OK_COMPUTER, KID_A],
  lookupFails = false,
}: Source = {}) {
  const album = fixture<LidarrAlbum[]>('album-lookup-mbid')[0];
  const artist = fixture<LidarrArtist[]>('artist-lookup-mbid')[0];
  const proto = LidarrAPI.prototype;

  mock.method(proto, 'lookupAlbumByMbid', async (mbid: string) => {
    if (lookupFails) {
      throw new Error('Lidarr is down');
    }

    return mbid === UNKNOWN_ID
      ? null
      : ({ ...album, foreignAlbumId: mbid } as LidarrAlbum);
  });
  mock.method(proto, 'lookupArtistByMbid', async (mbid: string) => {
    if (lookupFails) {
      throw new Error('Lidarr is down');
    }

    return mbid === UNKNOWN_ID
      ? null
      : ({ ...artist, foreignArtistId: mbid } as LidarrArtist);
  });
  mock.method(proto, 'getArtists', async () =>
    held
      ? ([
          { id: 7, foreignArtistId: RADIOHEAD, artistName: 'Radiohead' },
        ] as LidarrArtist[])
      : []
  );
  mock.method(proto, 'getAlbums', async () => {
    if (heldAlbums instanceof Error) {
      throw heldAlbums;
    }

    return heldAlbums.map((entry) =>
      typeof entry === 'string' ? listedAlbum(entry) : entry
    );
  });
  mock.method(proto, 'getMetadataProfile', async (id: number) =>
    savedProfileAnswer(profile, id)
  );
  mock.method(proto, 'getTracks', async () => []);
  mock.method(getLidarrMetadata(), 'getArtist', async () => null);
  mock.method(getMusicBrainz(), 'getRelease', async () => ({
    id: 'release',
    title: 'OK Computer',
    media: [],
  }));
  mock.method(getMusicBrainz(), 'getArtistAlbums', async () => {
    musicBrainzCalls.push('getArtistAlbums');

    if (musicBrainz instanceof Error) {
      throw musicBrainz;
    }

    return musicBrainz.map((id) => ({
      id,
      title: `Album ${id}`,
      'primary-type': 'Album',
    }));
  });
  // an artist page's facts: MusicBrainz's record of the artist, not asked of
  // the network here (a failure leaves the facts out)
  mock.method(getMusicBrainz(), 'getArtist', async () => {
    throw new Error('Request failed with status code 404');
  });
  mock.method(proto, 'getTrackFiles', async () => []);
}

beforeEach(() => {
  tmdbCalls = [];
  arrCalls = [];
  musicBrainzCalls = [];

  const settings = getSettings();

  settings.lidarr = [{ ...lidarrServer }];
  settings.radarr = [];
  settings.sonarr = [];
  cacheManager.getCache('lidarr').flush();
  cacheManager.getCache('musicbrainz').flush();
  cacheManager.getCache('lidarrmetadata').flush();

  for (const method of ['getMovie', 'getTvShow']) {
    stubs.stub(TheMovieDb.prototype, method, async (...args: unknown[]) => {
      tmdbCalls.push(method);
      const id = Object.values(args[0] as Record<string, number>)[0];

      return method === 'getMovie'
        ? {
            id,
            genres: [],
            original_language: 'en',
            keywords: { keywords: [] },
            external_ids: {},
          }
        : {
            id,
            genres: [],
            original_language: 'en',
            keywords: { results: [] },
            external_ids: {},
          };
    });
  }

  for (const [name, prototype, methods] of [
    ['RadarrAPI', RadarrAPI.prototype, ['getTags', 'addMovie', 'getMovie']],
    ['SonarrAPI', SonarrAPI.prototype, ['getTags', 'addSeries', 'getSeries']],
  ] as const) {
    for (const method of methods) {
      stubs.stub(prototype, method, async () => {
        arrCalls.push(`${name}.${method}`);
        return [];
      });
    }
  }

  // the sending of an approved music request to Lidarr is T-158's and T-226's
  // (their own tests); a request made or approved here reaches no Lidarr, and
  // the send is stood in for by one that ended well, whose end puts the media
  // row to processing unless it is AVAILABLE or PARTIALLY_AVAILABLE, which the
  // send keeps (D-352)
  stubs.stub(
    MediaRequestSubscriber.prototype,
    'sendToLidarr',
    async (entity: MediaRequest, manager: EntityManager) => {
      if (
        entity.type === MediaType.MUSIC &&
        entity.status === MediaRequestStatus.APPROVED
      ) {
        await new MediaRequestSubscriber().updateParentStatus(manager, entity);
      }
    }
  );

  source();
});

afterEach(() => {
  stubs.restore();
  mock.restoreAll();
});

const PERMISSION_FOR: Record<string, number> = {
  none: Permission.NONE,
  request: Permission.REQUEST,
  requestMusic: Permission.REQUEST_MUSIC,
  requestMovie: Permission.REQUEST_MOVIE,
  autoApprove: Permission.REQUEST | Permission.AUTO_APPROVE,
  autoApproveMusic: Permission.REQUEST | Permission.AUTO_APPROVE_MUSIC,
  manageRequests: Permission.REQUEST | Permission.MANAGE_REQUESTS,
  manageRequestsOnly: Permission.MANAGE_REQUESTS,
  manageUsersOnly: Permission.MANAGE_USERS,
  manageBoth:
    Permission.REQUEST | Permission.MANAGE_USERS | Permission.MANAGE_REQUESTS,
  manageBothNoRequest: Permission.MANAGE_USERS | Permission.MANAGE_REQUESTS,
  admin: Permission.ADMIN,
};

let passwordHash: string | undefined;

// A user with the permissions given, who signs in as the seeded ones do
async function makeUser(name: string, permissions: number): Promise<User> {
  const repository = getRepository(User);

  if (!passwordHash) {
    passwordHash = (
      await repository
        .createQueryBuilder('user')
        .addSelect('user.password')
        .where('user.email = :email', { email: 'demo@seerr.dev' })
        .getOneOrFail()
    ).password;
  }

  return repository.save(
    new User({
      email: `${name}.u@seerr.dev`,
      username: name,
      plexId: 1,
      plexToken: '1234',
      plexUsername: name,
      userType: UserType.PLEX,
      password: passwordHash,
      avatar: 'https://example.invalid/avatar.png',
      permissions,
    })
  );
}

const callerOf = (user: User) => loginAs(validated, user.email);

let nextTmdbId = 1000;

interface Made {
  status: number;
  body: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function post(
  caller: User,
  body: Record<string, unknown>,
  app: Express = validated
): Promise<Made> {
  const agent = await loginAs(app, caller.email);
  const res = await agent.post('/api/v1/request').send(body);

  return { status: res.status, body: res.body };
}

const musicBody = (
  musicBrainzId = OK_COMPUTER,
  musicKind: MusicKind = MusicKind.ALBUM,
  extra: Record<string, unknown> = {}
) => ({ mediaType: 'music', musicBrainzId, musicKind, ...extra });

const movieBody = (extra: Record<string, unknown> = {}) => ({
  mediaType: 'movie',
  mediaId: nextTmdbId++,
  ...extra,
});

const tvBody = (extra: Record<string, unknown> = {}) => ({
  mediaType: 'tv',
  mediaId: nextTmdbId++,
  seasons: [1],
  ...extra,
});

// what a request answers of whom it was made for and by whom it was handled
const shape = (made: Made) => ({
  status: made.status,
  requestStatus: made.body.status,
  requestedBy: made.body.requestedBy?.id ?? null,
  modifiedBy: made.body.modifiedBy?.id ?? null,
});

// The same request made as a movie, a TV show and music by the same caller, for
// the same user where one is named
async function madeAlike(caller: User, userId?: number) {
  const extra = userId === undefined ? {} : { userId };

  return {
    movie: await post(caller, movieBody(extra)),
    tv: await post(caller, tvBody(extra)),
    music: await post(caller, musicBody(OK_COMPUTER, MusicKind.ALBUM, extra)),
  };
}

const counts = async () => ({
  media: await getRepository(Media).count({
    where: { mediaType: MediaType.MUSIC },
  }),
  requests: await getRepository(MediaRequest).count({
    where: { type: MediaType.MUSIC },
  }),
});

async function saveRow(
  mbid: string,
  kind: MusicKind,
  status = MediaStatus.UNKNOWN,
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

async function saveRequest(
  media: Media,
  status: MediaRequestStatus,
  by?: User
): Promise<MediaRequest> {
  const owner = by ?? (await getRepository(User).findOneByOrFail({ id: 1 }));

  return getRepository(MediaRequest).save(
    new MediaRequest({
      type: media.mediaType,
      media,
      requestedBy: owner,
      status,
      is4k: false,
    })
  );
}

describe('POST /request (music), what it takes', () => {
  it('makes an album request pending for a user who holds Request alone, with its media row', async () => {
    const user = await makeUser('requester', PERMISSION_FOR.request);

    const made = await post(user, musicBody());

    assert.strictEqual(made.status, 201);
    assert.strictEqual(made.body.status, MediaRequestStatus.PENDING);
    assert.strictEqual(made.body.type, MediaType.MUSIC);
    assert.strictEqual(made.body.requestedBy.id, user.id);
    assert.ok(!made.body.modifiedBy);
    assert.strictEqual(made.body.is4k, false);

    const request = await getRepository(MediaRequest).findOneOrFail({
      where: { id: made.body.id },
    });
    const media = request.media;

    assert.strictEqual(media.mediaType, MediaType.MUSIC);
    assert.strictEqual(media.musicBrainzId, OK_COMPUTER);
    assert.strictEqual(media.musicKind, MusicKind.ALBUM);
    assert.strictEqual(media.artistMusicBrainzId, RADIOHEAD);
    assert.strictEqual(media.status, MediaStatus.PENDING);
    assert.strictEqual(media.status4k, MediaStatus.UNKNOWN);
    assert.strictEqual(media.tmdbId, null);
    assert.strictEqual(media.tvdbId, null);
    assert.deepStrictEqual(request.seasons, []);
    assert.strictEqual(request.is4k, false);
    assert.strictEqual(request.modifiedBy ?? null, null);
  });

  it('makes an artist request, whose media row carries no artist id', async () => {
    const user = await makeUser('requester', PERMISSION_FOR.request);

    const made = await post(user, musicBody(RADIOHEAD, MusicKind.ARTIST));

    assert.strictEqual(made.status, 201);

    const media = (
      await getRepository(MediaRequest).findOneOrFail({
        where: { id: made.body.id },
      })
    ).media;

    assert.strictEqual(media.musicKind, MusicKind.ARTIST);
    assert.strictEqual(media.musicBrainzId, RADIOHEAD);
    assert.strictEqual(media.artistMusicBrainzId, null);
    assert.strictEqual(await getRepository(Media).count(), 1);
  });

  it('finds the media row of an item that has one instead of creating another', async () => {
    const row = await saveRow(
      OK_COMPUTER,
      MusicKind.ALBUM,
      MediaStatus.UNKNOWN,
      RADIOHEAD
    );
    const user = await makeUser('requester', PERMISSION_FOR.request);

    const made = await post(user, musicBody());

    assert.strictEqual(made.status, 201);
    assert.strictEqual(made.body.media.id, row.id);
    assert.strictEqual((await counts()).media, 1);
    assert.strictEqual(
      (await getRepository(Media).findOneByOrFail({ id: row.id })).status,
      MediaStatus.PENDING
    );
  });

  it('answers a mixed-case MusicBrainz id by its lower-case row', async () => {
    const user = await makeUser('requester', PERMISSION_FOR.request);

    const made = await post(
      user,
      musicBody(OK_COMPUTER.toUpperCase(), MusicKind.ALBUM),
      unvalidated
    );

    assert.strictEqual(made.status, 201);
    assert.strictEqual(made.body.media.musicBrainzId, OK_COMPUTER);
  });

  for (const [name, permissions] of [
    ['Request Music alone', PERMISSION_FOR.requestMusic],
    ['Request', PERMISSION_FOR.request],
    ['Admin', PERMISSION_FOR.admin],
  ] as const) {
    it(`takes a music request from a user with ${name}`, async () => {
      const user = await makeUser('requester', permissions);

      assert.strictEqual((await post(user, musicBody())).status, 201);
    });
  }

  it('makes a request approved, modifiedBy the caller, for a user with Auto-Approve, Auto-Approve Music, Manage Requests or Admin, each beside a movie and a TV request', async () => {
    for (const key of [
      'autoApprove',
      'autoApproveMusic',
      'manageRequests',
      'admin',
    ]) {
      const user = await makeUser(key, PERMISSION_FOR[key]);
      const { movie, tv, music } = await madeAlike(user);

      assert.strictEqual(music.status, 201, key);
      assert.strictEqual(music.body.status, MediaRequestStatus.APPROVED, key);
      assert.strictEqual(music.body.modifiedBy.id, user.id, key);
      assert.strictEqual(music.body.requestedBy.id, user.id, key);

      // a movie and a TV request are answered as they were: approved by the
      // permissions that approve them
      if (key !== 'autoApproveMusic') {
        assert.deepStrictEqual(shape(music), shape(movie), key);
        assert.deepStrictEqual(shape(music), shape(tv), key);
      } else {
        assert.strictEqual(movie.body.status, MediaRequestStatus.PENDING);
        assert.strictEqual(tv.body.status, MediaRequestStatus.PENDING);
      }

      // the next item of the next user: no duplicate of the same album
      await getRepository(MediaRequest).delete({ type: MediaType.MUSIC });
    }
  });

  it('makes a request pending for a user with Request and none of Auto-Approve, Auto-Approve Music or Manage Requests, as a movie and a TV request are', async () => {
    const user = await makeUser('requester', PERMISSION_FOR.request);
    const { movie, tv, music } = await madeAlike(user);

    assert.strictEqual(music.body.status, MediaRequestStatus.PENDING);
    assert.ok(!music.body.modifiedBy);
    assert.deepStrictEqual(shape(music), shape(movie));
    assert.deepStrictEqual(shape(music), shape(tv));
  });

  it('refuses 403 and creates nothing for a user who may not request music, as a movie is refused', async () => {
    for (const key of [
      'none',
      'requestMovie',
      'manageRequestsOnly',
      'manageUsersOnly',
    ]) {
      const user = await makeUser(key, PERMISSION_FOR[key]);
      const music = await post(user, musicBody());

      assert.strictEqual(music.status, 403, key);
      assert.deepStrictEqual(await counts(), { media: 0, requests: 0 }, key);

      // the same user's movie request, where it is refused, is refused alike
      if (key === 'none' || key === 'manageRequestsOnly') {
        assert.strictEqual((await post(user, movieBody())).status, 403, key);
      }
    }
  });
});

describe('POST /request (music), whom it is read on (the userId path)', () => {
  it('has an admin caller make a request for a user who holds Request alone approved, requestedBy that user, modifiedBy the caller, as for a movie', async () => {
    const admin = await makeUser('admin', PERMISSION_FOR.admin);
    const target = await makeUser('target', PERMISSION_FOR.request);
    const { movie, tv, music } = await madeAlike(admin, target.id);

    assert.strictEqual(music.status, 201);
    assert.strictEqual(music.body.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(music.body.requestedBy.id, target.id);
    assert.strictEqual(music.body.modifiedBy.id, admin.id);
    assert.deepStrictEqual(shape(music), shape(movie));
    assert.deepStrictEqual(shape(music), shape(tv));
  });

  it('has a Manage Requests caller (who may name another user) make a request for a user who holds Request alone approved, modifiedBy the caller, as for a movie', async () => {
    const caller = await makeUser('manager', PERMISSION_FOR.manageBoth);
    const target = await makeUser('target', PERMISSION_FOR.request);
    const { movie, tv, music } = await madeAlike(caller, target.id);

    assert.strictEqual(music.status, 201);
    assert.strictEqual(music.body.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(music.body.requestedBy.id, target.id);
    assert.strictEqual(music.body.modifiedBy.id, caller.id);
    assert.deepStrictEqual(shape(music), shape(movie));
    assert.deepStrictEqual(shape(music), shape(tv));
  });

  it('reads the request permission on the requester, not on the caller', async () => {
    // the caller names another user but may not request music itself
    const caller = await makeUser(
      'manager',
      PERMISSION_FOR.manageBothNoRequest
    );
    const target = await makeUser('target', PERMISSION_FOR.request);
    const { movie, music } = await madeAlike(caller, target.id);

    assert.strictEqual(music.status, 201);
    assert.strictEqual(music.body.requestedBy.id, target.id);
    assert.strictEqual(music.body.modifiedBy.id, caller.id);
    assert.deepStrictEqual(shape(music), shape(movie));
  });

  it('refuses 403, creating nothing, a request for a user who holds none of Admin, Request or Request Music, whoever the caller is, as for a movie', async () => {
    const admin = await makeUser('admin', PERMISSION_FOR.admin);
    const manager = await makeUser('manager', PERMISSION_FOR.manageBoth);

    for (const target of [
      await makeUser('nobody', PERMISSION_FOR.none),
      await makeUser('moviesonly', PERMISSION_FOR.requestMovie),
      await makeUser('managesonly', PERMISSION_FOR.manageRequestsOnly),
    ]) {
      for (const caller of [admin, manager]) {
        const { movie, music } = await madeAlike(caller, target.id);

        if (target.permissions === PERMISSION_FOR.requestMovie) {
          // a movie request is made for a user who may request movies; music is not
          assert.strictEqual(movie.status, 201);
        } else {
          assert.strictEqual(movie.status, 403);
        }

        assert.strictEqual(music.status, 403);
        assert.deepStrictEqual(await counts(), { media: 0, requests: 0 });
      }
    }
  });

  it('makes a request for a user who holds Request Music alone, where a movie request for it is refused', async () => {
    const admin = await makeUser('admin', PERMISSION_FOR.admin);
    const target = await makeUser('target', PERMISSION_FOR.requestMusic);
    const { movie, music } = await madeAlike(admin, target.id);

    assert.strictEqual(movie.status, 403);
    assert.strictEqual(music.status, 201);
    assert.strictEqual(music.body.requestedBy.id, target.id);
    assert.strictEqual(music.body.modifiedBy.id, admin.id);
  });

  it('reads the auto-approval on the caller: a caller who may name another user always approves, whatever the user holds', async () => {
    const admin = await makeUser('admin', PERMISSION_FOR.admin);
    const target = await makeUser('target', PERMISSION_FOR.autoApprove);
    const { movie, music } = await madeAlike(admin, target.id);

    assert.strictEqual(music.body.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(music.body.modifiedBy.id, admin.id);
    assert.deepStrictEqual(shape(music), shape(movie));
  });

  it('refuses a caller who may not name another user, as for a movie: Manage Users alone, or Manage Requests alone, for a user who holds Auto-Approve', async () => {
    const target = await makeUser('target', PERMISSION_FOR.autoApprove);

    for (const key of [
      'manageUsersOnly',
      'manageRequestsOnly',
      'request',
      'autoApprove',
    ]) {
      const caller = await makeUser(key, PERMISSION_FOR[key]);
      const { movie, tv, music } = await madeAlike(caller, target.id);

      assert.strictEqual(movie.status, 403, key);
      assert.strictEqual(tv.status, 403, key);
      assert.strictEqual(music.status, 403, key);
      assert.deepStrictEqual(await counts(), { media: 0, requests: 0 }, key);
    }
  });

  it('answers a userId of nobody as a movie request does', async () => {
    const admin = await makeUser('admin', PERMISSION_FOR.admin);
    const movie = await post(admin, movieBody({ userId: 999999 }));
    const music = await post(
      admin,
      musicBody(OK_COMPUTER, MusicKind.ALBUM, { userId: 999999 })
    );

    assert.strictEqual(music.status, movie.status);
    assert.deepStrictEqual(await counts(), { media: 0, requests: 0 });
  });
});

describe('POST /request (music), what it refuses', () => {
  const malformed: [string, Record<string, unknown>][] = [
    ['no musicBrainzId', { mediaType: 'music', musicKind: 'album' }],
    [
      'a musicBrainzId that is no MusicBrainz id',
      { mediaType: 'music', musicBrainzId: 'radiohead', musicKind: 'album' },
    ],
    ['no musicKind', { mediaType: 'music', musicBrainzId: OK_COMPUTER }],
    [
      'a musicKind that is not album or artist',
      { mediaType: 'music', musicBrainzId: OK_COMPUTER, musicKind: 'track' },
    ],
    ['a mediaId', musicBody(OK_COMPUTER, MusicKind.ALBUM, { mediaId: 1 })],
    ['a tvdbId', musicBody(OK_COMPUTER, MusicKind.ALBUM, { tvdbId: 1 })],
    ['seasons', musicBody(OK_COMPUTER, MusicKind.ALBUM, { seasons: [1] })],
    [
      'seasons all',
      musicBody(OK_COMPUTER, MusicKind.ALBUM, { seasons: 'all' }),
    ],
    ['is4k true', musicBody(OK_COMPUTER, MusicKind.ALBUM, { is4k: true })],
    ['a serverId', musicBody(OK_COMPUTER, MusicKind.ALBUM, { serverId: 1 })],
    ['a profileId', musicBody(OK_COMPUTER, MusicKind.ALBUM, { profileId: 1 })],
    [
      'a rootFolder',
      musicBody(OK_COMPUTER, MusicKind.ALBUM, { rootFolder: '/music' }),
    ],
    [
      'a languageProfileId',
      musicBody(OK_COMPUTER, MusicKind.ALBUM, { languageProfileId: 1 }),
    ],
    ['tags', musicBody(OK_COMPUTER, MusicKind.ALBUM, { tags: [1] })],
    [
      'ignoreQuota true',
      musicBody(OK_COMPUTER, MusicKind.ALBUM, { ignoreQuota: true }),
    ],
  ];

  for (const [name, body] of malformed) {
    it(`answers 400 and creates nothing for ${name}`, async () => {
      const admin = await makeUser('admin', PERMISSION_FOR.admin);

      for (const app of [unvalidated, validated]) {
        const made = await post(admin, body, app);

        assert.strictEqual(made.status, 400, name);
        assert.deepStrictEqual(await counts(), { media: 0, requests: 0 });
      }
    });
  }

  it('takes is4k false and ignoreQuota false, and null for userId', async () => {
    const admin = await makeUser('admin', PERMISSION_FOR.admin);
    const made = await post(
      admin,
      musicBody(OK_COMPUTER, MusicKind.ALBUM, {
        is4k: false,
        ignoreQuota: false,
        userId: null,
      })
    );

    assert.strictEqual(made.status, 201);
    assert.strictEqual(made.body.requestedBy.id, admin.id);
  });

  it('answers 404 for an album and an artist the source does not know, and creates nothing', async () => {
    const admin = await makeUser('admin', PERMISSION_FOR.admin);

    for (const kind of [MusicKind.ALBUM, MusicKind.ARTIST]) {
      const made = await post(admin, musicBody(UNKNOWN_ID, kind));

      assert.strictEqual(made.status, 404, kind);
      assert.deepStrictEqual(await counts(), { media: 0, requests: 0 });
    }
  });

  it('answers 404 where there is no default Lidarr server', async () => {
    const admin = await makeUser('admin', PERMISSION_FOR.admin);

    getSettings().lidarr = [{ ...lidarrServer, isDefault: false }];

    for (const kind of [MusicKind.ALBUM, MusicKind.ARTIST]) {
      const made = await post(
        admin,
        musicBody(kind === MusicKind.ALBUM ? OK_COMPUTER : RADIOHEAD, kind)
      );

      assert.strictEqual(made.status, 404, kind);
      assert.match(made.body.message, /Lidarr/);
    }

    getSettings().lidarr = [];

    assert.strictEqual((await post(admin, musicBody())).status, 404);
    assert.deepStrictEqual(await counts(), { media: 0, requests: 0 });
  });

  it('answers 403 before 404: a user who may not request music is refused whatever the item', async () => {
    const user = await makeUser('nobody', PERMISSION_FOR.none);

    assert.strictEqual((await post(user, musicBody(UNKNOWN_ID))).status, 403);
  });

  it('answers 500 with a message where the source fails, and creates nothing', async () => {
    mock.restoreAll();
    source({ lookupFails: true });
    const admin = await makeUser('admin', PERMISSION_FOR.admin);

    for (const kind of [MusicKind.ALBUM, MusicKind.ARTIST]) {
      const made = await post(
        admin,
        musicBody(kind === MusicKind.ALBUM ? OK_COMPUTER : RADIOHEAD, kind)
      );

      assert.strictEqual(made.status, 500, kind);
      assert.ok(made.body.message, kind);
      assert.deepStrictEqual(await counts(), { media: 0, requests: 0 });
    }
  });

  describe('as a duplicate, 409', () => {
    const DUPLICATE = 'Request for this media already exists.';

    for (const status of [
      MediaRequestStatus.PENDING,
      MediaRequestStatus.APPROVED,
      MediaRequestStatus.FAILED,
    ]) {
      it(`refuses an album that its own request covers while it is ${MediaRequestStatus[status]}`, async () => {
        const admin = await makeUser('admin', PERMISSION_FOR.admin);

        await saveRequest(
          await saveRow(
            OK_COMPUTER,
            MusicKind.ALBUM,
            MediaStatus.PENDING,
            RADIOHEAD
          ),
          status
        );

        const made = await post(admin, musicBody());

        assert.strictEqual(made.status, 409);
        assert.strictEqual(made.body.message, DUPLICATE);
        assert.strictEqual((await counts()).requests, 1);
      });

      it(`refuses an artist whose whole-artist request stands, ${MediaRequestStatus[status]}`, async () => {
        const admin = await makeUser('admin', PERMISSION_FOR.admin);

        await saveRequest(await saveRow(RADIOHEAD, MusicKind.ARTIST), status);

        const made = await post(admin, musicBody(RADIOHEAD, MusicKind.ARTIST));

        assert.strictEqual(made.status, 409);
        assert.strictEqual(made.body.message, DUPLICATE);
        assert.strictEqual((await counts()).requests, 1);
      });

      it(`refuses an album its artist's whole-artist request covers while it is ${MediaRequestStatus[status]}, only where the album is one of the artist's albums`, async () => {
        const admin = await makeUser('admin', PERMISSION_FOR.admin);

        await saveRequest(await saveRow(RADIOHEAD, MusicKind.ARTIST), status);

        assert.strictEqual(
          (await post(admin, musicBody(OK_COMPUTER))).status,
          409
        );
        // an album the artist's albums do not list is not covered by it
        assert.strictEqual(
          (await post(admin, musicBody(AMNESIAC))).status,
          201
        );
      });
    }

    for (const status of [
      MediaRequestStatus.DECLINED,
      MediaRequestStatus.COMPLETED,
    ]) {
      it(`covers nothing by a ${MediaRequestStatus[status]} request`, async () => {
        const admin = await makeUser('admin', PERMISSION_FOR.admin);

        await saveRequest(
          await saveRow(
            OK_COMPUTER,
            MusicKind.ALBUM,
            MediaStatus.UNKNOWN,
            RADIOHEAD
          ),
          status
        );
        await saveRequest(await saveRow(RADIOHEAD, MusicKind.ARTIST), status);

        assert.strictEqual((await post(admin, musicBody())).status, 201);
        assert.strictEqual(
          (await post(admin, musicBody(RADIOHEAD, MusicKind.ARTIST))).status,
          201
        );
      });
    }

    it('refuses an available album and an available artist, with no request standing', async () => {
      const admin = await makeUser('admin', PERMISSION_FOR.admin);

      await saveRow(
        OK_COMPUTER,
        MusicKind.ALBUM,
        MediaStatus.AVAILABLE,
        RADIOHEAD
      );
      await saveRow(RADIOHEAD, MusicKind.ARTIST, MediaStatus.AVAILABLE);

      assert.strictEqual((await post(admin, musicBody())).status, 409);
      assert.strictEqual(
        (await post(admin, musicBody(RADIOHEAD, MusicKind.ARTIST))).status,
        409
      );
      assert.strictEqual((await counts()).requests, 0);
    });

    it('takes a partially available artist, and a whole-artist request whatever album requests of the artist stand', async () => {
      const admin = await makeUser('admin', PERMISSION_FOR.admin);

      await saveRow(
        RADIOHEAD,
        MusicKind.ARTIST,
        MediaStatus.PARTIALLY_AVAILABLE
      );
      await saveRequest(
        await saveRow(
          OK_COMPUTER,
          MusicKind.ALBUM,
          MediaStatus.PENDING,
          RADIOHEAD
        ),
        MediaRequestStatus.PENDING
      );

      const made = await post(admin, musicBody(RADIOHEAD, MusicKind.ARTIST));

      assert.strictEqual(made.status, 201);
      // the route finds the row and writes no status on it (D-352)
      assert.strictEqual(
        (
          await getRepository(Media).findOneByOrFail({
            musicBrainzId: RADIOHEAD,
            musicKind: MusicKind.ARTIST,
          })
        ).status,
        MediaStatus.PARTIALLY_AVAILABLE
      );
    });

    it('does not let an album request cover its artist, nor an artist request an album outside its albums', async () => {
      const admin = await makeUser('admin', PERMISSION_FOR.admin);

      await saveRequest(
        await saveRow(
          OK_COMPUTER,
          MusicKind.ALBUM,
          MediaStatus.PENDING,
          RADIOHEAD
        ),
        MediaRequestStatus.PENDING
      );

      assert.strictEqual(
        (await post(admin, musicBody(RADIOHEAD, MusicKind.ARTIST))).status,
        201
      );
    });

    it('answers 500, creating nothing, where an album is covered only if its artist’s albums, which cannot be read, say so', async () => {
      mock.restoreAll();
      source({ musicBrainz: new Error('MusicBrainz is down') });
      const admin = await makeUser('admin', PERMISSION_FOR.admin);

      await saveRequest(
        await saveRow(RADIOHEAD, MusicKind.ARTIST),
        MediaRequestStatus.APPROVED
      );
      const before = await counts();

      const made = await post(admin, musicBody());

      assert.strictEqual(made.status, 500);
      assert.ok(made.body.message);
      assert.deepStrictEqual(await counts(), before);
    });

    it('asks no metadata of an album whose artist has no standing request, so a source that fails does not fail it', async () => {
      mock.restoreAll();
      source({ musicBrainz: new Error('MusicBrainz is down') });
      musicBrainzCalls = [];
      const admin = await makeUser('admin', PERMISSION_FOR.admin);

      const made = await post(admin, musicBody(AMNESIAC));

      assert.strictEqual(made.status, 201);
      // reading the artist's albums for the request is the album lookup's own
      // business, never the covering's
      assert.deepStrictEqual(musicBrainzCalls, []);
    });
  });
});

describe('POST /request (music), the schema of seerr-api.yml', () => {
  it('takes a music body and a movie and TV body, and describes the music fields', async () => {
    const admin = await makeUser('admin', PERMISSION_FOR.admin);

    assert.strictEqual((await post(admin, musicBody())).status, 201);
    assert.strictEqual((await post(admin, movieBody())).status, 201);
    assert.strictEqual((await post(admin, tvBody())).status, 201);
  });

  it('answers a movie body without a mediaId as the validator did before: 400 naming mediaId', async () => {
    const admin = await makeUser('admin', PERMISSION_FOR.admin);
    const agent = await callerOf(admin);

    for (const mediaType of ['movie', 'tv']) {
      const res = await agent.post('/api/v1/request').send({ mediaType });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(
        res.body.message,
        "request/body must have required property 'mediaId'"
      );
    }

    const none = await agent.post('/api/v1/request').send({});

    assert.strictEqual(none.status, 400);
    assert.strictEqual(
      none.body.message,
      "request/body must have required property 'mediaType'"
    );

    // the route itself, without the validator, gives the same wording
    const bare = await (await loginAs(unvalidated, admin.email))
      .post('/api/v1/request')
      .send({ mediaType: 'movie' });

    assert.strictEqual(bare.status, 400);
    assert.strictEqual(
      bare.body.message,
      "request/body must have required property 'mediaId'"
    );
  });

  it('refuses a mediaType the enum does not hold', async () => {
    const admin = await makeUser('admin', PERMISSION_FOR.admin);
    const res = await (await callerOf(admin))
      .post('/api/v1/request')
      .send({ mediaType: 'book', mediaId: 1 });

    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /movie, tv, music/);
  });
});

describe('POST /request (music), what it skips', () => {
  it('counts against no quota, and is refused by none, while a movie request is', async () => {
    const user = await makeUser('limited', PERMISSION_FOR.request);

    user.movieQuotaLimit = 1;
    user.movieQuotaDays = 7;
    user.tvQuotaLimit = 1;
    user.tvQuotaDays = 7;
    await getRepository(User).save(user);

    assert.strictEqual((await post(user, movieBody())).status, 201);
    assert.strictEqual((await post(user, movieBody())).status, 403);
    assert.strictEqual((await post(user, tvBody())).status, 201);
    assert.strictEqual((await post(user, tvBody())).status, 403);

    // music goes on past a quota that is used up, and uses none of it
    assert.strictEqual((await post(user, musicBody(OK_COMPUTER))).status, 201);
    assert.strictEqual((await post(user, musicBody(KID_A))).status, 201);
    assert.strictEqual(
      (await post(user, musicBody(RADIOHEAD, MusicKind.ARTIST))).status,
      201
    );

    const quota = await (
      await getRepository(User).findOneByOrFail({ id: user.id })
    ).getQuota();

    assert.strictEqual(quota.movie.used, 1);
    assert.strictEqual(quota.tv.used, 1);
  });

  it('uses none of a quota that a music request alone would leave', async () => {
    const user = await makeUser('limited', PERMISSION_FOR.request);

    user.movieQuotaLimit = 5;
    user.movieQuotaDays = 7;
    user.tvQuotaLimit = 5;
    user.tvQuotaDays = 7;
    await getRepository(User).save(user);

    await post(user, musicBody(OK_COMPUTER));
    await post(user, musicBody(RADIOHEAD, MusicKind.ARTIST));

    const quota = await (
      await getRepository(User).findOneByOrFail({ id: user.id })
    ).getQuota();

    assert.strictEqual(quota.movie.used, 0);
    assert.strictEqual(quota.tv.used, 0);
  });

  it('applies no override rule, while a movie request has its rule applied', async () => {
    configureRadarr();
    const user = await makeUser('ruled', PERMISSION_FOR.request);

    await getRepository(OverrideRule).save(
      new OverrideRule({
        radarrServiceId: 0,
        sonarrServiceId: 0,
        users: String(user.id),
        rootFolder: '/overridden',
        profileId: 9,
      })
    );

    const movie = await post(user, movieBody());
    const music = await post(user, musicBody());

    assert.strictEqual(movie.body.rootFolder, '/overridden');
    assert.strictEqual(music.status, 201);
    assert.ok(!music.body.rootFolder);
    assert.ok(!music.body.profileId);
    assert.deepStrictEqual(
      arrCalls.filter((c) => !c.startsWith('Radarr')),
      []
    );
  });

  it('sends no notification of any kind, pending or auto-approved, where a movie request sends them', async () => {
    const sendNotification = mock.method(
      MediaRequest,
      'sendNotification',
      async () => undefined
    );
    const sendToAgents = mock.method(
      notificationManager,
      'sendNotification',
      () => undefined
    );
    const pending = await makeUser('pending', PERMISSION_FOR.request);
    const approved = await makeUser('approved', PERMISSION_FOR.admin);

    await post(pending, musicBody(OK_COMPUTER));
    await post(approved, musicBody(KID_A));
    await post(approved, musicBody(RADIOHEAD, MusicKind.ARTIST));
    // let the hooks that run after the save finish
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.strictEqual(sendNotification.mock.callCount(), 0);
    assert.strictEqual(sendToAgents.mock.callCount(), 0);

    // approving, declining and retrying send none either
    const request = await getRepository(MediaRequest).findOneByOrFail({
      media: { musicBrainzId: OK_COMPUTER },
    });
    const adminAgent = await callerOf(approved);

    assert.strictEqual(
      (await adminAgent.post(`/api/v1/request/${request.id}/approve`)).status,
      200
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(sendNotification.mock.callCount(), 0);

    // where a movie request, beside them, does send them
    await post(pending, movieBody());
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(sendNotification.mock.callCount() > 0);
  });

  it('reads nothing of seasons or 4K, and asks neither TMDB, Radarr nor Sonarr, in any act on a music request', async () => {
    configureRadarr();
    configureSonarr();

    const errors = mock.method(logger, 'error', () => undefined);
    const admin = await makeUser('admin', PERMISSION_FOR.admin);
    const target = await makeUser('target', PERMISSION_FOR.request);
    const agent = await callerOf(admin);

    const auto = await post(admin, musicBody(OK_COMPUTER));
    const pending = await post(
      admin,
      musicBody(KID_A, MusicKind.ALBUM, { userId: target.id })
    );

    assert.strictEqual(auto.body.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(pending.body.status, MediaRequestStatus.APPROVED);

    const failed = await saveRequest(
      await saveRow(AMNESIAC, MusicKind.ALBUM, MediaStatus.UNKNOWN, RADIOHEAD),
      MediaRequestStatus.FAILED
    );
    const waiting = await saveRequest(
      await saveRow(RADIOHEAD, MusicKind.ARTIST),
      MediaRequestStatus.PENDING
    );

    assert.strictEqual(
      (await agent.post(`/api/v1/request/${failed.id}/retry`)).status,
      200
    );
    assert.strictEqual(
      (await agent.post(`/api/v1/request/${waiting.id}/decline`)).status,
      200
    );
    assert.strictEqual(
      (await agent.delete(`/api/v1/request/${auto.body.id}`)).status,
      204
    );
    assert.strictEqual(
      (await agent.get('/api/v1/request?mediaType=music')).status,
      200
    );
    assert.strictEqual((await agent.get('/api/v1/request')).status, 200);
    assert.strictEqual((await agent.get('/api/v1/request/count')).status, 200);
    assert.strictEqual(
      (await agent.get(`/api/v1/request/${pending.body.id}`)).status,
      200
    );
    assert.strictEqual(
      (await agent.get(`/api/v1/user/${target.id}/requests`)).status,
      200
    );

    assert.deepStrictEqual(tmdbCalls, []);
    assert.deepStrictEqual(arrCalls, []);
    assert.strictEqual(errors.mock.callCount(), 0);
  });
});

describe('the routes on a music request, beside a movie one', () => {
  async function pendingPair(mbid = OK_COMPUTER, name = 'owner') {
    const owner = await makeUser(name, PERMISSION_FOR.request);
    const movie = await post(owner, movieBody());
    const music = await post(owner, musicBody(mbid));

    return { owner, movie: movie.body.id, music: music.body.id };
  }

  it('approves and declines it as a movie request, recording the acting user', async () => {
    const mbids = { approve: OK_COMPUTER, decline: KID_A };

    for (const action of ['approve', 'decline'] as const) {
      const { movie, music } = await pendingPair(mbids[action], action);
      const admin = await callerOf(
        await makeUser(`admin${action}`, PERMISSION_FOR.admin)
      );
      const moved = await admin.post(`/api/v1/request/${movie}/${action}`);
      const res = await admin.post(`/api/v1/request/${music}/${action}`);

      assert.strictEqual(res.status, 200, action);
      assert.strictEqual(res.body.status, moved.body.status, action);
      assert.ok(res.body.modifiedBy.id);
      assert.strictEqual(res.body.modifiedBy.id, moved.body.modifiedBy.id);

      // only a pending request is acted on
      assert.strictEqual(
        (await admin.post(`/api/v1/request/${music}/${action}`)).status,
        409
      );
    }
  });

  it('refuses a user who does not manage requests the approval of one, as for a movie', async () => {
    const { owner, movie, music } = await pendingPair();
    const agent = await callerOf(owner);

    assert.strictEqual(
      (await agent.post(`/api/v1/request/${movie}/approve`)).status,
      403
    );
    assert.strictEqual(
      (await agent.post(`/api/v1/request/${music}/approve`)).status,
      403
    );
  });

  it('marks the media row processing once approved and leaves it unknown again once deleted, failing nothing', async () => {
    const errors = mock.method(logger, 'error', () => undefined);
    const { music } = await pendingPair();
    const admin = await callerOf(await makeUser('admin', PERMISSION_FOR.admin));

    await admin.post(`/api/v1/request/${music}/approve`);

    const request = await getRepository(MediaRequest).findOneByOrFail({
      id: music,
    });

    assert.strictEqual(request.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(request.media.status, MediaStatus.PROCESSING);

    assert.strictEqual(
      (await admin.delete(`/api/v1/request/${music}`)).status,
      204
    );
    assert.strictEqual(
      (await getRepository(Media).findOneByOrFail({ id: request.media.id }))
        .status,
      MediaStatus.UNKNOWN
    );
    assert.strictEqual(errors.mock.callCount(), 0);
  });

  it('leaves a partially available artist row as it is through its whole-artist request made, approved, failed and retried (D-352)', async () => {
    const owner = await makeUser('owner', PERMISSION_FOR.request);
    const admin = await callerOf(await makeUser('admin', PERMISSION_FOR.admin));
    const row = await saveRow(
      RADIOHEAD,
      MusicKind.ARTIST,
      MediaStatus.PARTIALLY_AVAILABLE
    );
    const status = async () =>
      (await getRepository(Media).findOneByOrFail({ id: row.id })).status;

    const made = await post(owner, musicBody(RADIOHEAD, MusicKind.ARTIST));

    assert.strictEqual(made.status, 201);
    assert.strictEqual(made.body.status, MediaRequestStatus.PENDING);
    assert.strictEqual(await status(), MediaStatus.PARTIALLY_AVAILABLE);

    await admin.post(`/api/v1/request/${made.body.id}/approve`);
    assert.strictEqual(await status(), MediaStatus.PARTIALLY_AVAILABLE);

    await getRepository(MediaRequest).update(made.body.id, {
      status: MediaRequestStatus.FAILED,
    });
    assert.strictEqual(
      (await admin.post(`/api/v1/request/${made.body.id}/retry`)).status,
      200
    );
    assert.strictEqual(await status(), MediaStatus.PARTIALLY_AVAILABLE);
  });

  it('retries a failed one as a failed movie request is retried, and refuses to retry one that has not failed', async () => {
    const admin = await callerOf(await makeUser('admin', PERMISSION_FOR.admin));
    const failed = await saveRequest(
      await saveRow(
        OK_COMPUTER,
        MusicKind.ALBUM,
        MediaStatus.UNKNOWN,
        RADIOHEAD
      ),
      MediaRequestStatus.FAILED
    );
    const pending = await saveRequest(
      await saveRow(KID_A, MusicKind.ALBUM, MediaStatus.UNKNOWN, RADIOHEAD),
      MediaRequestStatus.PENDING
    );

    const res = await admin.post(`/api/v1/request/${failed.id}/retry`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, MediaRequestStatus.APPROVED);
    assert.ok(res.body.modifiedBy.id);
    assert.strictEqual(
      (await admin.post(`/api/v1/request/${pending.id}/retry`)).status,
      409
    );
  });

  it('lets the requester cancel its own pending one and a manager delete any, as for a movie; nobody else', async () => {
    const { owner, movie, music } = await pendingPair();
    const other = await callerOf(
      await makeUser('other', PERMISSION_FOR.request)
    );
    const manager = await callerOf(
      await makeUser('manager', PERMISSION_FOR.manageRequests)
    );
    const requester = await callerOf(owner);

    assert.strictEqual(
      (await other.delete(`/api/v1/request/${movie}`)).status,
      401
    );
    assert.strictEqual(
      (await other.delete(`/api/v1/request/${music}`)).status,
      401
    );

    assert.strictEqual(
      (await requester.delete(`/api/v1/request/${movie}`)).status,
      204
    );
    assert.strictEqual(
      (await requester.delete(`/api/v1/request/${music}`)).status,
      204
    );

    // once approved the requester no longer may; a manager may
    const again = await post(owner, musicBody(KID_A));
    await manager.post(`/api/v1/request/${again.body.id}/approve`);

    assert.strictEqual(
      (await requester.delete(`/api/v1/request/${again.body.id}`)).status,
      401
    );
    assert.strictEqual(
      (await manager.delete(`/api/v1/request/${again.body.id}`)).status,
      204
    );
    assert.strictEqual((await counts()).requests, 0);
  });

  it('lets a request that was cancelled, declined or deleted be requested again', async () => {
    const owner = await makeUser('owner', PERMISSION_FOR.request);
    const agent = await callerOf(owner);
    const admin = await callerOf(await makeUser('admin', PERMISSION_FOR.admin));

    const first = await post(owner, musicBody());

    assert.strictEqual((await post(owner, musicBody())).status, 409);
    await agent.delete(`/api/v1/request/${first.body.id}`);

    const second = await post(owner, musicBody());

    assert.strictEqual(second.status, 201);
    await admin.post(`/api/v1/request/${second.body.id}/decline`);

    assert.strictEqual((await post(owner, musicBody())).status, 201);
  });
});

describe('PUT /request/:id on a music request, beside a movie one', () => {
  async function pendingPair(permissions = PERMISSION_FOR.request) {
    const owner = await makeUser('owner', permissions);
    const movie = await post(owner, movieBody());
    const music = await post(owner, musicBody());

    return { owner, movie: movie.body.id, music: music.body.id };
  }

  const unchanged = async (id: number, owner: User) => {
    const request = await getRepository(MediaRequest).findOneByOrFail({ id });

    assert.strictEqual(request.requestedBy.id, owner.id);
    assert.strictEqual(request.serverId, null);
    assert.strictEqual(request.profileId, null);
    assert.strictEqual(request.rootFolder, null);
    assert.strictEqual(request.languageProfileId, null);
    assert.strictEqual(request.tags, null);
    assert.strictEqual(request.is4k, false);
    assert.strictEqual(request.seasons.length, 0);
  };

  it('changes the requester, as a movie request’s is changed, by a user who manages users and requests', async () => {
    const { movie, music } = await pendingPair();
    const target = await makeUser('target', PERMISSION_FOR.request);
    const manager = await callerOf(
      await makeUser('manager', PERMISSION_FOR.manageBoth)
    );

    const moved = await manager
      .put(`/api/v1/request/${movie}`)
      .send({ mediaType: 'movie', userId: target.id });
    const res = await manager
      .put(`/api/v1/request/${music}`)
      .send({ mediaType: 'music', userId: target.id });

    assert.strictEqual(moved.status, 200);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.requestedBy.id, target.id);
    assert.strictEqual(
      (await getRepository(MediaRequest).findOneByOrFail({ id: music }))
        .requestedBy.id,
      target.id
    );
    assert.strictEqual(
      (await getRepository(MediaRequest).findOneByOrFail({ id: music })).status,
      MediaRequestStatus.PENDING
    );
  });

  it('changes the requester for an admin, and answers 200 with no change of requester too', async () => {
    const { owner, music } = await pendingPair();
    const target = await makeUser('target', PERMISSION_FOR.request);
    const admin = await callerOf(await makeUser('admin', PERMISSION_FOR.admin));

    assert.strictEqual(
      (await admin.put(`/api/v1/request/${music}`).send({ mediaType: 'music' }))
        .status,
      200
    );
    await unchanged(music, owner);

    const res = await admin
      .put(`/api/v1/request/${music}`)
      .send({ mediaType: 'music', userId: target.id });

    assert.strictEqual(res.body.requestedBy.id, target.id);
  });

  it('refuses 403 a caller who manages requests but not users the change of requester, as for a movie, and changes nothing', async () => {
    const { owner, movie, music } = await pendingPair();
    const target = await makeUser('target', PERMISSION_FOR.request);
    const caller = await callerOf(
      await makeUser('manager', PERMISSION_FOR.manageRequests)
    );

    const moved = await caller
      .put(`/api/v1/request/${movie}`)
      .send({ mediaType: 'movie', userId: target.id });
    const res = await caller
      .put(`/api/v1/request/${music}`)
      .send({ mediaType: 'music', userId: target.id });

    assert.strictEqual(moved.status, 403);
    assert.strictEqual(res.status, 403);
    await unchanged(music, owner);
  });

  it('refuses 403 a user who is not the requester and does not manage requests, as for a movie', async () => {
    const { owner, movie, music } = await pendingPair();
    const other = await callerOf(
      await makeUser('other', PERMISSION_FOR.request)
    );

    assert.strictEqual(
      (await other.put(`/api/v1/request/${movie}`).send({ mediaType: 'movie' }))
        .status,
      403
    );
    assert.strictEqual(
      (await other.put(`/api/v1/request/${music}`).send({ mediaType: 'music' }))
        .status,
      403
    );
    await unchanged(music, owner);
  });

  it('edits for its requester as for a movie: with Request Advanced, not without', async () => {
    const without = await pendingPair();
    const agent = await callerOf(without.owner);

    assert.strictEqual(
      (
        await agent
          .put(`/api/v1/request/${without.movie}`)
          .send({ mediaType: 'movie' })
      ).status,
      403
    );
    assert.strictEqual(
      (
        await agent
          .put(`/api/v1/request/${without.music}`)
          .send({ mediaType: 'music' })
      ).status,
      403
    );

    without.owner.permissions =
      PERMISSION_FOR.request | Permission.REQUEST_ADVANCED;
    await getRepository(User).save(without.owner);

    assert.strictEqual(
      (
        await agent
          .put(`/api/v1/request/${without.movie}`)
          .send({ mediaType: 'movie' })
      ).status,
      200
    );
    assert.strictEqual(
      (
        await agent
          .put(`/api/v1/request/${without.music}`)
          .send({ mediaType: 'music' })
      ).status,
      200
    );
  });

  it('refuses 409 a request that is no longer pending, as for a movie', async () => {
    const { music } = await pendingPair();
    const admin = await callerOf(await makeUser('admin', PERMISSION_FOR.admin));
    const target = await makeUser('target', PERMISSION_FOR.request);

    await admin.post(`/api/v1/request/${music}/approve`);

    const res = await admin
      .put(`/api/v1/request/${music}`)
      .send({ mediaType: 'music', userId: target.id });

    assert.strictEqual(res.status, 409);
  });

  it('answers 404 for a request that is not there', async () => {
    const admin = await callerOf(await makeUser('admin', PERMISSION_FOR.admin));

    assert.strictEqual(
      (await admin.put('/api/v1/request/9999').send({ mediaType: 'music' }))
        .status,
      404
    );
  });

  const lacked: [string, Record<string, unknown>][] = [
    ['seasons', { seasons: [1] }],
    ['is4k true', { is4k: true }],
    ['a serverId', { serverId: 3 }],
    ['a profileId', { profileId: 7 }],
    ['a rootFolder', { rootFolder: '/elsewhere' }],
    ['a languageProfileId', { languageProfileId: 2 }],
    ['tags', { tags: [1] }],
    ['a musicBrainzId', { musicBrainzId: KID_A }],
    ['a musicKind', { musicKind: 'artist' }],
    ['another mediaType', { mediaType: 'movie' }],
    ['the mediaType tv', { mediaType: 'tv' }],
  ];

  for (const [name, extra] of lacked) {
    it(`answers 400 and changes nothing for ${name}, with a userId that would change the requester`, async () => {
      const { owner, music } = await pendingPair();
      const target = await makeUser('target', PERMISSION_FOR.request);

      for (const app of [validated, unvalidated]) {
        const agent = await loginAs(app, 'admin@seerr.dev');
        const res = await agent
          .put(`/api/v1/request/${music}`)
          .send({ mediaType: 'music', userId: target.id, ...extra });

        assert.strictEqual(res.status, 400, name);
        await unchanged(music, owner);
      }
    });
  }

  it('answers 400 for a mediaType music sent for a request that is not a music request, changing nothing', async () => {
    const { owner, movie } = await pendingPair();
    const admin = await callerOf(await makeUser('admin', PERMISSION_FOR.admin));
    const target = await makeUser('target', PERMISSION_FOR.request);
    const res = await admin
      .put(`/api/v1/request/${movie}`)
      .send({ mediaType: 'music', userId: target.id });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(
      (await getRepository(MediaRequest).findOneByOrFail({ id: movie }))
        .requestedBy.id,
      owner.id
    );
  });

  it('sends nothing to Lidarr, Radarr or Sonarr by an edit', async () => {
    const lidarrCalls: string[] = [];

    for (const method of [
      'addArtist',
      'updateArtist',
      'addAlbum',
      'monitorAlbums',
    ]) {
      stubs.stub(LidarrAPI.prototype, method, async () => {
        lidarrCalls.push(method);
      });
    }

    const { music } = await pendingPair();
    const target = await makeUser('target', PERMISSION_FOR.request);
    const admin = await callerOf(await makeUser('admin', PERMISSION_FOR.admin));

    await admin
      .put(`/api/v1/request/${music}`)
      .send({ mediaType: 'music', userId: target.id });

    assert.deepStrictEqual(lidarrCalls, []);
    assert.deepStrictEqual(arrCalls, []);
  });
});

describe('the requests lists, with music among movies and TV', () => {
  async function seedAll() {
    const owner = await makeUser('owner', PERMISSION_FOR.request);
    const admin = await makeUser('admin', PERMISSION_FOR.admin);
    const movie = await post(owner, movieBody());
    const tv = await post(owner, tvBody());
    const album = await post(owner, musicBody(OK_COMPUTER));
    const artist = await post(admin, musicBody(RADIOHEAD, MusicKind.ARTIST));

    return { owner, admin, movie, tv, album, artist };
  }

  const typesOf = (body: { results: { type: string }[] }) =>
    body.results.map((r) => r.type).sort();

  it('accepts mediaType=music, returns the music requests only with their media row, and keeps movie and tv as they are', async () => {
    const { admin, movie, tv, album, artist } = await seedAll();
    const agent = await callerOf(admin);

    const music = await agent.get('/api/v1/request?mediaType=music');

    assert.strictEqual(music.status, 200);
    assert.deepStrictEqual(typesOf(music.body), ['music', 'music']);
    assert.strictEqual(music.body.pageInfo.results, 2);

    for (const result of music.body.results) {
      assert.ok(result.media.id);
      assert.strictEqual(result.media.mediaType, 'music');
      assert.ok(result.media.musicBrainzId);
      assert.ok(['album', 'artist'].includes(result.media.musicKind));
    }

    const ids = music.body.results.map((r: { id: number }) => r.id).sort();

    assert.deepStrictEqual(ids, [album.body.id, artist.body.id].sort());

    const asMovie = await agent.get('/api/v1/request?mediaType=movie');
    const asTv = await agent.get('/api/v1/request?mediaType=tv');
    const all = await agent.get('/api/v1/request?mediaType=all');
    const bare = await agent.get('/api/v1/request');

    assert.deepStrictEqual(typesOf(asMovie.body), ['movie']);
    assert.deepStrictEqual(typesOf(asTv.body), ['tv']);
    assert.deepStrictEqual(typesOf(all.body), [
      'movie',
      'music',
      'music',
      'tv',
    ]);
    assert.deepStrictEqual(typesOf(bare.body), [
      'movie',
      'music',
      'music',
      'tv',
    ]);

    // the media row of a movie or TV request carries the keys it carried before
    // the music columns, and the status it stores
    for (const [made, type] of [
      [movie, 'movie'],
      [tv, 'tv'],
    ] as const) {
      const result = bare.body.results.find(
        (r: { id: number }) => r.id === made.body.id
      );

      assert.strictEqual(result.type, type);
      assert.ok(!('musicBrainzId' in result.media));
      assert.ok(!('musicKind' in result.media));
      assert.ok(!('artistMusicBrainzId' in result.media));
      assert.strictEqual(result.media.status, made.body.media.status);
    }
  });

  it('carries D-362’s status in each music request’s media, not the stored one', async () => {
    const { admin, album, artist } = await seedAll();
    const agent = await callerOf(admin);

    const find = (
      body: { results: { id: number; media: { status: number } }[] },
      id: number
    ) => body.results.find((r) => r.id === id)?.media.status;

    let listed = (await agent.get('/api/v1/request?mediaType=music')).body;

    // the album's own request is pending; the artist's whole-artist request was
    // made by an admin, so it is approved: processing
    assert.strictEqual(find(listed, album.body.id), MediaStatus.PENDING);
    assert.strictEqual(find(listed, artist.body.id), MediaStatus.PROCESSING);

    // the stored status is not what shows
    await getRepository(Media).update(
      { musicBrainzId: OK_COMPUTER },
      { status: MediaStatus.AVAILABLE }
    );
    await getRepository(Media).update(
      { musicBrainzId: OK_COMPUTER },
      { status: MediaStatus.UNKNOWN }
    );
    listed = (await agent.get('/api/v1/request?mediaType=music')).body;
    assert.strictEqual(find(listed, album.body.id), MediaStatus.PENDING);

    // a standing request of the artist covers the album: its own pending one and
    // the artist's approved one give pending, R-6's order
    await agent.post(`/api/v1/request/${album.body.id}/approve`);
    listed = (await agent.get('/api/v1/request?mediaType=music')).body;
    assert.strictEqual(find(listed, album.body.id), MediaStatus.PROCESSING);

    // a declined request leaves the item as if it had never been made
    await agent.post(`/api/v1/request/${artist.body.id}/decline`).send();
    listed = (await agent.get('/api/v1/request?mediaType=music')).body;
    assert.strictEqual(find(listed, album.body.id), MediaStatus.PROCESSING);

    // AVAILABLE as the row records it, set only by the Lidarr scan
    await getRepository(Media).update(
      { musicBrainzId: OK_COMPUTER },
      { status: MediaStatus.AVAILABLE }
    );
    listed = (await agent.get('/api/v1/request?mediaType=music')).body;
    assert.strictEqual(find(listed, album.body.id), MediaStatus.AVAILABLE);
  });

  it('shows an album its artist’s whole-artist request covers with the status that request gives', async () => {
    const admin = await makeUser('admin', PERMISSION_FOR.admin);

    await saveRequest(
      await saveRow(RADIOHEAD, MusicKind.ARTIST, MediaStatus.UNKNOWN),
      MediaRequestStatus.PENDING,
      admin
    );
    // an album request that stands apart from it, made while the artist's was declined
    const declined = await saveRequest(
      await saveRow(
        OK_COMPUTER,
        MusicKind.ALBUM,
        MediaStatus.PROCESSING,
        RADIOHEAD
      ),
      MediaRequestStatus.DECLINED,
      admin
    );
    const agent = await callerOf(admin);
    const listed = (await agent.get('/api/v1/request?mediaType=music')).body;
    const found = listed.results.find(
      (r: { id: number }) => r.id === declined.id
    );

    assert.strictEqual(found.media.status, MediaStatus.PENDING);
  });

  it('leaves the rest of the list standing where an album’s covering is undecided, giving it the status its own requests give', async () => {
    mock.restoreAll();
    source({ musicBrainz: new Error('MusicBrainz is down') });
    const admin = await makeUser('admin', PERMISSION_FOR.admin);

    await saveRequest(
      await saveRow(RADIOHEAD, MusicKind.ARTIST),
      MediaRequestStatus.PENDING,
      admin
    );
    const album = await saveRequest(
      await saveRow(
        OK_COMPUTER,
        MusicKind.ALBUM,
        MediaStatus.UNKNOWN,
        RADIOHEAD
      ),
      MediaRequestStatus.APPROVED,
      admin
    );
    const agent = await callerOf(admin);

    for (const path of [
      '/api/v1/request?mediaType=music',
      '/api/v1/request',
      `/api/v1/user/${admin.id}/requests?mediaType=music`,
      `/api/v1/user/${admin.id}/requests`,
    ]) {
      const res = await agent.get(path);

      assert.strictEqual(res.status, 200, path);
      assert.strictEqual(res.body.results.length, 2, path);
      assert.strictEqual(
        res.body.results.find((r: { id: number }) => r.id === album.id).media
          .status,
        MediaStatus.PROCESSING,
        path
      );
      assert.strictEqual(
        res.body.results.find((r: { id: number }) => r.id !== album.id).media
          .status,
        MediaStatus.PENDING,
        path
      );
    }
  });

  it('shows an available album as available where its covering is undecided', async () => {
    mock.restoreAll();
    source({ musicBrainz: new Error('MusicBrainz is down') });
    const admin = await makeUser('admin', PERMISSION_FOR.admin);

    await saveRequest(
      await saveRow(RADIOHEAD, MusicKind.ARTIST),
      MediaRequestStatus.PENDING,
      admin
    );
    const album = await saveRequest(
      await saveRow(
        OK_COMPUTER,
        MusicKind.ALBUM,
        MediaStatus.AVAILABLE,
        RADIOHEAD
      ),
      MediaRequestStatus.COMPLETED,
      admin
    );
    const res = await (await callerOf(admin)).get('/api/v1/request');

    assert.strictEqual(
      res.body.results.find((r: { id: number }) => r.id === album.id).media
        .status,
      MediaStatus.AVAILABLE
    );
  });

  it('applies the existing filters and sorting to music requests', async () => {
    const owner = await makeUser('owner', PERMISSION_FOR.request);
    const admin = await makeUser('admin', PERMISSION_FOR.admin);
    const first = await post(owner, musicBody(OK_COMPUTER));
    const second = await post(owner, musicBody(KID_A));
    const third = await post(admin, musicBody(AMNESIAC));
    const agent = await callerOf(admin);

    await agent.post(`/api/v1/request/${second.body.id}/decline`);

    const ids = async (query: string) =>
      (
        await agent.get(`/api/v1/request?mediaType=music&${query}`)
      ).body.results.map((r: { id: number }) => r.id);

    assert.deepStrictEqual(await ids('filter=pending'), [first.body.id]);
    assert.deepStrictEqual(await ids('filter=approved'), [third.body.id]);
    assert.deepStrictEqual(await ids('filter=processing'), [third.body.id]);
    assert.deepStrictEqual(await ids('filter=failed'), []);
    assert.deepStrictEqual(await ids('sort=added&sortDirection=asc'), [
      first.body.id,
      second.body.id,
      third.body.id,
    ]);
    assert.deepStrictEqual(await ids('sort=added&sortDirection=desc'), [
      third.body.id,
      second.body.id,
      first.body.id,
    ]);
    assert.deepStrictEqual(
      await ids(`requestedBy=${owner.id}`).then((l: number[]) => l.sort()),
      [first.body.id, second.body.id].sort()
    );
    assert.deepStrictEqual((await ids('take=1&skip=1')).length, 1);

    // available, as the lists name it: a request completed whose media is
    await getRepository(Media).update(
      { musicBrainzId: AMNESIAC },
      { status: MediaStatus.AVAILABLE }
    );
    await getRepository(MediaRequest).update(
      { id: third.body.id },
      { status: MediaRequestStatus.COMPLETED }
    );
    assert.deepStrictEqual(await ids('filter=available'), [third.body.id]);
    assert.deepStrictEqual(await ids('filter=completed'), [third.body.id]);
  });

  it('shows a user its own requests, music included, and another user’s only to one who may', async () => {
    const { owner, album } = await seedAll();
    const other = await callerOf(
      await makeUser('other', PERMISSION_FOR.request)
    );
    const agent = await callerOf(owner);

    const mine = await agent.get(`/api/v1/user/${owner.id}/requests`);

    assert.strictEqual(mine.status, 200);
    assert.deepStrictEqual(typesOf(mine.body), ['movie', 'music', 'tv']);

    const music = await agent.get(
      `/api/v1/user/${owner.id}/requests?mediaType=music`
    );

    assert.deepStrictEqual(typesOf(music.body), ['music']);
    assert.strictEqual(music.body.results[0].id, album.body.id);
    assert.strictEqual(music.body.results[0].media.status, MediaStatus.PENDING);
    assert.strictEqual(music.body.pageInfo.results, 1);

    for (const type of ['movie', 'tv']) {
      const res = await agent.get(
        `/api/v1/user/${owner.id}/requests?mediaType=${type}`
      );

      assert.deepStrictEqual(typesOf(res.body), [type]);
    }

    assert.strictEqual(
      (await other.get(`/api/v1/user/${owner.id}/requests?mediaType=music`))
        .status,
      403
    );
    assert.strictEqual(
      (await agent.get(`/api/v1/user/${owner.id}/requests?mediaType=book`))
        .status,
      400
    );
  });

  it('leaves the request counts as they are for movies and TV', async () => {
    const { admin } = await seedAll();
    const res = await (await callerOf(admin)).get('/api/v1/request/count');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.movie, 1);
    assert.strictEqual(res.body.tv, 1);
    assert.strictEqual(res.body.total, 4);
  });

  it('asks neither TMDB, Radarr nor Sonarr for a music request in the lists', async () => {
    const admin = await makeUser('admin', PERMISSION_FOR.admin);

    await post(admin, musicBody(OK_COMPUTER));
    tmdbCalls = [];

    const agent = await callerOf(admin);

    await agent.get('/api/v1/request?mediaType=music');
    await agent.get(`/api/v1/user/${admin.id}/requests`);

    assert.deepStrictEqual(tmdbCalls, []);
    assert.deepStrictEqual(arrCalls, []);
  });
});

describe('the readers of media_request that a music request reaches', () => {
  it('does not let a music request touch the quota of a movie or TV request, nor fail the quota read', async () => {
    const user = await makeUser('limited', PERMISSION_FOR.request);

    user.movieQuotaLimit = 2;
    user.tvQuotaLimit = 2;
    await getRepository(User).save(user);

    await post(user, movieBody());
    await post(user, musicBody(OK_COMPUTER));
    await post(user, musicBody(KID_A));

    const quota = await (
      await getRepository(User).findOneByOrFail({ id: user.id })
    ).getQuota();

    assert.strictEqual(quota.movie.used, 1);
    assert.strictEqual(quota.movie.remaining, 1);
    assert.strictEqual(quota.tv.used, 0);
  });

  it('does not fail where the media of an approved music request becomes available', async () => {
    const errors = mock.method(logger, 'error', () => undefined);
    const admin = await makeUser('admin', PERMISSION_FOR.admin);
    const made = await post(admin, musicBody());
    const media = await getRepository(Media).findOneByOrFail({
      id: made.body.media.id,
    });

    media.status = MediaStatus.AVAILABLE;
    await getRepository(Media).save(media);

    assert.strictEqual(errors.mock.callCount(), 0);
    assert.deepStrictEqual(tmdbCalls, []);
    assert.strictEqual(
      (await (await callerOf(admin)).get(`/api/v1/request/${made.body.id}`))
        .status,
      200
    );
  });
});

describe('POST /request (music), covering under the saved metadata profile (D-362)', () => {
  // S139's Burial: Lidarr lists 13 albums for the held artist under a profile
  // taking in EPs (2 Album, 11 EP); the saved profile takes in Albums only. The
  // artist's id stands as Radiohead's here.
  const listed = burialUnderOtherProfile();
  const ALBUM = listed[0].foreignAlbumId;
  const EP = listed[1].foreignAlbumId;

  it('refuses an Album the whole-artist request covers 409 and accepts an EP of the same artist 201 while it stands', async () => {
    mock.restoreAll();
    source({ held: true, heldAlbums: listed });
    const admin = await makeUser('admin', PERMISSION_FOR.admin);

    await saveRequest(
      await saveRow(RADIOHEAD, MusicKind.ARTIST),
      MediaRequestStatus.PENDING
    );

    const refused = await post(admin, musicBody(ALBUM));

    assert.strictEqual(refused.status, 409);
    assert.strictEqual((await counts()).requests, 1);

    const accepted = await post(admin, musicBody(EP));

    assert.strictEqual(accepted.status, 201);
    assert.strictEqual((await counts()).requests, 2);
    // the EP's own request now covers it, as a request of one album does
    assert.strictEqual((await post(admin, musicBody(EP))).status, 409);
  });

  it('answers 500 with a message and creates nothing where the saved profile cannot be read or is not Lidarr’s, a whole-artist request standing', async () => {
    const admin = await makeUser('admin', PERMISSION_FOR.admin);

    await saveRequest(
      await saveRow(RADIOHEAD, MusicKind.ARTIST),
      MediaRequestStatus.PENDING
    );

    const before = await counts();

    for (const profile of [new Error('Lidarr is down'), 'lacking' as const]) {
      mock.restoreAll();
      cacheManager.getCache('lidarr').flush();
      source({ held: true, heldAlbums: listed, profile });

      for (const id of [ALBUM, EP]) {
        const made = await post(admin, musicBody(id));

        assert.strictEqual(made.status, 500, id);
        assert.ok(made.body.message, id);
        assert.deepStrictEqual(await counts(), before);
      }
    }
  });

  it('reads no profile for an album that no whole-artist request of its artist stands for', async () => {
    mock.restoreAll();
    source({ held: true, heldAlbums: listed, profile: 'lacking' });
    const admin = await makeUser('admin', PERMISSION_FOR.admin);

    assert.strictEqual((await post(admin, musicBody(EP))).status, 201);
  });

  it('leaves the rest of the requests list standing where the saved profile cannot be read, an album request carrying the status its own requests give', async () => {
    mock.restoreAll();
    source({ held: true, heldAlbums: listed, profile: 'lacking' });
    const admin = await makeUser('admin', PERMISSION_FOR.admin);

    await saveRequest(
      await saveRow(RADIOHEAD, MusicKind.ARTIST),
      MediaRequestStatus.PENDING,
      admin
    );
    const album = await saveRequest(
      await saveRow(EP, MusicKind.ALBUM, MediaStatus.UNKNOWN, RADIOHEAD),
      MediaRequestStatus.FAILED,
      admin
    );
    const res = await (await callerOf(admin)).get('/api/v1/request');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.results.length, 2);
    assert.strictEqual(
      res.body.results.find((r: { id: number }) => r.id === album.id).media
        .status,
      MediaStatus.PROCESSING
    );
  });
});
