import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import { getLidarrMetadata } from '@server/api/lidarrmetadata';
import { getMusicBrainz } from '@server/api/musicbrainz';
import type { LidarrAlbum, LidarrArtist } from '@server/api/servarr/lidarr';
import LidarrAPI from '@server/api/servarr/lidarr';
import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieResult,
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
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import { radarrServer, sonarrServer } from '@server/test/servers';
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
import musicRoutes from './music';
import searchRoutes from './search';

// The status of a music item's mediaInfo in the music routes and in search
// (D-362, R-6): computed from the row and the standing requests that cover the
// item, never the stored one; an item with no row has a mediaInfo only where a
// covering request gives it a status; an album whose covering is undecided is
// answered 500 and left out of search; and a movie's and a TV show's mediaInfo
// are as they were (D-8).

const API_SPEC_PATH = join(__dirname, '../../seerr-api.yml');

const RADIOHEAD = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const OK_COMPUTER = 'b1392450-e666-3926-a536-22c65f834433';
const KID_A = 'e75c0549-ad55-39e3-8025-c72c5d4a3c5d';
const AMNESIAC = '7e8e1f5e-6a4b-3e2a-8f0a-3b1b2c5f1d11';
const THIRD_ARTIST = '3ecaa799-94ae-45cd-9ad1-bcabae4073e1';

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

let app: Express;
let unvalidated: Express;
const stubs = new MethodStubs();
let metadataCalls: string[];

// The music routes and search behind authentication with the OpenAPI validator
// of server/index.ts in front of them, validating what they answer too, so that
// seerr-api.yml is held to describe the answers (PIL-API). A request's
// requestedBy is filtered of its email as /movie/:id's is, which the User schema
// already requires: an answer that carries a request is checked unvalidated.
function createApp(validateResponses: boolean): Express {
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
  api.use('/music', musicRoutes);
  api.use('/search', searchRoutes);

  return createRoutesApp({ '/api/v1': authenticated(api) });
}

before(() => {
  app = createApp(true);
  unvalidated = createApp(false);
});

setupTestDb();

beforeEach(() => {
  metadataCalls = [];
  getSettings().radarr = [radarrServer()];
  getSettings().sonarr = [sonarrServer()];
  getSettings().lidarr = [{ ...server }];
  cacheManager.getCache('lidarr').flush();
  cacheManager.getCache('musicbrainz').flush();
  cacheManager.getCache('lidarrmetadata').flush();
  // the sending of an approved music request to Lidarr is T-158's (its own tests);
  // a request made or approved here reaches no Lidarr
  stubs.stub(MediaRequestSubscriber.prototype, 'sendToLidarr');
});

afterEach(() => {
  stubs.restore();
  mock.restoreAll();
});

interface Source {
  // the artists of Lidarr's list of what it holds, the albums of the artist it
  // holds, and the release groups MusicBrainz lists
  held?: boolean;
  heldAlbums?: (string | LidarrAlbum)[] | Error;
  musicBrainz?: string[] | Error;
  // the saved metadata profile as Lidarr answers it
  profile?: 'saved' | 'lacking' | Error;
  searchArtists?: LidarrArtist[];
  searchAlbums?: LidarrAlbum[];
}

// Lidarr's and MusicBrainz's answers for Radiohead, as the music service reads
// them
function source({
  held = false,
  heldAlbums = [],
  musicBrainz = [],
  profile = 'saved',
  searchArtists = [],
  searchAlbums = [],
}: Source = {}) {
  const lookedUpArtist = lidarrFixture<LidarrArtist[]>('artist-lookup-mbid')[0];
  const lookedUpAlbum = lidarrFixture<LidarrAlbum[]>('album-lookup-mbid')[0];
  const proto = LidarrAPI.prototype;

  mock.method(proto, 'getArtists', async () => {
    metadataCalls.push('getArtists');

    return held
      ? ([
          { id: 7, foreignArtistId: RADIOHEAD, artistName: 'Radiohead' },
        ] as LidarrArtist[])
      : [];
  });
  mock.method(proto, 'getAlbums', async () => {
    metadataCalls.push('getAlbums');

    if (heldAlbums instanceof Error) {
      throw heldAlbums;
    }

    return heldAlbums.map((entry) =>
      typeof entry === 'string' ? listedAlbum(entry) : entry
    );
  });
  mock.method(proto, 'getMetadataProfile', async (id: number) => {
    metadataCalls.push('getMetadataProfile');

    return savedProfileAnswer(profile, id);
  });
  mock.method(proto, 'lookupArtistByMbid', async () => lookedUpArtist);
  mock.method(proto, 'lookupAlbumByMbid', async () => lookedUpAlbum);
  mock.method(proto, 'getTracks', async () => []);
  mock.method(proto, 'lookupArtists', async () => searchArtists);
  mock.method(proto, 'lookupAlbums', async () => searchAlbums);
  mock.method(getLidarrMetadata(), 'getArtist', async () => null);
  mock.method(getMusicBrainz(), 'getRelease', async () => ({
    id: 'release',
    title: 'OK Computer',
    media: [],
  }));
  mock.method(getMusicBrainz(), 'getArtistAlbums', async () => {
    metadataCalls.push('musicbrainz');

    if (musicBrainz instanceof Error) {
      throw musicBrainz;
    }

    return musicBrainz.map((id) => ({
      id,
      title: `Album ${id}`,
      'primary-type': 'Album',
    }));
  });
}

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
  status: MediaRequestStatus
): Promise<MediaRequest> {
  const owner = await getRepository(User).findOneByOrFail({
    email: 'admin@seerr.dev',
  });

  return getRepository(MediaRequest).save(
    new MediaRequest({
      type: media.mediaType,
      media,
      requestedBy: owner,
      modifiedBy: owner,
      status,
      is4k: false,
    })
  );
}

async function get(path: string, validated = false) {
  const agent = await loginAs(validated ? app : unvalidated);

  return agent.get(`/api/v1${path}`);
}

const artistRequestOf = async (status: MediaRequestStatus) =>
  saveRequest(await saveRow(RADIOHEAD, MusicKind.ARTIST), status);

describe('GET /music/album/:mbid', () => {
  it('answers no mediaInfo for an album with no row and no covering request', async () => {
    source();

    const res = await get(`/music/album/${OK_COMPUTER}`, true);

    assert.strictEqual(res.status, 200);
    assert.ok(!('mediaInfo' in res.body));
  });

  it('answers the status of its own requests as mediaInfo.status, not the one its row stores', async () => {
    source();
    const row = await saveRow(
      OK_COMPUTER,
      MusicKind.ALBUM,
      MediaStatus.PROCESSING,
      RADIOHEAD
    );

    assert.strictEqual(
      (await get(`/music/album/${OK_COMPUTER}`)).body.mediaInfo.status,
      MediaStatus.UNKNOWN
    );

    const request = await saveRequest(row, MediaRequestStatus.PENDING);

    assert.strictEqual(
      (await get(`/music/album/${OK_COMPUTER}`)).body.mediaInfo.status,
      MediaStatus.PENDING
    );

    request.status = MediaRequestStatus.APPROVED;
    await getRepository(MediaRequest).save(request);

    const res = await get(`/music/album/${OK_COMPUTER}`);

    assert.strictEqual(res.body.mediaInfo.status, MediaStatus.PROCESSING);
    assert.strictEqual(res.body.mediaInfo.id, row.id);
    assert.strictEqual(res.body.mediaInfo.requests.length, 1);
    assert.strictEqual(
      res.body.mediaInfo.requests[0].status,
      MediaRequestStatus.APPROVED
    );

    request.status = MediaRequestStatus.FAILED;
    await getRepository(MediaRequest).save(request);

    assert.strictEqual(
      (await get(`/music/album/${OK_COMPUTER}`)).body.mediaInfo.status,
      MediaStatus.PROCESSING
    );

    request.status = MediaRequestStatus.DECLINED;
    await getRepository(MediaRequest).save(request);

    assert.strictEqual(
      (await get(`/music/album/${OK_COMPUTER}`)).body.mediaInfo.status,
      MediaStatus.UNKNOWN
    );
  });

  it('answers AVAILABLE as its row records it', async () => {
    source();
    const row = await saveRow(
      OK_COMPUTER,
      MusicKind.ALBUM,
      MediaStatus.AVAILABLE,
      RADIOHEAD
    );
    await saveRequest(row, MediaRequestStatus.PENDING);

    const res = await get(`/music/album/${OK_COMPUTER}`);

    assert.strictEqual(res.body.mediaInfo.status, MediaStatus.AVAILABLE);
  });

  it('answers a mediaInfo carrying the status of its artist’s whole-artist request, with no id, for an album with no row that is among the artist’s albums', async () => {
    source({ held: true, heldAlbums: [OK_COMPUTER, KID_A] });
    await artistRequestOf(MediaRequestStatus.APPROVED);

    const res = await get(`/music/album/${OK_COMPUTER}`, true);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.mediaInfo.status, MediaStatus.PROCESSING);
    assert.ok(!('id' in res.body.mediaInfo));
    assert.strictEqual(res.body.mediaInfo.musicBrainzId, OK_COMPUTER);
    assert.strictEqual(res.body.mediaInfo.musicKind, 'album');
    assert.deepStrictEqual(res.body.mediaInfo.requests, []);
  });

  it('answers no mediaInfo where the album is not among the artist’s albums, and asks MusicBrainz for nothing of Lidarr’s artist', async () => {
    source({ held: true, heldAlbums: [KID_A], musicBrainz: [OK_COMPUTER] });
    await artistRequestOf(MediaRequestStatus.PENDING);

    const res = await get(`/music/album/${OK_COMPUTER}`);

    assert.strictEqual(res.status, 200);
    assert.ok(!('mediaInfo' in res.body));
    assert.ok(!metadataCalls.includes('musicbrainz'));
  });

  it('answers no mediaInfo for a declined whole-artist request, and reads no albums for it', async () => {
    source({ held: true, heldAlbums: [OK_COMPUTER] });
    await artistRequestOf(MediaRequestStatus.DECLINED);

    const res = await get(`/music/album/${OK_COMPUTER}`);

    assert.strictEqual(res.status, 200);
    assert.ok(!('mediaInfo' in res.body));
    assert.ok(!metadataCalls.includes('getAlbums'));
  });

  it('answers 500 with a stated message where a whole-artist request of its artist stands and the artist’s albums cannot be read', async () => {
    source({ held: true, heldAlbums: new Error('Lidarr is down') });
    await artistRequestOf(MediaRequestStatus.PENDING);

    const res = await get(`/music/album/${OK_COMPUTER}`);

    assert.strictEqual(res.status, 500);
    assert.strictEqual(
      res.body.message,
      "Unable to determine whether the album is covered by its artist's request."
    );
  });

  it('answers 500 likewise where MusicBrainz fails for an artist Lidarr lacks', async () => {
    source({ held: false, musicBrainz: new Error('503') });
    await artistRequestOf(MediaRequestStatus.APPROVED);

    assert.strictEqual((await get(`/music/album/${OK_COMPUTER}`)).status, 500);
  });

  it('answers 200 where the artist’s albums cannot be read but no whole-artist request of the artist stands', async () => {
    source({ held: true, heldAlbums: new Error('Lidarr is down') });
    const row = await saveRow(
      OK_COMPUTER,
      MusicKind.ALBUM,
      MediaStatus.UNKNOWN,
      RADIOHEAD
    );
    await saveRequest(row, MediaRequestStatus.PENDING);

    const res = await get(`/music/album/${OK_COMPUTER}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.mediaInfo.status, MediaStatus.PENDING);
    assert.ok(!metadataCalls.includes('getAlbums'));
  });
});

describe('GET /music/artist/:mbid', () => {
  it('answers the status of its whole-artist request as mediaInfo.status', async () => {
    source({ musicBrainz: [OK_COMPUTER] });
    const request = await artistRequestOf(MediaRequestStatus.PENDING);

    const res = await get(`/music/artist/${RADIOHEAD}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.mediaInfo.status, MediaStatus.PENDING);

    request.status = MediaRequestStatus.APPROVED;
    await getRepository(MediaRequest).save(request);

    assert.strictEqual(
      (await get(`/music/artist/${RADIOHEAD}`)).body.mediaInfo.status,
      MediaStatus.PROCESSING
    );
  });

  it('answers PARTIALLY_AVAILABLE as its row records it, before its request', async () => {
    source();
    const request = await artistRequestOf(MediaRequestStatus.PENDING);
    await getRepository(Media).update(
      { id: request.media.id },
      { status: MediaStatus.PARTIALLY_AVAILABLE }
    );

    const res = await get(`/music/artist/${RADIOHEAD}`);

    assert.strictEqual(
      res.body.mediaInfo.status,
      MediaStatus.PARTIALLY_AVAILABLE
    );
  });

  it('answers no mediaInfo for an artist with no row, and none made requested by a request of one of its albums', async () => {
    source({ musicBrainz: [OK_COMPUTER] });

    assert.ok(!('mediaInfo' in (await get(`/music/artist/${RADIOHEAD}`)).body));

    const row = await saveRow(
      OK_COMPUTER,
      MusicKind.ALBUM,
      MediaStatus.UNKNOWN,
      RADIOHEAD
    );
    await saveRequest(row, MediaRequestStatus.PENDING);

    const res = await get(`/music/artist/${RADIOHEAD}`);

    assert.ok(!('mediaInfo' in res.body));
    assert.strictEqual(
      res.body.albums[0].mediaInfo.status,
      MediaStatus.PENDING
    );
  });

  it('answers each album of its list its status: its own requests’, its artist’s whole-artist request’s, or its row’s AVAILABLE', async () => {
    source({
      held: true,
      heldAlbums: [OK_COMPUTER, KID_A, AMNESIAC],
    });
    await artistRequestOf(MediaRequestStatus.PENDING);
    const kidA = await saveRow(
      KID_A,
      MusicKind.ALBUM,
      MediaStatus.PROCESSING,
      RADIOHEAD
    );
    await saveRequest(kidA, MediaRequestStatus.APPROVED);
    await saveRow(AMNESIAC, MusicKind.ALBUM, MediaStatus.AVAILABLE, RADIOHEAD);

    const res = await get(`/music/artist/${RADIOHEAD}`);

    assert.strictEqual(res.status, 200);

    const status = (id: string) =>
      res.body.albums.find((a: { id: string }) => a.id === id).mediaInfo;

    // covered by the whole-artist request that waits, with no row of its own
    assert.strictEqual(status(OK_COMPUTER).status, MediaStatus.PENDING);
    assert.ok(!('id' in status(OK_COMPUTER)));
    // its own approved request, while its artist's waits: PENDING (R-6's order)
    assert.strictEqual(status(KID_A).status, MediaStatus.PENDING);
    assert.strictEqual(status(KID_A).id, kidA.id);
    assert.strictEqual(status(AMNESIAC).status, MediaStatus.AVAILABLE);
    assert.strictEqual(
      metadataCalls.filter((call) => call === 'getAlbums').length,
      1,
      'the albums are read with the list, once'
    );
  });

  it('answers an album with no standing request of its own or its artist’s no mediaInfo, and shows the album of a declined request as never requested', async () => {
    source({ held: true, heldAlbums: [OK_COMPUTER, KID_A] });
    await artistRequestOf(MediaRequestStatus.DECLINED);
    const row = await saveRow(
      KID_A,
      MusicKind.ALBUM,
      MediaStatus.UNKNOWN,
      RADIOHEAD
    );
    await saveRequest(row, MediaRequestStatus.DECLINED);

    const res = await get(`/music/artist/${RADIOHEAD}`);

    const ok = res.body.albums.find(
      (a: { id: string }) => a.id === OK_COMPUTER
    );
    const kid = res.body.albums.find((a: { id: string }) => a.id === KID_A);

    assert.ok(!('mediaInfo' in ok));
    assert.strictEqual(kid.mediaInfo.status, MediaStatus.UNKNOWN);
  });
});

describe('the albums of a held artist under the saved metadata profile (D-362)', () => {
  // S139's Burial: Lidarr lists 13 albums for the held artist under a profile
  // taking in EPs (2 Album, 11 EP); the saved profile takes in Albums only. The
  // artist's id stands as Radiohead's here.
  const listed = burialUnderOtherProfile();
  const albums = listed.filter((a) => a.albumType === 'Album');
  const eps = listed.filter((a) => a.albumType === 'EP');

  const byId = (res: { body: { albums: { id: string }[] } }, id: string) =>
    res.body.albums.find((a) => a.id === id) as {
      mediaInfo?: { status: number };
    };

  it('shows each album of the artist’s page its own status: the Albums covered by the whole-artist request, the EPs not', async () => {
    source({ held: true, heldAlbums: listed });
    await artistRequestOf(MediaRequestStatus.PENDING);

    const res = await get(`/music/artist/${RADIOHEAD}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.albums.length, 13);
    assert.strictEqual(res.body.mediaInfo.status, MediaStatus.PENDING);

    for (const a of albums) {
      assert.strictEqual(
        byId(res, a.foreignAlbumId).mediaInfo?.status,
        MediaStatus.PENDING,
        a.title
      );
    }

    for (const ep of eps) {
      assert.ok(!('mediaInfo' in byId(res, ep.foreignAlbumId)), ep.title);
    }
  });

  it('shows an EP its own request’s status where one stands, beside the covered Albums', async () => {
    source({ held: true, heldAlbums: listed });
    await artistRequestOf(MediaRequestStatus.PENDING);
    await saveRequest(
      await saveRow(
        eps[0].foreignAlbumId,
        MusicKind.ALBUM,
        MediaStatus.UNKNOWN,
        RADIOHEAD
      ),
      MediaRequestStatus.FAILED
    );

    const res = await get(`/music/artist/${RADIOHEAD}`);

    assert.strictEqual(
      byId(res, eps[0].foreignAlbumId).mediaInfo?.status,
      MediaStatus.PROCESSING
    );
    assert.ok(!('mediaInfo' in byId(res, eps[1].foreignAlbumId)));
  });

  it('answers an Album’s route covered and an EP’s route not', async () => {
    source({ held: true, heldAlbums: listed });
    await artistRequestOf(MediaRequestStatus.APPROVED);

    const album = await get(`/music/album/${albums[0].foreignAlbumId}`, true);
    const ep = await get(`/music/album/${eps[0].foreignAlbumId}`, true);

    assert.strictEqual(album.status, 200);
    assert.strictEqual(album.body.mediaInfo.status, MediaStatus.PROCESSING);
    assert.strictEqual(ep.status, 200);
    assert.ok(!('mediaInfo' in ep.body));
  });

  it('answers 500 with a stated message on the artist’s route and on its albums’ routes where the saved profile cannot be read or is not Lidarr’s, a whole-artist request standing', async () => {
    await artistRequestOf(MediaRequestStatus.PENDING);

    for (const profile of [new Error('Lidarr is down'), 'lacking' as const]) {
      mock.restoreAll();
      cacheManager.getCache('lidarr').flush();
      source({ held: true, heldAlbums: listed, profile });

      const page = await get(`/music/artist/${RADIOHEAD}`, true);

      assert.strictEqual(page.status, 500);
      assert.strictEqual(
        page.body.message,
        "Unable to determine which albums the artist's whole-artist request covers."
      );

      for (const id of [albums[0].foreignAlbumId, eps[0].foreignAlbumId]) {
        assert.strictEqual((await get(`/music/album/${id}`)).status, 500, id);
      }
    }
  });

  it('answers 500 on the artist route where its albums cannot be listed while its whole-artist request stands (F-1806), each album route too', async () => {
    source({ held: true, heldAlbums: new Error('Lidarr is down') });
    await artistRequestOf(MediaRequestStatus.PENDING);

    const res = await get(`/music/artist/${RADIOHEAD}`);

    assert.strictEqual(res.status, 500);
    assert.strictEqual(
      res.body.message,
      "Unable to determine which albums the artist's whole-artist request covers."
    );
    assert.strictEqual((await get(`/music/album/${OK_COMPUTER}`)).status, 500);
  });

  it('shows the page of a held artist whose albums Lidarr cannot list with no album where no whole-artist request of it stands', async () => {
    source({ held: true, heldAlbums: new Error('Lidarr is down') });

    const res = await get(`/music/artist/${RADIOHEAD}`);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.albums, []);
  });

  it('asks no profile and answers 200 where no whole-artist request of the artist stands', async () => {
    source({ held: true, heldAlbums: listed, profile: 'lacking' });

    const res = await get(`/music/artist/${RADIOHEAD}`, true);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.albums.length, 13);
    assert.ok(!metadataCalls.includes('getMetadataProfile'));
  });

  it('is decided for an artist Lidarr lacks by the albums its page shows, with no profile read', async () => {
    source({ musicBrainz: [OK_COMPUTER, KID_A], profile: 'lacking' });
    await artistRequestOf(MediaRequestStatus.PENDING);

    const res = await get(`/music/artist/${RADIOHEAD}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(
      byId(res, OK_COMPUTER).mediaInfo?.status,
      MediaStatus.PENDING
    );
    assert.ok(!metadataCalls.includes('getMetadataProfile'));
  });
});

describe('GET /search', () => {
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
  };

  function tmdbAnswers() {
    stubs.stub(
      TheMovieDb.prototype,
      'searchMulti',
      async (): Promise<TmdbSearchMultiResponse> => ({
        page: 1,
        total_pages: 1,
        total_results: 2,
        results: [movie, tv],
      })
    );
  }

  const artists = () => lidarrFixture<LidarrArtist[]>('artist-lookup-term');
  const albums = () => lidarrFixture<LidarrAlbum[]>('album-lookup-term');

  async function search(validated = false) {
    tmdbAnswers();

    return get('/search?query=radiohead&page=1', validated);
  }

  interface Answer {
    id: string;
    mediaInfo?: { id?: number; status: number; musicBrainzId?: string };
  }

  // a music result by its id
  const find = (res: { body: { results: Answer[] } }, id: string): Answer =>
    res.body.results.find((r) => r.id === id) as Answer;

  it('answers the status of its requests on each music result, and no mediaInfo for an item with no row and no covering request', async () => {
    source({
      held: true,
      heldAlbums: [OK_COMPUTER],
      searchArtists: artists(),
      searchAlbums: albums(),
    });
    const artistRow = await saveRow(
      RADIOHEAD,
      MusicKind.ARTIST,
      MediaStatus.PROCESSING
    );
    await saveRequest(artistRow, MediaRequestStatus.PENDING);

    const res = await search();

    assert.strictEqual(res.status, 200);
    // the artist: its whole-artist request, not the status its row stores
    assert.strictEqual(
      find(res, RADIOHEAD).mediaInfo?.status,
      MediaStatus.PENDING
    );
    // the album Lidarr's artist lists, covered by that request, with no row
    assert.strictEqual(
      find(res, OK_COMPUTER).mediaInfo?.status,
      MediaStatus.PENDING
    );
    // another artist and another album: nothing covers them
    assert.ok(!('mediaInfo' in find(res, THIRD_ARTIST)));
    assert.ok(
      !('mediaInfo' in find(res, 'e48fc8b3-e8ab-4dd4-9dc8-6b0f06ef07d6'))
    );
    assert.ok(
      !('mediaInfo' in find(res, 'a5e4bd1a-63c9-4dfc-9e63-ed0c3dc049be'))
    );
  });

  it('answers AVAILABLE and PARTIALLY_AVAILABLE as the rows record them', async () => {
    source({ searchArtists: artists(), searchAlbums: albums() });
    await saveRow(RADIOHEAD, MusicKind.ARTIST, MediaStatus.PARTIALLY_AVAILABLE);
    await saveRow(
      OK_COMPUTER,
      MusicKind.ALBUM,
      MediaStatus.AVAILABLE,
      RADIOHEAD
    );

    const res = await search(true);

    assert.strictEqual(
      find(res, RADIOHEAD).mediaInfo?.status,
      MediaStatus.PARTIALLY_AVAILABLE
    );
    assert.strictEqual(
      find(res, OK_COMPUTER).mediaInfo?.status,
      MediaStatus.AVAILABLE
    );
  });

  it('answers an album with no row, not among the artist’s albums, as not covered by the artist’s request', async () => {
    source({
      held: true,
      heldAlbums: [KID_A],
      searchArtists: artists(),
      searchAlbums: albums(),
    });
    await artistRequestOf(MediaRequestStatus.PENDING);

    const res = await search();

    assert.ok(!('mediaInfo' in find(res, OK_COMPUTER)));
  });

  it('leaves out the album whose covering is undecided, every other result standing', async () => {
    source({
      held: true,
      heldAlbums: new Error('Lidarr is down'),
      searchArtists: artists(),
      searchAlbums: albums(),
    });
    const request = await artistRequestOf(MediaRequestStatus.PENDING);

    const res = await search();

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(
      res.body.results.map((r: { mediaType: string }) => r.mediaType),
      ['movie', 'tv', 'artist', 'artist', 'artist', 'album']
    );
    // the album of another artist stays, and the artist shows its own status
    assert.strictEqual(
      res.body.results.filter((r: { id: string }) => r.id === OK_COMPUTER)
        .length,
      0
    );
    assert.strictEqual(
      find(res, RADIOHEAD).mediaInfo?.status,
      MediaStatus.PENDING
    );
    assert.strictEqual(res.body.totalResults, 2 + 4);

    // and it is back once the albums can be read
    mock.restoreAll();
    cacheManager.getCache('lidarr').flush();
    source({
      held: true,
      heldAlbums: [OK_COMPUTER],
      searchArtists: artists(),
      searchAlbums: albums(),
    });

    const again = await search();

    assert.strictEqual(
      find(again, OK_COMPUTER).mediaInfo?.status,
      MediaStatus.PENDING
    );
    assert.ok(request.id);
  });

  it('leaves out the album where the saved metadata profile cannot be read, every other result standing', async () => {
    source({
      held: true,
      heldAlbums: [OK_COMPUTER],
      profile: 'lacking',
      searchArtists: artists(),
      searchAlbums: albums(),
    });
    await artistRequestOf(MediaRequestStatus.PENDING);

    const res = await search();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(find(res, OK_COMPUTER), undefined);
    assert.strictEqual(
      find(res, RADIOHEAD).mediaInfo?.status,
      MediaStatus.PENDING
    );
  });

  it('leaves out the album where MusicBrainz fails for an artist Lidarr lacks', async () => {
    source({
      held: false,
      musicBrainz: new Error('503'),
      searchArtists: artists(),
      searchAlbums: albums(),
    });
    await artistRequestOf(MediaRequestStatus.APPROVED);

    const res = await search();

    assert.strictEqual(find(res, OK_COMPUTER), undefined);
    assert.ok(find(res, RADIOHEAD));
  });

  it('asks no metadata for an album that no whole-artist request of its artist stands for', async () => {
    source({ searchArtists: artists(), searchAlbums: albums() });
    const row = await saveRow(
      OK_COMPUTER,
      MusicKind.ALBUM,
      MediaStatus.UNKNOWN,
      RADIOHEAD
    );
    await saveRequest(row, MediaRequestStatus.APPROVED);

    const res = await search();

    assert.strictEqual(
      find(res, OK_COMPUTER).mediaInfo?.status,
      MediaStatus.PROCESSING
    );
    assert.deepStrictEqual(metadataCalls, []);
  });

  it('leaves the mediaInfo of a movie and of a TV show as it was: the stored status, the keys they carried before the music columns', async () => {
    source({ searchArtists: artists(), searchAlbums: albums() });
    const repository = getRepository(Media);
    const movieRow = await repository.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 11,
        status: MediaStatus.PENDING,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    const tvRow = await repository.save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId: 22,
        status: MediaStatus.PARTIALLY_AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    // a music request in the same answers does not reach them
    const artistRow = await saveRow(RADIOHEAD, MusicKind.ARTIST);
    await saveRequest(artistRow, MediaRequestStatus.PENDING);

    const res = await search();

    const [movieAnswer, tvAnswer] = res.body.results;

    assert.strictEqual(movieAnswer.mediaType, 'movie');
    assert.strictEqual(movieAnswer.mediaInfo.id, movieRow.id);
    assert.strictEqual(movieAnswer.mediaInfo.status, MediaStatus.PENDING);
    assert.strictEqual(tvAnswer.mediaType, 'tv');
    assert.strictEqual(tvAnswer.mediaInfo.id, tvRow.id);
    assert.strictEqual(
      tvAnswer.mediaInfo.status,
      MediaStatus.PARTIALLY_AVAILABLE
    );

    for (const info of [movieAnswer.mediaInfo, tvAnswer.mediaInfo]) {
      assert.deepStrictEqual(
        Object.keys(info).filter((k) =>
          Media.musicSerializationFields.includes(k)
        ),
        [],
        'no music key on a movie or TV mediaInfo'
      );
    }
    assert.ok(
      find(res, RADIOHEAD).mediaInfo?.musicBrainzId === RADIOHEAD,
      'a music mediaInfo keeps its music keys'
    );
  });
});
