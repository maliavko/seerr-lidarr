import type {
  LidarrAlbum,
  LidarrArtist,
  MetadataProfile,
} from '@server/api/servarr/lidarr';
import LidarrAPI from '@server/api/servarr/lidarr';
import { MediaStatus, MediaType, MusicKind } from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { lidarrScanner } from '@server/lib/scanners/lidarr';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import { rawMediaRows } from '@server/test/musicRows';
import { runWithMockTimers } from '@server/test/runWithMockTimers';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type { UpdateEvent } from 'typeorm';

// Lidarr's answers, recorded from the test Lidarr (lidarr-test, v3.1.0.4875)
// of ENVIRONMENT: its held artists, and the albums of Floating Points with
// all (Elaenia, 8 of 8), some (Cascade, 4 of 10) and none of their track files,
// and of Burial under a metadata profile that is the saved one and one that is
// not.
function fixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(join(__dirname, '../lidarr.fixtures', name), 'utf-8')
  );
}

// the metadata profiles of the test Lidarr; the saved one of the test Seerr is
// profile 1 'Standard' (primary type Album, secondary Studio, status Official)
const metadataProfiles: MetadataProfile[] = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '../../../api/servarr/lidarr.fixtures/metadataprofiles.json'
    ),
    'utf-8'
  )
);

const artists = fixture<LidarrArtist[]>('artists.json');
const floatingPoints = artists.find((a) => a.artistName === 'Floating Points')!;
const burial = artists.find((a) => a.artistName === 'Burial')!;
const caribou = artists.find((a) => a.artistName === 'Caribou')!;
const floatingPointsAlbums = fixture<LidarrAlbum[]>(
  'albums-floating-points-files.json'
);
const burialAlbumsOtherProfile = fixture<LidarrAlbum[]>(
  'albums-burial-metadata-profile-other.json'
);
const burialAlbumsSavedProfile = fixture<LidarrAlbum[]>(
  'albums-burial-metadata-profile-saved.json'
);

const elaenia = floatingPointsAlbums.find((a) => a.title === 'Elaenia')!;
const cascade = floatingPointsAlbums.find((a) => a.title === 'Cascade')!;
const crush = floatingPointsAlbums.find((a) => a.title === 'Crush')!;
const promises = floatingPointsAlbums.find((a) => a.title === 'Promises')!;

// the same album with its statistics as given
const withFiles = (
  album: LidarrAlbum,
  trackFileCount: number,
  totalTrackCount: number
): LidarrAlbum => ({
  ...album,
  statistics: { ...album.statistics!, trackFileCount, totalTrackCount },
});
const complete = (album: LidarrAlbum): LidarrAlbum =>
  withFiles(
    album,
    album.statistics!.totalTrackCount,
    album.statistics!.totalTrackCount
  );
const incomplete = (album: LidarrAlbum): LidarrAlbum =>
  withFiles(album, 0, album.statistics!.totalTrackCount);

// what the fake Lidarr answers
let artistsImpl: () => Promise<LidarrArtist[]>;
let albumsImpl: (artistId: number) => Promise<LidarrAlbum[]>;
let profileImpl: (id: number) => Promise<MetadataProfile>;
let getAlbumsCalls: number[];
let getArtistsCalls: number;
let getProfileCalls: number[];

setupTestDb();

beforeEach(() => {
  getArtistsCalls = 0;
  getAlbumsCalls = [];
  getProfileCalls = [];
  profileImpl = async (id) => {
    const profile = metadataProfiles.find((p) => p.id === id);
    if (!profile) {
      throw new Error(`[Lidarr] Failed to retrieve metadata profile: ${id}`);
    }
    return profile;
  };
  artistsImpl = async () => [];
  albumsImpl = async () => [];

  mock.method(LidarrAPI.prototype, 'getArtists', async () => {
    getArtistsCalls++;
    return artistsImpl();
  });
  mock.method(LidarrAPI.prototype, 'getMetadataProfile', async (id: number) => {
    getProfileCalls.push(id);
    return profileImpl(id);
  });
  mock.method(
    LidarrAPI.prototype,
    'getAlbums',
    async ({ artistId }: { artistId?: number } = {}) => {
      getAlbumsCalls.push(artistId!);
      return albumsImpl(artistId!);
    }
  );

  const settings = getSettings();
  settings.lidarr = [
    {
      id: 0,
      name: 'lidarr-test',
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
    },
  ];
});

afterEach(() => {
  mock.restoreAll();
});

const scan = () => runWithMockTimers(() => lidarrScanner.run());

// one held artist with the albums it is given
const hold = (artist: LidarrArtist, albums: LidarrAlbum[]) => {
  artistsImpl = async () => [artist];
  albumsImpl = async () => albums;
};

const row = (mbid: string, kind: MusicKind) =>
  getRepository(Media).findOneBy({ musicBrainzId: mbid, musicKind: kind });
const statusOf = async (mbid: string, kind: MusicKind) =>
  (await row(mbid, kind))?.status;
const albumStatus = (album: LidarrAlbum) =>
  statusOf(album.foreignAlbumId, MusicKind.ALBUM);
const artistStatus = (artist: LidarrArtist) =>
  statusOf(artist.foreignArtistId, MusicKind.ARTIST);

const saveRow = (
  mbid: string,
  kind: MusicKind,
  status: MediaStatus,
  artistMbid?: string
) =>
  getRepository(Media).save(
    new Media({
      mediaType: MediaType.MUSIC,
      musicBrainzId: mbid,
      musicKind: kind,
      artistMusicBrainzId: artistMbid,
      status,
      status4k: MediaStatus.UNKNOWN,
    })
  );

describe('Lidarr scan: the rows', () => {
  it('creates the row each held artist and album lacks as D-111 holds a music row, and none twice', async () => {
    hold(floatingPoints, floatingPointsAlbums);

    await scan();

    const repository = getRepository(Media);
    assert.strictEqual(
      await repository.count(),
      1 + floatingPointsAlbums.length
    );

    const artistRow = await row(
      floatingPoints.foreignArtistId,
      MusicKind.ARTIST
    );
    assert.ok(artistRow);
    assert.strictEqual(artistRow.mediaType, MediaType.MUSIC);
    assert.strictEqual(artistRow.artistMusicBrainzId, null);

    const albumRow = await row(elaenia.foreignAlbumId, MusicKind.ALBUM);
    assert.ok(albumRow);
    assert.strictEqual(albumRow.mediaType, MediaType.MUSIC);
    assert.strictEqual(
      albumRow.artistMusicBrainzId,
      floatingPoints.foreignArtistId
    );

    for (const media of await repository.find()) {
      assert.strictEqual(media.status4k, MediaStatus.UNKNOWN);
    }
    // every TMDB, TVDB, IMDb, service and media-server field stays null
    const raw = (await rawMediaRows(
      (await repository.find()).map((m) => m.id)
    )) as Record<string, unknown>[];
    for (const r of raw) {
      for (const column of [
        'tmdbId',
        'tvdbId',
        'imdbId',
        'serviceId',
        'serviceId4k',
        'externalServiceId',
        'externalServiceId4k',
        'externalServiceSlug',
        'externalServiceSlug4k',
        'ratingKey',
        'ratingKey4k',
        'jellyfinMediaId',
        'jellyfinMediaId4k',
      ]) {
        assert.strictEqual(r[column], null, column);
      }
    }

    await scan();

    assert.strictEqual(
      await repository.count(),
      1 + floatingPointsAlbums.length
    );
  });

  it('creates the rows an artist with no album and one with only unfinished albums lack, with nothing set', async () => {
    artistsImpl = async () => [caribou, burial];
    albumsImpl = async (artistId) =>
      artistId === burial.id ? burialAlbumsSavedProfile : [];

    await scan();

    assert.strictEqual(await artistStatus(caribou), MediaStatus.UNKNOWN);
    assert.strictEqual(await artistStatus(burial), MediaStatus.UNKNOWN);
    for (const album of burialAlbumsSavedProfile) {
      assert.strictEqual(await albumStatus(album), MediaStatus.UNKNOWN);
    }
  });

  it('uses a row a request created before the scan, and a row that is already there', async () => {
    const requested = await saveRow(
      cascade.foreignAlbumId,
      MusicKind.ALBUM,
      MediaStatus.PENDING,
      floatingPoints.foreignArtistId
    );
    hold(floatingPoints, floatingPointsAlbums);

    await scan();

    const repository = getRepository(Media);
    assert.strictEqual(
      await repository.countBy({ musicBrainzId: cascade.foreignAlbumId }),
      1
    );
    assert.strictEqual(
      (await repository.findOneByOrFail({ id: requested.id })).status,
      MediaStatus.PENDING
    );
  });

  it('reads one run the albums of every artist, afresh, and no row of an item Lidarr does not hold', async () => {
    const absent = await saveRow(
      'aaaaaaaa-0000-0000-0000-000000000000',
      MusicKind.ALBUM,
      MediaStatus.AVAILABLE,
      'bbbbbbbb-0000-0000-0000-000000000000'
    );
    const before = await rawMediaRows([absent.id]);
    artistsImpl = async () => [floatingPoints, burial];
    albumsImpl = async (artistId) =>
      artistId === burial.id ? burialAlbumsOtherProfile : floatingPointsAlbums;

    await scan();

    assert.strictEqual(getArtistsCalls, 1);
    assert.deepStrictEqual(getProfileCalls, [1], 'the saved profile, once');
    assert.deepStrictEqual(getAlbumsCalls.sort(), [
      floatingPoints.id,
      burial.id,
    ]);
    assert.deepStrictEqual(await rawMediaRows([absent.id]), before);
  });
});

describe('Lidarr scan: the albums', () => {
  it('sets an album with a file for each track AVAILABLE, and one with some or none of them, or with no track, not', async () => {
    const noTrack = withFiles(promises, 0, 0);
    const noStatistics: LidarrAlbum = {
      ...floatingPointsAlbums.find((a) => a.title === 'Mere Mortals')!,
      statistics: undefined,
    };
    hold(floatingPoints, [elaenia, cascade, crush, noTrack, noStatistics]);

    await scan();

    assert.strictEqual(await albumStatus(elaenia), MediaStatus.AVAILABLE);
    assert.strictEqual(await albumStatus(cascade), MediaStatus.UNKNOWN);
    assert.strictEqual(await albumStatus(crush), MediaStatus.UNKNOWN);
    assert.strictEqual(await albumStatus(noTrack), MediaStatus.UNKNOWN);
    assert.strictEqual(await albumStatus(noStatistics), MediaStatus.UNKNOWN);
  });

  it('counts a file more than the tracks as a file for each', async () => {
    const extra = withFiles(crush, 14, 13);
    hold(floatingPoints, [extra]);

    await scan();

    assert.strictEqual(await albumStatus(extra), MediaStatus.AVAILABLE);
  });

  it('keeps the status of an album that is not available, PENDING or PROCESSING among them, and sets none of its own', async () => {
    await saveRow(
      cascade.foreignAlbumId,
      MusicKind.ALBUM,
      MediaStatus.PENDING,
      floatingPoints.foreignArtistId
    );
    await saveRow(
      crush.foreignAlbumId,
      MusicKind.ALBUM,
      MediaStatus.PROCESSING,
      floatingPoints.foreignArtistId
    );
    hold(floatingPoints, [elaenia, cascade, crush, promises]);

    await scan();

    assert.strictEqual(await albumStatus(cascade), MediaStatus.PENDING);
    assert.strictEqual(await albumStatus(crush), MediaStatus.PROCESSING);
    assert.strictEqual(await albumStatus(promises), MediaStatus.UNKNOWN);
  });

  it('keeps an AVAILABLE album AVAILABLE where Lidarr later lacks its files or the album', async () => {
    hold(floatingPoints, [elaenia, crush]);
    await scan();
    assert.strictEqual(await albumStatus(elaenia), MediaStatus.AVAILABLE);

    // its files are gone
    hold(floatingPoints, [incomplete(elaenia), crush]);
    await scan();
    assert.strictEqual(await albumStatus(elaenia), MediaStatus.AVAILABLE);

    // the album is gone
    hold(floatingPoints, [crush]);
    await scan();
    assert.strictEqual(await albumStatus(elaenia), MediaStatus.AVAILABLE);
  });

  it('saves through the repository, so the subscriber sees a row go from UNKNOWN to AVAILABLE', async () => {
    const seen: [MediaStatus, MediaStatus][] = [];
    const spy = {
      listenTo: () => Media,
      afterUpdate: (event: UpdateEvent<Media>) => {
        seen.push([event.databaseEntity.status, event.entity!.status]);
      },
    };
    dataSource.subscribers.push(spy as never);
    try {
      hold(floatingPoints, [elaenia]);
      await scan();
    } finally {
      dataSource.subscribers.splice(
        dataSource.subscribers.indexOf(spy as never),
        1
      );
    }

    assert.ok(
      seen.some(
        ([from, to]) =>
          from === MediaStatus.UNKNOWN && to === MediaStatus.AVAILABLE
      ),
      JSON.stringify(seen)
    );
  });
});

describe('Lidarr scan: the artist', () => {
  it('sets an artist AVAILABLE where it has an album and every one is AVAILABLE', async () => {
    hold(floatingPoints, floatingPointsAlbums.map(complete));

    await scan();

    assert.strictEqual(
      await artistStatus(floatingPoints),
      MediaStatus.AVAILABLE
    );
  });

  it('sets an artist with some albums AVAILABLE and not all PARTIALLY_AVAILABLE', async () => {
    hold(floatingPoints, floatingPointsAlbums);

    await scan();

    assert.strictEqual(await albumStatus(elaenia), MediaStatus.AVAILABLE);
    assert.strictEqual(
      await artistStatus(floatingPoints),
      MediaStatus.PARTIALLY_AVAILABLE
    );
  });

  it('sets nothing on an artist none of whose albums is available, nor on one with no album', async () => {
    artistsImpl = async () => [floatingPoints, caribou];
    albumsImpl = async (artistId) =>
      artistId === floatingPoints.id
        ? floatingPointsAlbums.map(incomplete)
        : [];

    await scan();

    assert.strictEqual(await artistStatus(floatingPoints), MediaStatus.UNKNOWN);
    assert.strictEqual(await artistStatus(caribou), MediaStatus.UNKNOWN);
  });

  it('sets an AVAILABLE artist whose list gains an album not available PARTIALLY_AVAILABLE', async () => {
    const all = floatingPointsAlbums.map(complete);
    hold(floatingPoints, all);
    await scan();
    assert.strictEqual(
      await artistStatus(floatingPoints),
      MediaStatus.AVAILABLE
    );

    hold(floatingPoints, [...all, incomplete(burialAlbumsSavedProfile[0])]);
    await scan();

    assert.strictEqual(
      await artistStatus(floatingPoints),
      MediaStatus.PARTIALLY_AVAILABLE
    );
    // and available again once the new album is complete
    hold(floatingPoints, [...all, complete(burialAlbumsSavedProfile[0])]);
    await scan();
    assert.strictEqual(
      await artistStatus(floatingPoints),
      MediaStatus.AVAILABLE
    );
  });

  it('counts an AVAILABLE album that is now incomplete as available with its artist', async () => {
    const all = floatingPointsAlbums.map(complete);
    hold(floatingPoints, all);
    await scan();

    hold(floatingPoints, [incomplete(all[0]), ...all.slice(1)]);
    await scan();

    assert.strictEqual(await albumStatus(all[0]), MediaStatus.AVAILABLE);
    assert.strictEqual(
      await artistStatus(floatingPoints),
      MediaStatus.AVAILABLE
    );
  });

  it('keeps an AVAILABLE or PARTIALLY_AVAILABLE artist none of whose listed albums is available', async () => {
    const availableArtist = await saveRow(
      floatingPoints.foreignArtistId,
      MusicKind.ARTIST,
      MediaStatus.AVAILABLE
    );
    const partialArtist = await saveRow(
      burial.foreignArtistId,
      MusicKind.ARTIST,
      MediaStatus.PARTIALLY_AVAILABLE
    );
    artistsImpl = async () => [floatingPoints, burial];
    albumsImpl = async (artistId) =>
      artistId === floatingPoints.id
        ? floatingPointsAlbums.map(incomplete)
        : burialAlbumsSavedProfile;

    await scan();

    assert.strictEqual(
      (await getRepository(Media).findOneByOrFail({ id: availableArtist.id }))
        .status,
      MediaStatus.AVAILABLE
    );
    assert.strictEqual(
      (await getRepository(Media).findOneByOrFail({ id: partialArtist.id }))
        .status,
      MediaStatus.PARTIALLY_AVAILABLE
    );
  });

  it('keeps a PENDING or PROCESSING artist that is not available as it is', async () => {
    await saveRow(
      floatingPoints.foreignArtistId,
      MusicKind.ARTIST,
      MediaStatus.PROCESSING
    );
    await saveRow(
      burial.foreignArtistId,
      MusicKind.ARTIST,
      MediaStatus.PENDING
    );
    artistsImpl = async () => [floatingPoints, burial];
    albumsImpl = async (artistId) =>
      artistId === floatingPoints.id
        ? floatingPointsAlbums.map(incomplete)
        : burialAlbumsSavedProfile;

    await scan();

    assert.strictEqual(
      await artistStatus(floatingPoints),
      MediaStatus.PROCESSING
    );
    assert.strictEqual(await artistStatus(burial), MediaStatus.PENDING);
  });

  it('counts an artist on its albums under the saved metadata profile, those Lidarr lists under its own profile among them', async () => {
    // Lidarr lists a held artist's albums under the artist's own metadata
    // profile (the live check): Burial under a profile taking EPs in lists 13,
    // of which the saved profile takes in the 2 Lidarr lists once it is the
    // artist's profile
    hold(burial, burialAlbumsOtherProfile.map(complete));
    await scan();
    assert.strictEqual(await artistStatus(burial), MediaStatus.AVAILABLE);

    // the EPs lack files, the Albums have all: AVAILABLE, the EPs not counted
    hold(burial, [
      ...burialAlbumsSavedProfile.map(complete),
      ...burialAlbumsOtherProfile
        .filter((a) => a.albumType === 'EP')
        .map(incomplete),
    ]);
    await scan();
    assert.strictEqual(await artistStatus(burial), MediaStatus.AVAILABLE);

    // an EP complete beside Albums none of which is: nothing set on the artist
    const fresh = {
      ...burial,
      foreignArtistId: 'dddddddd-0000-0000-0000-000000000000',
    };
    hold(fresh, [
      ...burialAlbumsSavedProfile.map((a, i) =>
        incomplete({
          ...a,
          foreignAlbumId: `ffffffff-0000-0000-0000-00000000000${i}`,
        })
      ),
      complete(burialAlbumsOtherProfile.find((a) => a.albumType === 'EP')!),
    ]);
    await scan();
    assert.strictEqual(await artistStatus(fresh), MediaStatus.UNKNOWN);

    // one Album complete, one not: PARTIALLY_AVAILABLE
    hold(burial, [
      complete(burialAlbumsSavedProfile[0]),
      incomplete(burialAlbumsSavedProfile[1]),
      ...burialAlbumsOtherProfile
        .filter((a) => a.albumType === 'EP')
        .map(complete),
    ]);
    await getRepository(Media).update(
      { musicBrainzId: burialAlbumsSavedProfile[1].foreignAlbumId },
      { status: MediaStatus.UNKNOWN }
    );
    await scan();
    assert.strictEqual(
      await artistStatus(burial),
      MediaStatus.PARTIALLY_AVAILABLE
    );
  });

  it('gives every album outside the saved profile its row, and AVAILABLE once its track files are all held, an EP without them left as it was', async () => {
    const eps = burialAlbumsOtherProfile.filter((a) => a.albumType === 'EP');
    const [completeEp, incompleteEp, requestedEp, ...others] = eps;
    await saveRow(
      requestedEp.foreignAlbumId,
      MusicKind.ALBUM,
      MediaStatus.PROCESSING,
      burial.foreignArtistId
    );
    hold(burial, [
      ...burialAlbumsSavedProfile.map(complete),
      complete(completeEp),
      incomplete(incompleteEp),
      incomplete(requestedEp),
      ...others.map(incomplete),
    ]);

    await scan();

    const repository = getRepository(Media);
    assert.strictEqual(
      await repository.countBy({ artistMusicBrainzId: burial.foreignArtistId }),
      burialAlbumsOtherProfile.length,
      'a row for each of the 13 albums listed'
    );
    assert.strictEqual(await albumStatus(completeEp), MediaStatus.AVAILABLE);
    assert.strictEqual(await albumStatus(incompleteEp), MediaStatus.UNKNOWN);
    assert.strictEqual(await albumStatus(requestedEp), MediaStatus.PROCESSING);
    assert.strictEqual(await artistStatus(burial), MediaStatus.AVAILABLE);
  });

  it("counts an album outside the profile, listed beside the artist's others as an album add leaves it, neither for nor against the artist", async () => {
    const ep = burialAlbumsOtherProfile.find((a) => a.albumType === 'EP')!;
    hold(burial, [...burialAlbumsSavedProfile.map(complete), incomplete(ep)]);

    await scan();

    assert.strictEqual(await artistStatus(burial), MediaStatus.AVAILABLE);
    assert.strictEqual(await albumStatus(ep), MediaStatus.UNKNOWN);

    hold(burial, [...burialAlbumsSavedProfile.map(complete), complete(ep)]);
    await scan();
    assert.strictEqual(await albumStatus(ep), MediaStatus.AVAILABLE);
    assert.strictEqual(await artistStatus(burial), MediaStatus.AVAILABLE);
  });

  it('sets nothing on an artist whose listed albums are all outside the profile, and records its albums as every album is', async () => {
    const eps = burialAlbumsOtherProfile.filter((a) => a.albumType === 'EP');
    hold(burial, [complete(eps[0]), incomplete(eps[1])]);

    await scan();

    assert.strictEqual(await artistStatus(burial), MediaStatus.UNKNOWN);
    assert.strictEqual(await albumStatus(eps[0]), MediaStatus.AVAILABLE);
    assert.strictEqual(await albumStatus(eps[1]), MediaStatus.UNKNOWN);

    // an AVAILABLE or PARTIALLY_AVAILABLE artist keeps its status
    await getRepository(Media).update(
      { musicBrainzId: burial.foreignArtistId },
      { status: MediaStatus.PARTIALLY_AVAILABLE }
    );
    await scan();
    assert.strictEqual(
      await artistStatus(burial),
      MediaStatus.PARTIALLY_AVAILABLE
    );
  });

  it("reads an album against the saved profile's types, secondary types and release statuses", async () => {
    const album = burialAlbumsSavedProfile[0];
    const albums: [LidarrAlbum, boolean][] = [
      [album, true],
      [{ ...album, albumType: 'EP' }, false],
      [{ ...album, secondaryTypes: ['Live'] }, false],
      [{ ...album, secondaryTypes: ['Studio'] }, true],
      [
        { ...album, releases: [{ ...album.releases![0], status: 'Bootleg' }] },
        false,
      ],
    ];
    // each alone with an incomplete Album beside it: the artist is AVAILABLE
    // only where the one under test is not counted or is complete
    for (const [entry, counted] of albums) {
      const artist = { ...burial, id: 99 };
      hold(artist, [
        complete({
          ...entry,
          foreignAlbumId: 'eeeeeeee-0000-0000-0000-000000000001',
        }),
        incomplete({
          ...album,
          foreignAlbumId: 'eeeeeeee-0000-0000-0000-000000000002',
        }),
      ]);
      await getRepository(Media).clear();
      await scan();
      assert.strictEqual(
        await artistStatus(artist),
        counted ? MediaStatus.PARTIALLY_AVAILABLE : MediaStatus.UNKNOWN,
        `${entry.albumType} ${entry.secondaryTypes}`
      );
    }
  });
});

describe('Lidarr scan: failures', () => {
  it('does nothing and throws nothing with no default Lidarr server', async () => {
    getSettings().lidarr = getSettings().lidarr.map((s) => ({
      ...s,
      isDefault: false,
    }));
    hold(floatingPoints, floatingPointsAlbums);

    await scan();

    assert.strictEqual(getArtistsCalls, 0);
    assert.strictEqual(await getRepository(Media).count(), 0);
    assert.strictEqual(lidarrScanner.status().running, false);
  });

  it('reads the default Lidarr server only', async () => {
    const urls: string[] = [];
    mock.restoreAll();
    mock.method(
      LidarrAPI,
      'buildUrl',
      (server: { hostname: string; port: number }) => {
        urls.push(`${server.hostname}:${server.port}`);
        return `http://${server.hostname}:${server.port}/api/v1`;
      }
    );
    mock.method(LidarrAPI.prototype, 'getArtists', async () => []);
    mock.method(
      LidarrAPI.prototype,
      'getMetadataProfile',
      async () => metadataProfiles[0]
    );
    getSettings().lidarr = [
      {
        ...getSettings().lidarr[0],
        id: 1,
        hostname: 'other.example',
        port: 1,
        isDefault: false,
      },
      getSettings().lidarr[0],
    ];

    await scan();

    assert.deepStrictEqual(urls, ['127.0.0.1:18686']);
  });

  it('changes nothing and throws nothing where Lidarr fails on the artists list', async () => {
    const existing = await saveRow(
      floatingPoints.foreignArtistId,
      MusicKind.ARTIST,
      MediaStatus.PROCESSING
    );
    const before = await rawMediaRows([existing.id]);
    artistsImpl = async () => {
      throw new Error('[Lidarr] Failed to retrieve artists: timeout');
    };

    await scan();

    assert.strictEqual(await getRepository(Media).count(), 1);
    assert.deepStrictEqual(await rawMediaRows([existing.id]), before);
    assert.strictEqual(lidarrScanner.status().running, false);
  });

  it('changes nothing and throws nothing where Lidarr fails on the metadata profiles or lacks the saved one', async () => {
    const existing = await saveRow(
      floatingPoints.foreignArtistId,
      MusicKind.ARTIST,
      MediaStatus.PROCESSING
    );
    const before = await rawMediaRows([existing.id]);
    hold(floatingPoints, floatingPointsAlbums.map(complete));

    for (const impl of [
      async () => {
        throw new Error('[Lidarr] Failed to retrieve metadata profile: 500');
      },
      async () => {
        throw new Error(
          '[Lidarr] Failed to retrieve metadata profile: no metadata profile 1'
        );
      },
    ]) {
      profileImpl = impl;
      await scan();

      assert.strictEqual(await getRepository(Media).count(), 1);
      assert.deepStrictEqual(await rawMediaRows([existing.id]), before);
      assert.deepStrictEqual(getAlbumsCalls, []);
      assert.strictEqual(lidarrScanner.status().running, false);
    }
  });

  it('leaves the rows of an artist whose albums fail as they were, and goes on with the next', async () => {
    const heldRow = await saveRow(
      floatingPoints.foreignArtistId,
      MusicKind.ARTIST,
      MediaStatus.AVAILABLE
    );
    const before = await rawMediaRows([heldRow.id]);
    artistsImpl = async () => [floatingPoints, caribou, burial];
    albumsImpl = async (artistId) => {
      if (artistId === floatingPoints.id || artistId === caribou.id) {
        throw new Error('[Lidarr] Failed to retrieve albums: 500');
      }
      return burialAlbumsSavedProfile.map(complete);
    };

    await scan();

    assert.deepStrictEqual(await rawMediaRows([heldRow.id]), before);
    assert.strictEqual(await albumStatus(elaenia), undefined);
    assert.strictEqual(
      await row(caribou.foreignArtistId, MusicKind.ARTIST),
      null,
      'no row is created for an artist whose albums fail'
    );
    assert.strictEqual(await artistStatus(burial), MediaStatus.AVAILABLE);
    assert.strictEqual(
      await albumStatus(burialAlbumsSavedProfile[0]),
      MediaStatus.AVAILABLE
    );
  });

  it('ends the run after the artists being scanned on a cancel', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      ...floatingPoints,
      id: 100 + i,
      foreignArtistId: `00000000-0000-0000-0000-0000000000${(10 + i).toString()}`,
      artistName: `Artist ${i}`,
    }));
    artistsImpl = async () => many;
    albumsImpl = async (artistId) => {
      lidarrScanner.cancel();
      return [
        {
          ...elaenia,
          foreignAlbumId: `11111111-0000-0000-0000-0000000000${artistId}`,
        },
      ];
    };

    await scan();

    // the first bundle of artists was scanned to its end, the next not begun
    assert.strictEqual(
      await artistStatus(many[0]),
      MediaStatus.AVAILABLE,
      'the artist being scanned is scanned'
    );
    assert.strictEqual(
      await row(many[11].foreignArtistId, MusicKind.ARTIST),
      null
    );
    assert.strictEqual(lidarrScanner.status().running, false);
  });
});

describe('Lidarr scan: movies and TV', () => {
  it('reads and writes no movie or TV row', async () => {
    const repository = getRepository(Media);
    const movie = await repository.save(
      new Media({
        tmdbId: 550,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.PROCESSING,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    const show = await repository.save(
      new Media({
        tmdbId: 1399,
        tvdbId: 121361,
        mediaType: MediaType.TV,
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    const before = await rawMediaRows([movie.id, show.id]);
    hold(floatingPoints, floatingPointsAlbums.map(complete));

    await scan();

    assert.deepStrictEqual(await rawMediaRows([movie.id, show.id]), before);
    assert.strictEqual(
      await artistStatus(floatingPoints),
      MediaStatus.AVAILABLE
    );
  });
});
