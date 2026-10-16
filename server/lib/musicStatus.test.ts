import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { getMusicBrainz } from '@server/api/musicbrainz';
import type { LidarrAlbum, LidarrArtist } from '@server/api/servarr/lidarr';
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
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import {
  burialUnderOtherProfile,
  burialUnderSavedProfile,
  listedAlbum,
  savedProfileAnswer,
} from '@server/test/musicProfiles';
import {
  MusicCoveringUndecidedError,
  getCoveringRequests,
  getMusicStatus,
  isStandingRequest,
  musicMediaInfo,
  musicStatusOf,
  resolveMusicItems,
} from './musicStatus';

const RADIOHEAD = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const OTHER_ARTIST = '7bc012a7-c5cc-4e7a-9ca6-15db02bbcde4';
const OK_COMPUTER = 'b1392450-e666-3926-a536-22c65f834433';
const KID_A = 'e75c0549-ad55-39e3-8025-c72c5d4a3c5d';
const AMNESIAC = '7e8e1f5e-6a4b-3e2a-8f0a-3b1b2c5f1d11';

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

setupTestDb();

let metadataCalls: string[];

// What the music metadata service lists for an artist: Lidarr's list where it
// holds the artist (`held`), else MusicBrainz's.
function listsAlbums({
  held,
  heldAlbums = [],
  musicBrainz = [],
  profile = 'saved',
}: {
  held?: boolean | Error;
  heldAlbums?: (string | LidarrAlbum)[] | Error;
  musicBrainz?: string[] | Error;
  // the saved metadata profile as Lidarr answers it
  profile?: 'saved' | 'lacking' | Error;
}) {
  mock.method(LidarrAPI.prototype, 'getArtists', async () => {
    metadataCalls.push('getArtists');

    if (held instanceof Error) {
      throw held;
    }

    return held
      ? ([
          { id: 7, foreignArtistId: RADIOHEAD, artistName: 'Radiohead' },
        ] as LidarrArtist[])
      : [];
  });
  mock.method(LidarrAPI.prototype, 'getAlbums', async () => {
    metadataCalls.push('getAlbums');

    if (heldAlbums instanceof Error) {
      throw heldAlbums;
    }

    return heldAlbums.map((entry) =>
      typeof entry === 'string' ? listedAlbum(entry) : entry
    );
  });
  mock.method(LidarrAPI.prototype, 'getMetadataProfile', async (id: number) => {
    metadataCalls.push('getMetadataProfile');

    return savedProfileAnswer(profile, id);
  });
  mock.method(getMusicBrainz(), 'getArtistAlbums', async () => {
    metadataCalls.push('musicbrainz');

    if (musicBrainz instanceof Error) {
      throw musicBrainz;
    }

    return musicBrainz.map((id) => ({ id, title: id }));
  });
}

beforeEach(() => {
  // Saving an approved music request makes the subscriber send it to Lidarr
  // after the save has returned, a send that outlives the test and writes into
  // the next test's reset database (its media row among them). These tests
  // read what covers an item, never what a send does, so none is made.
  mock.method(MediaRequestSubscriber.prototype, 'sendToLidarr', async () => {});
  metadataCalls = [];
  getSettings().lidarr = [{ ...server }];
  cacheManager.getCache('lidarr').flush();
});

afterEach(() => mock.restoreAll());

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
      type: MediaType.MUSIC,
      media,
      requestedBy: owner,
      modifiedBy: owner,
      status,
      is4k: false,
    })
  );
}

const album = (mbid = OK_COMPUTER, artistMbid = RADIOHEAD) => ({
  mbid,
  kind: MusicKind.ALBUM,
  artistMbid,
});
const artist = (mbid = RADIOHEAD) => ({ mbid, kind: MusicKind.ARTIST });

describe('a request stands', () => {
  it('while it is pending, approved or failed, and not once declined or completed', () => {
    const standing = (status: MediaRequestStatus) =>
      isStandingRequest({ status });

    assert.strictEqual(standing(MediaRequestStatus.PENDING), true);
    assert.strictEqual(standing(MediaRequestStatus.APPROVED), true);
    assert.strictEqual(standing(MediaRequestStatus.FAILED), true);
    assert.strictEqual(standing(MediaRequestStatus.DECLINED), false);
    assert.strictEqual(standing(MediaRequestStatus.COMPLETED), false);
  });
});

describe('the status of an album (R-6, D-362)', () => {
  it('is UNKNOWN with no row and no request, and asks no metadata', async () => {
    listsAlbums({});

    assert.strictEqual(await getMusicStatus(album()), MediaStatus.UNKNOWN);
    assert.deepStrictEqual(await getCoveringRequests(album()), []);
    assert.deepStrictEqual(metadataCalls, []);
  });

  it('is AVAILABLE as its row records it, whether or not a request covers it', async () => {
    const row = await saveRow(
      OK_COMPUTER,
      MusicKind.ALBUM,
      MediaStatus.AVAILABLE,
      RADIOHEAD
    );

    assert.strictEqual(await getMusicStatus(album()), MediaStatus.AVAILABLE);

    await saveRequest(row, MediaRequestStatus.PENDING);

    assert.strictEqual(await getMusicStatus(album()), MediaStatus.AVAILABLE);
  });

  it('is PENDING while a request of it is pending', async () => {
    const row = await saveRow(
      OK_COMPUTER,
      MusicKind.ALBUM,
      MediaStatus.UNKNOWN,
      RADIOHEAD
    );
    const request = await saveRequest(row, MediaRequestStatus.PENDING);

    assert.strictEqual(await getMusicStatus(album()), MediaStatus.PENDING);
    assert.deepStrictEqual(
      (await getCoveringRequests(album())).map((r) => r.id),
      [request.id]
    );
  });

  it('is PROCESSING while a request of it is approved, and while one is failed', async () => {
    const row = await saveRow(
      OK_COMPUTER,
      MusicKind.ALBUM,
      MediaStatus.UNKNOWN,
      RADIOHEAD
    );
    const request = await saveRequest(row, MediaRequestStatus.APPROVED);

    assert.strictEqual(await getMusicStatus(album()), MediaStatus.PROCESSING);

    request.status = MediaRequestStatus.FAILED;
    await getRepository(MediaRequest).save(request);

    assert.strictEqual(await getMusicStatus(album()), MediaStatus.PROCESSING);
    assert.strictEqual((await getCoveringRequests(album())).length, 1);
  });

  it('is PENDING where one covering request is pending and another approved', async () => {
    const row = await saveRow(
      OK_COMPUTER,
      MusicKind.ALBUM,
      MediaStatus.UNKNOWN,
      RADIOHEAD
    );
    await saveRequest(row, MediaRequestStatus.APPROVED);
    await saveRequest(row, MediaRequestStatus.PENDING);

    assert.strictEqual(await getMusicStatus(album()), MediaStatus.PENDING);
  });

  it('is not what its row stores of pending or processing: UNKNOWN with no standing request', async () => {
    const row = await saveRow(
      OK_COMPUTER,
      MusicKind.ALBUM,
      MediaStatus.PROCESSING,
      RADIOHEAD
    );

    assert.strictEqual(await getMusicStatus(album()), MediaStatus.UNKNOWN);

    row.status = MediaStatus.PENDING;
    await getRepository(Media).save(row);

    assert.strictEqual(await getMusicStatus(album()), MediaStatus.UNKNOWN);
  });

  it('is shown from the request that stands, whatever its row stores', async () => {
    const row = await saveRow(
      OK_COMPUTER,
      MusicKind.ALBUM,
      MediaStatus.PENDING,
      RADIOHEAD
    );
    await saveRequest(row, MediaRequestStatus.APPROVED);

    assert.strictEqual(await getMusicStatus(album()), MediaStatus.PROCESSING);
  });

  it('is covered by nothing a declined or a completed request says, and a deleted request is gone', async () => {
    const row = await saveRow(
      OK_COMPUTER,
      MusicKind.ALBUM,
      MediaStatus.UNKNOWN,
      RADIOHEAD
    );
    const declined = await saveRequest(row, MediaRequestStatus.DECLINED);
    await saveRequest(row, MediaRequestStatus.COMPLETED);

    assert.strictEqual(await getMusicStatus(album()), MediaStatus.UNKNOWN);
    assert.deepStrictEqual(await getCoveringRequests(album()), []);

    const pending = await saveRequest(row, MediaRequestStatus.PENDING);

    assert.strictEqual(await getMusicStatus(album()), MediaStatus.PENDING);

    await getRepository(MediaRequest).remove(pending);

    assert.strictEqual(await getMusicStatus(album()), MediaStatus.UNKNOWN);
    assert.ok(declined.id);
  });

  it('is not covered by a request of the artist row or of another kind with the same id', async () => {
    const artistRow = await saveRow(RADIOHEAD, MusicKind.ARTIST);
    const sameIdArtist = await saveRow(OK_COMPUTER, MusicKind.ARTIST);

    await saveRequest(sameIdArtist, MediaRequestStatus.PENDING);
    await saveRequest(artistRow, MediaRequestStatus.DECLINED);
    listsAlbums({ musicBrainz: [OK_COMPUTER] });

    assert.strictEqual(await getMusicStatus(album()), MediaStatus.UNKNOWN);
  });
});

describe('the status of an artist (R-6, D-362)', () => {
  it('is UNKNOWN with no row and no request', async () => {
    assert.strictEqual(await getMusicStatus(artist()), MediaStatus.UNKNOWN);
  });

  it('is AVAILABLE or PARTIALLY_AVAILABLE as its row records it, before any request', async () => {
    const row = await saveRow(
      RADIOHEAD,
      MusicKind.ARTIST,
      MediaStatus.PARTIALLY_AVAILABLE
    );
    await saveRequest(row, MediaRequestStatus.PENDING);

    assert.strictEqual(
      await getMusicStatus(artist()),
      MediaStatus.PARTIALLY_AVAILABLE
    );

    row.status = MediaStatus.AVAILABLE;
    await getRepository(Media).save(row);

    assert.strictEqual(await getMusicStatus(artist()), MediaStatus.AVAILABLE);
  });

  it('is PENDING, then PROCESSING, from its own whole-artist requests', async () => {
    const row = await saveRow(RADIOHEAD, MusicKind.ARTIST);
    const request = await saveRequest(row, MediaRequestStatus.PENDING);

    assert.strictEqual(await getMusicStatus(artist()), MediaStatus.PENDING);

    request.status = MediaRequestStatus.APPROVED;
    await getRepository(MediaRequest).save(request);

    assert.strictEqual(await getMusicStatus(artist()), MediaStatus.PROCESSING);

    request.status = MediaRequestStatus.FAILED;
    await getRepository(MediaRequest).save(request);

    assert.strictEqual(await getMusicStatus(artist()), MediaStatus.PROCESSING);

    request.status = MediaRequestStatus.DECLINED;
    await getRepository(MediaRequest).save(request);

    assert.strictEqual(await getMusicStatus(artist()), MediaStatus.UNKNOWN);
  });

  it('is not made requested by a request of one of its albums', async () => {
    const albumRow = await saveRow(
      OK_COMPUTER,
      MusicKind.ALBUM,
      MediaStatus.UNKNOWN,
      RADIOHEAD
    );
    await saveRow(RADIOHEAD, MusicKind.ARTIST);
    await saveRequest(albumRow, MediaRequestStatus.PENDING);

    assert.strictEqual(await getMusicStatus(artist()), MediaStatus.UNKNOWN);
    assert.deepStrictEqual(await getCoveringRequests(artist()), []);
  });

  it('is never undecided and asks no metadata', async () => {
    const row = await saveRow(RADIOHEAD, MusicKind.ARTIST);
    await saveRequest(row, MediaRequestStatus.PENDING);
    listsAlbums({ held: new Error('Lidarr is down') });

    const [resolved] = await resolveMusicItems([artist()]);

    assert.strictEqual(resolved.decided, true);
    assert.deepStrictEqual(metadataCalls, []);
  });
});

describe('an album covered by its artist’s whole-artist request (D-362)', () => {
  async function artistRequest(status = MediaRequestStatus.PENDING) {
    const row = await saveRow(RADIOHEAD, MusicKind.ARTIST);

    return saveRequest(row, status);
  }

  it('is covered where it is among the albums Lidarr lists for the artist it holds', async () => {
    const request = await artistRequest();
    listsAlbums({ held: true, heldAlbums: [OK_COMPUTER, KID_A] });

    assert.strictEqual(await getMusicStatus(album()), MediaStatus.PENDING);
    assert.deepStrictEqual(
      (await getCoveringRequests(album())).map((r) => r.id),
      [request.id]
    );
    assert.ok(!metadataCalls.includes('musicbrainz'));
  });

  it('is not covered where Lidarr, which holds the artist, does not list it, though MusicBrainz would', async () => {
    await artistRequest();
    listsAlbums({
      held: true,
      heldAlbums: [KID_A],
      musicBrainz: [OK_COMPUTER, KID_A],
    });

    assert.strictEqual(await getMusicStatus(album()), MediaStatus.UNKNOWN);
    assert.deepStrictEqual(await getCoveringRequests(album()), []);
  });

  it('is covered where it is among the release groups MusicBrainz lists for an artist Lidarr lacks', async () => {
    await artistRequest(MediaRequestStatus.APPROVED);
    listsAlbums({ held: false, musicBrainz: [KID_A, OK_COMPUTER] });

    assert.strictEqual(await getMusicStatus(album()), MediaStatus.PROCESSING);
    assert.ok(!metadataCalls.includes('getAlbums'));
  });

  it('is not covered where MusicBrainz does not list it', async () => {
    await artistRequest();
    listsAlbums({ held: false, musicBrainz: [KID_A] });

    assert.strictEqual(await getMusicStatus(album()), MediaStatus.UNKNOWN);
  });

  it('is covered by a failed whole-artist request and by none declined or completed', async () => {
    const request = await artistRequest(MediaRequestStatus.FAILED);
    listsAlbums({ held: true, heldAlbums: [OK_COMPUTER] });

    assert.strictEqual(await getMusicStatus(album()), MediaStatus.PROCESSING);

    request.status = MediaRequestStatus.DECLINED;
    await getRepository(MediaRequest).save(request);

    assert.strictEqual(await getMusicStatus(album()), MediaStatus.UNKNOWN);

    request.status = MediaRequestStatus.COMPLETED;
    await getRepository(MediaRequest).save(request);

    assert.strictEqual(await getMusicStatus(album()), MediaStatus.UNKNOWN);
  });

  it('shows PENDING where its own request is approved while its artist’s waits (R-6’s order)', async () => {
    await artistRequest(MediaRequestStatus.PENDING);
    const row = await saveRow(
      OK_COMPUTER,
      MusicKind.ALBUM,
      MediaStatus.UNKNOWN,
      RADIOHEAD
    );
    await saveRequest(row, MediaRequestStatus.APPROVED);
    listsAlbums({ held: true, heldAlbums: [OK_COMPUTER] });

    assert.strictEqual(await getMusicStatus(album()), MediaStatus.PENDING);
    assert.strictEqual((await getCoveringRequests(album())).length, 2);
  });

  it('is AVAILABLE as its row records it, whatever covers it', async () => {
    await artistRequest();
    await saveRow(
      OK_COMPUTER,
      MusicKind.ALBUM,
      MediaStatus.AVAILABLE,
      RADIOHEAD
    );
    listsAlbums({ held: true, heldAlbums: [OK_COMPUTER] });

    assert.strictEqual(await getMusicStatus(album()), MediaStatus.AVAILABLE);
  });

  it('takes the artist its row carries before the one its metadata gives', async () => {
    await artistRequest();
    await saveRow(
      OK_COMPUTER,
      MusicKind.ALBUM,
      MediaStatus.UNKNOWN,
      OTHER_ARTIST
    );
    listsAlbums({ held: true, heldAlbums: [OK_COMPUTER] });

    assert.strictEqual(await getMusicStatus(album()), MediaStatus.UNKNOWN);
    assert.deepStrictEqual(metadataCalls, []);
  });

  it('is covered by the request of the artist its metadata gives where it has no row', async () => {
    await artistRequest();
    listsAlbums({ held: true, heldAlbums: [OK_COMPUTER] });

    assert.strictEqual(
      await getMusicStatus(album(OK_COMPUTER, RADIOHEAD)),
      MediaStatus.PENDING
    );
    assert.strictEqual(
      await getMusicStatus(album(OK_COMPUTER, OTHER_ARTIST)),
      MediaStatus.UNKNOWN
    );
  });

  it('asks no metadata where no whole-artist request of its artist stands', async () => {
    const declined = await artistRequest(MediaRequestStatus.DECLINED);
    const row = await saveRow(
      OK_COMPUTER,
      MusicKind.ALBUM,
      MediaStatus.UNKNOWN,
      RADIOHEAD
    );
    await saveRequest(row, MediaRequestStatus.PENDING);
    listsAlbums({ held: true, heldAlbums: [OK_COMPUTER] });

    assert.strictEqual(await getMusicStatus(album()), MediaStatus.PENDING);
    assert.strictEqual(await getMusicStatus(album(KID_A)), MediaStatus.UNKNOWN);
    assert.deepStrictEqual(metadataCalls, []);
    assert.ok(declined.id);
  });

  it('reads an artist’s albums once for every album of the artist asked together', async () => {
    await artistRequest();
    listsAlbums({ held: true, heldAlbums: [OK_COMPUTER, KID_A] });

    const resolved = await resolveMusicItems([
      album(OK_COMPUTER),
      album(KID_A),
      album(AMNESIAC),
    ]);

    assert.deepStrictEqual(
      resolved.map((r) => r.decided && r.status),
      [MediaStatus.PENDING, MediaStatus.PENDING, MediaStatus.UNKNOWN]
    );
    assert.strictEqual(
      metadataCalls.filter((call) => call === 'getAlbums').length,
      1
    );
  });

  it('is covered without reading the artist’s albums where the artist’s page lists it', async () => {
    await artistRequest();
    listsAlbums({ held: new Error('down'), heldAlbums: new Error('down') });

    const [resolved] = await resolveMusicItems([
      { ...album(), listedUnderArtist: true },
    ]);

    assert.strictEqual(
      resolved.decided && resolved.status,
      MediaStatus.PENDING
    );
    assert.deepStrictEqual(metadataCalls, []);
  });
});

describe('the covering of an album is undecided (D-362, R-14)', () => {
  async function artistRequest() {
    const row = await saveRow(RADIOHEAD, MusicKind.ARTIST);

    return saveRequest(row, MediaRequestStatus.PENDING);
  }

  it('where a whole-artist request of its artist stands and Lidarr cannot list the albums of the artist it holds', async () => {
    await artistRequest();
    listsAlbums({ held: true, heldAlbums: new Error('Lidarr is down') });

    const [resolved] = await resolveMusicItems([album()]);

    assert.strictEqual(resolved.decided, false);
    await assert.rejects(
      getCoveringRequests(album()),
      MusicCoveringUndecidedError
    );
    await assert.rejects(getMusicStatus(album()), MusicCoveringUndecidedError);
  });

  it('where MusicBrainz cannot list the albums of an artist Lidarr lacks', async () => {
    await artistRequest();
    listsAlbums({ held: false, musicBrainz: new Error('503') });

    await assert.rejects(
      getCoveringRequests(album()),
      MusicCoveringUndecidedError
    );
  });

  it('where Lidarr cannot even list its artists and MusicBrainz fails', async () => {
    await artistRequest();
    listsAlbums({ held: new Error('down'), musicBrainz: new Error('503') });

    await assert.rejects(
      getCoveringRequests(album()),
      MusicCoveringUndecidedError
    );
  });

  it('where Lidarr cannot list its artists though MusicBrainz answers (F-1111): not decided against MusicBrainz', async () => {
    await artistRequest();
    listsAlbums({
      held: new Error('down'),
      musicBrainz: [OK_COMPUTER],
    });

    const [resolved] = await resolveMusicItems([album()]);

    assert.strictEqual(resolved.decided, false);
    await assert.rejects(
      getCoveringRequests(album()),
      MusicCoveringUndecidedError
    );
    await assert.rejects(getMusicStatus(album()), MusicCoveringUndecidedError);
    assert.ok(!metadataCalls.includes('musicbrainz'));
  });

  it('where there is no default Lidarr server', async () => {
    await artistRequest();
    getSettings().lidarr = [];

    await assert.rejects(
      getCoveringRequests(album()),
      MusicCoveringUndecidedError
    );
  });

  it('even where an own request of the album stands, and for that album alone', async () => {
    await artistRequest();
    const row = await saveRow(
      OK_COMPUTER,
      MusicKind.ALBUM,
      MediaStatus.UNKNOWN,
      RADIOHEAD
    );
    await saveRequest(row, MediaRequestStatus.PENDING);
    const otherRow = await saveRow(
      AMNESIAC,
      MusicKind.ALBUM,
      MediaStatus.UNKNOWN,
      OTHER_ARTIST
    );
    await saveRequest(otherRow, MediaRequestStatus.APPROVED);
    listsAlbums({ held: true, heldAlbums: new Error('Lidarr is down') });

    const resolved = await resolveMusicItems([
      album(),
      album(AMNESIAC, OTHER_ARTIST),
      album(KID_A, OTHER_ARTIST),
      artist(),
    ]);

    assert.deepStrictEqual(
      resolved.map((r) => r.decided),
      [false, true, true, true]
    );
    assert.deepStrictEqual(
      resolved.map((r) => r.decided && r.status),
      [false, MediaStatus.PROCESSING, MediaStatus.UNKNOWN, MediaStatus.PENDING]
    );
    assert.strictEqual(
      metadataCalls.filter((call) => call === 'getAlbums').length,
      1,
      'only the artist whose request stands is asked'
    );
  });

  it('is decided again once the albums can be read', async () => {
    await artistRequest();
    listsAlbums({ held: true, heldAlbums: new Error('Lidarr is down') });
    await assert.rejects(
      getCoveringRequests(album()),
      MusicCoveringUndecidedError
    );

    mock.restoreAll();
    listsAlbums({ held: true, heldAlbums: [OK_COMPUTER] });

    assert.strictEqual(await getMusicStatus(album()), MediaStatus.PENDING);
  });
});

describe('an album covered by its artist’s whole-artist request under the saved metadata profile (D-362)', () => {
  // S139's Burial: Lidarr lists 13 albums under a profile taking in EPs (2 Album,
  // 11 EP), 2 under the saved one; the artist's id stands as Radiohead's here
  const ALBUMS = [
    '2c28f0ee-bab8-30e1-94bb-399e1916d039',
    'fddedc4f-7a2e-3d7d-9ec5-1705c416f3f4',
  ];
  const EP = 'ed042ef7-bf76-3d86-a77e-7e0b9577581f';

  async function artistRequest(status = MediaRequestStatus.PENDING) {
    const row = await saveRow(RADIOHEAD, MusicKind.ARTIST);

    return saveRequest(row, status);
  }

  const resolveAll = (ids: string[]) =>
    resolveMusicItems(ids.map((id) => album(id)));

  it('covers the Albums Lidarr lists under a profile taking in EPs and not its EPs', async () => {
    await artistRequest();
    const listed = burialUnderOtherProfile();
    listsAlbums({ held: true, heldAlbums: listed });

    const resolutions = await resolveAll(listed.map((a) => a.foreignAlbumId));

    assert.strictEqual(resolutions.length, 13);
    resolutions.forEach((resolved, index) => {
      assert.ok(resolved.decided);

      const isAlbum = listed[index].albumType === 'Album';

      assert.strictEqual(
        resolved.status,
        isAlbum ? MediaStatus.PENDING : MediaStatus.UNKNOWN,
        listed[index].title
      );
      assert.strictEqual(resolved.requests.length, isAlbum ? 1 : 0);
    });
    assert.deepStrictEqual(
      resolutions
        .filter((r) => r.decided && r.requests.length > 0)
        .map((r) => r.item.mbid),
      ALBUMS
    );
  });

  it('covers the albums Lidarr lists under the saved profile, both', async () => {
    await artistRequest(MediaRequestStatus.FAILED);
    listsAlbums({ held: true, heldAlbums: burialUnderSavedProfile() });

    for (const id of ALBUMS) {
      assert.strictEqual(
        await getMusicStatus(album(id)),
        MediaStatus.PROCESSING
      );
    }
  });

  it('shows an EP its own request’s status and an Album the artist’s while an EP request of its own stands', async () => {
    await artistRequest(MediaRequestStatus.PENDING);
    await saveRequest(
      await saveRow(EP, MusicKind.ALBUM, MediaStatus.UNKNOWN, RADIOHEAD),
      MediaRequestStatus.FAILED
    );
    listsAlbums({ held: true, heldAlbums: burialUnderOtherProfile() });

    assert.strictEqual(await getMusicStatus(album(EP)), MediaStatus.PROCESSING);
    assert.strictEqual(
      await getMusicStatus(album(ALBUMS[0])),
      MediaStatus.PENDING
    );
  });

  it('does not cover an album an album add brought outside the profile, whatever its types (a Live album, an EP of another profile)', async () => {
    await artistRequest();
    const live = {
      ...listedAlbum('11111111-1111-4111-8111-111111111111'),
      secondaryTypes: ['Live'],
    } as unknown as LidarrAlbum;
    listsAlbums({
      held: true,
      heldAlbums: [listedAlbum(OK_COMPUTER), live, listedAlbum(KID_A, 'EP')],
    });

    assert.strictEqual(
      await getMusicStatus(album(OK_COMPUTER)),
      MediaStatus.PENDING
    );
    assert.strictEqual(
      await getMusicStatus(album(live.foreignAlbumId)),
      MediaStatus.UNKNOWN
    );
    assert.strictEqual(await getMusicStatus(album(KID_A)), MediaStatus.UNKNOWN);
  });

  it('reads the saved profile once for every album of the artist asked together, and not for an artist Lidarr lacks', async () => {
    await artistRequest();
    listsAlbums({ held: true, heldAlbums: burialUnderOtherProfile() });

    await resolveAll(burialUnderOtherProfile().map((a) => a.foreignAlbumId));

    assert.strictEqual(
      metadataCalls.filter((call) => call === 'getMetadataProfile').length,
      1
    );

    metadataCalls = [];
    cacheManager.getCache('lidarr').flush();
    mock.restoreAll();
    listsAlbums({ held: false, musicBrainz: [OK_COMPUTER] });

    await getMusicStatus(album());

    assert.ok(!metadataCalls.includes('getMetadataProfile'));
    assert.strictEqual(await getMusicStatus(album()), MediaStatus.PENDING);
  });

  it('is undecided where the saved profile cannot be read or is not among Lidarr’s, the artist’s albums listing', async () => {
    await artistRequest();

    for (const profile of [new Error('Lidarr is down'), 'lacking' as const]) {
      cacheManager.getCache('lidarr').flush();
      mock.restoreAll();
      listsAlbums({ held: true, heldAlbums: [OK_COMPUTER], profile });

      const [resolved] = await resolveMusicItems([album()]);

      assert.strictEqual(resolved.decided, false);
      await assert.rejects(
        getCoveringRequests(album()),
        MusicCoveringUndecidedError
      );
    }
  });

  it('asks neither the albums nor the profile where no whole-artist request of the artist stands, even with an own request of the album', async () => {
    await saveRequest(
      await saveRow(
        OK_COMPUTER,
        MusicKind.ALBUM,
        MediaStatus.UNKNOWN,
        RADIOHEAD
      ),
      MediaRequestStatus.PENDING
    );
    await artistRequest(MediaRequestStatus.DECLINED);
    listsAlbums({
      held: true,
      heldAlbums: new Error('Lidarr is down'),
      profile: 'lacking',
    });

    const [resolved] = await resolveMusicItems([album()]);

    assert.ok(resolved.decided);
    assert.strictEqual(resolved.status, MediaStatus.PENDING);
    assert.deepStrictEqual(metadataCalls, []);
  });

  it('is decided again once the saved profile can be read', async () => {
    await artistRequest();
    listsAlbums({ held: true, heldAlbums: [OK_COMPUTER], profile: 'lacking' });

    assert.strictEqual((await resolveMusicItems([album()]))[0].decided, false);

    mock.restoreAll();
    cacheManager.getCache('lidarr').flush();
    listsAlbums({ held: true, heldAlbums: [OK_COMPUTER] });

    assert.strictEqual(await getMusicStatus(album()), MediaStatus.PENDING);
  });
});

describe('musicStatusOf', () => {
  it('gives an album AVAILABLE only as its row records it, and an artist PARTIALLY_AVAILABLE only as its row records it', () => {
    assert.strictEqual(
      musicStatusOf(MusicKind.ALBUM, MediaStatus.PARTIALLY_AVAILABLE, []),
      MediaStatus.UNKNOWN
    );
    assert.strictEqual(
      musicStatusOf(MusicKind.ARTIST, MediaStatus.PARTIALLY_AVAILABLE, []),
      MediaStatus.PARTIALLY_AVAILABLE
    );
    assert.strictEqual(
      musicStatusOf(MusicKind.ALBUM, MediaStatus.AVAILABLE, []),
      MediaStatus.AVAILABLE
    );
  });

  it('ignores a request that does not stand', () => {
    assert.strictEqual(
      musicStatusOf(MusicKind.ALBUM, undefined, [
        { status: MediaRequestStatus.DECLINED },
        { status: MediaRequestStatus.COMPLETED },
      ]),
      MediaStatus.UNKNOWN
    );
  });
});

describe('musicMediaInfo', () => {
  it('puts the computed status in place of the row’s and keeps the row’s own requests', async () => {
    const row = await saveRow(
      OK_COMPUTER,
      MusicKind.ALBUM,
      MediaStatus.PROCESSING,
      RADIOHEAD
    );
    await saveRequest(row, MediaRequestStatus.PENDING);
    const loaded = await getRepository(Media).findOneOrFail({
      where: { id: row.id },
      relations: { requests: true },
    });
    const [resolved] = await resolveMusicItems([album()]);

    assert.ok(resolved.decided);

    const info = musicMediaInfo(resolved, loaded);

    assert.strictEqual(info?.status, MediaStatus.PENDING);
    assert.strictEqual(info?.id, row.id);
    assert.strictEqual(info?.musicBrainzId, OK_COMPUTER);
    assert.strictEqual(info?.requests.length, 1);
    assert.strictEqual(loaded.status, MediaStatus.PROCESSING, 'row untouched');
  });

  it('is none for an item with no row and no covering request', async () => {
    const [resolved] = await resolveMusicItems([album()]);

    assert.ok(resolved.decided);
    assert.strictEqual(musicMediaInfo(resolved, undefined), undefined);
  });

  it('is a mediaInfo with no id for an item with no row that a covering request gives a status', async () => {
    const row = await saveRow(RADIOHEAD, MusicKind.ARTIST);
    await saveRequest(row, MediaRequestStatus.APPROVED);
    listsAlbums({ held: true, heldAlbums: [OK_COMPUTER] });
    const [resolved] = await resolveMusicItems([album()]);

    assert.ok(resolved.decided);

    const info = JSON.parse(JSON.stringify(musicMediaInfo(resolved)));

    assert.deepStrictEqual(info, {
      mediaType: 'music',
      musicBrainzId: OK_COMPUTER,
      musicKind: 'album',
      artistMusicBrainzId: RADIOHEAD,
      status: MediaStatus.PROCESSING,
      status4k: MediaStatus.UNKNOWN,
      requests: [],
      // the download fields every Media carries
      downloadStatus: [],
      downloadStatus4k: [],
    });
  });
});
