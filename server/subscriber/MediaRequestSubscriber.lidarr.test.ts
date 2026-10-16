import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type {
  LidarrAlbum,
  LidarrArtist,
  LidarrCommand,
  MetadataProfile,
} from '@server/api/servarr/lidarr';
import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
  MusicKind,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';
import {
  lidarrSendTimings,
  lidarrSendsEnded,
} from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import { MethodStubs } from '@server/test/musicRows';

// The sending of an approved music request to Lidarr (D-352, R-7, R-46, R-9,
// R-11, R-14): every branch, the retried album branch after an add Lidarr
// took, the waits on Lidarr's command queue, the check, the sends of one artist
// one at a time, and every failure, against a Lidarr that answers what the test
// Lidarr (v3.1.0.4875) answered, kept as the JSON fixtures of LidarrAPI's tests.
// The calls and their bodies are read on the wire, at a fake Lidarr. The send
// goes on after the save of its request has returned, so each helper below
// that saves a request waits for the sends to end.

// the waits as D-352 sets them, before the tests shorten them
const defaultTimings = { ...lidarrSendTimings };

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

const RADIOHEAD = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const OK_COMPUTER = 'b1392450-e666-3926-a536-22c65f834433';
const NOT_LISTED = '7b39ccb5-b49c-37e1-80ec-5ac0b2a89fe4';

// Lidarr's ids in the fixtures: the held Radiohead is 3, OK Computer
// 27, its nine albums 19 to 27
const HELD_ID = 3;
const OK_COMPUTER_ID = 27;
const ALBUM_IDS = [19, 20, 21, 22, 23, 24, 25, 26, 27];

interface Call {
  // when the fake Lidarr took the call, in ms
  at: number;
  method: string;
  path: string;
  query: string;
  body?: unknown;
}

type Answer = { status: number; body?: unknown } | 'drop' | 'hang';

interface Scenario {
  // Lidarr holds the artist: the artist as it answers GET /artist
  held?: LidarrArtist;
  // what answers an artist add
  artistAdd?: unknown;
  // overrides of the answer to a call, by 'METHOD /path'
  answers?: Record<string, Answer>;
  // the album the album lookup answers
  albumLookup?: LidarrAlbum[];
  // the albums Lidarr lists for the held artist
  albums?: LidarrAlbum[];
  // the metadata profiles Lidarr answers
  profiles?: unknown;
  // Lidarr's command queue, as it answers each read in turn (the last answer
  // is repeated); settled where not given
  queue?: LidarrCommand[][];
  // Lidarr's ids of albums it answers unmonitored until set monitored
  unmonitored?: number[];
  // Lidarr's ids of albums it answers unmonitored whatever is set
  stuck?: number[];
  // the first setting of albums monitored does not hold (Lidarr's refresh
  // applies the add's option after it)
  dropFirstSetting?: boolean;
  // once the artist is added, Lidarr lists it as held
  addedHeld?: boolean;
}

let server: Server;
let calls: Call[] = [];
let scenario: Scenario = {};
// the artist has been added through the fake Lidarr: its album lookups then
// answer the artist with Lidarr's id, as the test Lidarr does
let artistAdded = false;
// the sockets a hanging call holds open
const hanging: ServerResponse[] = [];
// what the fake Lidarr keeps: the albums set monitored, the settings so far,
// the album added, the reads of the command queue, and the call held at a gate
let setMonitored = new Set<number>();
let settings = 0;
let albumAdded = false;
let queueReads = 0;
let gate: { key: string; open: Promise<void>; taken: boolean } | undefined;

const heldArtist = (overrides: Partial<LidarrArtist> = {}): LidarrArtist => ({
  ...fixture<LidarrArtist[]>('artists')[0],
  ...overrides,
});

function answerFor(
  method: string,
  path: string,
  term: string | null,
  body?: Record<string, unknown>
): Answer | undefined {
  if (method === 'GET' && path === '/artist') {
    const held =
      scenario.held ??
      (scenario.addedHeld && artistAdded ? heldArtist() : undefined);

    return { status: 200, body: held ? [held] : [] };
  }
  if (method === 'GET' && path === '/artist/lookup') {
    const [radiohead] = fixture<LidarrArtist[]>('artist-lookup-mbid');

    // any artist asked for by its MusicBrainz id is found, as Radiohead is
    return {
      status: 200,
      body: term?.startsWith('lidarr:')
        ? [
            {
              ...radiohead,
              foreignArtistId: term.slice('lidarr:'.length),
              artistName: term.endsWith(RADIOHEAD)
                ? radiohead.artistName
                : 'Another artist',
            },
          ]
        : fixture('artist-lookup-unknown-mbid'),
    };
  }
  if (method === 'GET' && path === '/album/lookup') {
    const lookup =
      scenario.albumLookup ?? fixture<LidarrAlbum[]>('album-lookup-mbid');

    if (scenario.held || artistAdded) {
      return { status: 200, body: lookup };
    }

    // the artist is not in Lidarr: the lookup's artist has no Lidarr id
    return {
      status: 200,
      body: lookup.map((album) => ({
        ...album,
        artistId: 0,
        artist: { ...album.artist, id: undefined },
      })),
    };
  }
  if (method === 'GET' && path === '/album') {
    const listed = scenario.albums ?? fixture<LidarrAlbum[]>('albums');
    const added = fixture<LidarrAlbum>('album-add');
    const albums =
      albumAdded && !listed.some((a) => a.id === added.id)
        ? [...listed, added]
        : listed;

    return {
      status: 200,
      body: albums.map((album) => ({
        ...album,
        monitored:
          !scenario.stuck?.includes(album.id as number) &&
          (setMonitored.has(album.id as number) ||
            (album.monitored &&
              !scenario.unmonitored?.includes(album.id as number))),
      })),
    };
  }
  if (method === 'GET' && path === '/command') {
    const queue = scenario.queue ?? [
      fixture<LidarrCommand[]>('command-queue-settled'),
    ];
    const answer = queue[Math.min(queueReads, queue.length - 1)];

    queueReads += 1;

    return { status: 200, body: answer };
  }
  if (method === 'GET' && path === '/metadataprofile') {
    return {
      status: 200,
      body: scenario.profiles ?? fixture('metadataprofiles'),
    };
  }
  if (method === 'GET' && path === `/artist/${HELD_ID}`) {
    return { status: 200, body: fixture('artist-by-id') };
  }
  if (method === 'POST' && path === '/artist') {
    return {
      status: 201,
      body: scenario.artistAdd ?? fixture('artist-add-existing'),
    };
  }
  if (method === 'PUT' && path === `/artist/${HELD_ID}`) {
    return { status: 202, body: fixture('artist-update') };
  }
  if (method === 'PUT' && path === '/album/monitor') {
    settings += 1;
    if (!(scenario.dropFirstSetting && settings === 1)) {
      for (const id of (body?.albumIds as number[] | undefined) ?? []) {
        setMonitored.add(id);
      }
    }

    return { status: 202, body: fixture('album-monitor') };
  }
  if (method === 'POST' && path === '/album') {
    // Lidarr refuses an album whose artist it does not hold (400)
    const artist = body?.artist as { id?: number } | undefined;

    albumAdded = Boolean(artist?.id);

    return artist?.id
      ? { status: 201, body: fixture('album-add') }
      : { status: 400, body: fixture('error-add-400') };
  }
  if (method === 'POST' && path === '/command') {
    return { status: 201, body: fixture('command-albumsearch') };
  }

  return undefined;
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];

  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = req.method ?? 'GET';
    const raw = Buffer.concat(chunks).toString('utf8');
    url.searchParams.delete('apikey');
    const call: Call = {
      at: Date.now(),
      method,
      path,
      query: decodeURIComponent(url.search),
    };

    if (raw) {
      call.body = JSON.parse(raw);
    }
    calls.push(call);

    const answer =
      scenario.answers?.[`${method} ${path}`] ??
      answerFor(
        method,
        path,
        url.searchParams.get('term'),
        call.body as Record<string, unknown> | undefined
      );

    if (method === 'POST' && path === '/artist') {
      artistAdded = true;
    }

    const respond = (): void => {
      if (answer === 'drop') {
        // Lidarr took the call and the answer never reached Seerr
        req.socket.destroy();
        return;
      }
      if (answer === 'hang') {
        hanging.push(res);
        return;
      }

      const found = answer ?? { status: 404, body: { message: 'NotFound' } };
      res.writeHead(found.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(found.body ?? {}));
    };

    if (gate && !gate.taken && gate.key === `${method} ${path}`) {
      // the first such call waits until the test lets it go
      gate.taken = true;
      void gate.open.then(respond);
      return;
    }
    respond();
  });
}

// every call, and the calls but the reads of Lidarr's command queue (which
// the tests of the waits read apart)
const allLines = (): string[] =>
  calls.map((c) => `${c.method} ${c.path}${c.query}`);
const lines = (): string[] =>
  calls
    .filter((c) => !(c.method === 'GET' && c.path === '/command'))
    .map((c) => `${c.method} ${c.path}${c.query}`);
const callTo = (method: string, path: string): Call | undefined =>
  calls.find((c) => c.method === method && c.path === path);

function configureLidarr(port: number, isDefault = true): void {
  getSettings().lidarr = [
    {
      id: 1,
      name: 'Test Lidarr',
      hostname: '127.0.0.1',
      port,
      apiKey: 'test-key',
      useSsl: false,
      baseUrl: '',
      activeProfileId: 3,
      activeProfileName: 'Standard',
      activeMetadataProfileId: 1,
      activeMetadataProfileName: 'Standard',
      activeDirectory: '/music',
      isDefault,
    },
  ];
}

interface Seeded {
  media: Media;
  request: MediaRequest;
}

// A music request of an album or of the artist, with its media row, in the
// given status; an approved one is sent as it is inserted (auto-approval).
async function seedRequest(
  kind: MusicKind,
  status: MediaRequestStatus,
  {
    withArtistId = true,
    albumMbid = OK_COMPUTER,
    artistMbid = RADIOHEAD,
    sent = true,
  }: {
    withArtistId?: boolean;
    albumMbid?: string;
    artistMbid?: string;
    // wait for the sends to end before answering (not where the test holds one)
    sent?: boolean;
  } = {}
): Promise<Seeded> {
  const requestedBy = await getRepository(User).findOneOrFail({
    where: { email: 'admin@seerr.dev' },
  });
  const media = await getRepository(Media).save(
    new Media({
      mediaType: MediaType.MUSIC,
      musicBrainzId: kind === MusicKind.ALBUM ? albumMbid : artistMbid,
      musicKind: kind,
      artistMusicBrainzId:
        kind === MusicKind.ALBUM && withArtistId ? artistMbid : null,
      status: MediaStatus.PENDING,
      status4k: MediaStatus.UNKNOWN,
    })
  );
  const request = await getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.MUSIC,
      status,
      media,
      requestedBy,
      modifiedBy:
        status === MediaRequestStatus.PENDING ? undefined : requestedBy,
      is4k: false,
    })
  );

  if (sent) {
    await lidarrSendsEnded();
  }

  return { media, request };
}

// the request, approved by a user who manages requests, as the approve route
// does: the saved status change sends it
async function approve(
  seeded: Seeded,
  { sent = true }: { sent?: boolean } = {}
): Promise<void> {
  const request = await getRepository(MediaRequest).findOneOrFail({
    where: { id: seeded.request.id },
    relations: { media: true, requestedBy: true },
  });

  request.status = MediaRequestStatus.APPROVED;
  await getRepository(MediaRequest).save(request);

  if (sent) {
    await lidarrSendsEnded();
  }
}

const persistedStatus = async (seeded: Seeded): Promise<MediaRequestStatus> =>
  (
    await getRepository(MediaRequest).findOneOrFail({
      where: { id: seeded.request.id },
    })
  ).status;

const persistedMediaStatus = async (seeded: Seeded): Promise<MediaStatus> =>
  (
    await getRepository(Media).findOneOrFail({
      where: { id: seeded.media.id },
    })
  ).status;

setupTestDb();

beforeEach(async () => {
  calls = [];
  scenario = {};
  artistAdded = false;
  setMonitored = new Set();
  settings = 0;
  albumAdded = false;
  queueReads = 0;
  gate = undefined;
  lidarrSendTimings.pollMs = 10;
  lidarrSendTimings.boundMs = 500;
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  configureLidarr((server.address() as AddressInfo).port);
  getSettings().radarr = [];
  getSettings().sonarr = [];
});

afterEach(async () => {
  await lidarrSendsEnded();
  for (const res of hanging.splice(0)) {
    res.destroy();
  }
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  getSettings().lidarr = [];
  getSettings().network.apiRequestTimeout = 10000;
});

const forAlbumAbsent = {
  foreignArtistId: RADIOHEAD,
  artistName: 'Radiohead',
  qualityProfileId: 3,
  metadataProfileId: 1,
  rootFolderPath: '/music',
  monitored: true,
  monitorNewItems: 'none',
  addOptions: {
    monitor: 'existing',
    albumsToMonitor: [OK_COMPUTER],
    searchForMissingAlbums: true,
  },
};

// an album inside the profile, its artist absent: nothing after the one add
const absentLines = [
  'GET /artist',
  `GET /album/lookup?term=lidarr:${OK_COMPUTER}`,
  'GET /metadataprofile',
  `GET /artist/lookup?term=lidarr:${RADIOHEAD}`,
  'POST /artist',
];

// the request of the EP outside the saved profile
async function seedNotListed(status: MediaRequestStatus): Promise<Seeded> {
  scenario.albumLookup = fixture<LidarrAlbum[]>('album-lookup-not-listed');
  const seeded = await seedRequest(MusicKind.ALBUM, MediaRequestStatus.PENDING);

  await getRepository(Media).update(seeded.media.id, {
    musicBrainzId: NOT_LISTED,
  });
  if (status === MediaRequestStatus.APPROVED) {
    await approve(seeded);
  }

  return seeded;
}

const albumAddBody = {
  ...fixture<LidarrAlbum[]>('album-lookup-not-listed')[0],
  monitored: true,
  addOptions: { addType: 'manual', searchForNewAlbum: false },
};
// the id Lidarr answers for the album it added (fixture album-add)
const ADDED_ALBUM_ID = 61;

describe('an album request whose artist Lidarr lacks (R-7, D-352)', () => {
  it('adds the artist in one call, monitored, with only the album to monitor, and calls nothing after it', async () => {
    const seeded = await seedRequest(
      MusicKind.ALBUM,
      MediaRequestStatus.APPROVED
    );

    assert.deepStrictEqual(lines(), absentLines);
    assert.deepStrictEqual(callTo('POST', '/artist')?.body, forAlbumAbsent);
    assert.strictEqual(
      calls.filter((c) => c.method === 'PUT').length,
      0,
      'no PUT of the artist follows the add'
    );
    assert.strictEqual(
      await persistedStatus(seeded),
      MediaRequestStatus.APPROVED
    );
    assert.strictEqual(
      await persistedMediaStatus(seeded),
      MediaStatus.PROCESSING
    );
  });

  it('sends it at once on auto-approval and on the approval of a pending request alike', async () => {
    const seeded = await seedRequest(
      MusicKind.ALBUM,
      MediaRequestStatus.PENDING
    );

    assert.deepStrictEqual(lines(), [], 'a pending request sends nothing');
    assert.strictEqual(await persistedMediaStatus(seeded), MediaStatus.PENDING);

    await approve(seeded);

    assert.deepStrictEqual(callTo('POST', '/artist')?.body, forAlbumAbsent);
    assert.strictEqual(
      await persistedStatus(seeded),
      MediaRequestStatus.APPROVED
    );
    assert.strictEqual(
      await persistedMediaStatus(seeded),
      MediaStatus.PROCESSING
    );
  });

  it('reads the artist of the album from Lidarr where the row has none', async () => {
    scenario.albumLookup = fixture<LidarrAlbum[]>('album-lookup-mbid');
    const seeded = await seedRequest(
      MusicKind.ALBUM,
      MediaRequestStatus.APPROVED,
      { withArtistId: false }
    );

    assert.deepStrictEqual(lines(), [
      `GET /album/lookup?term=lidarr:${OK_COMPUTER}`,
      'GET /artist',
      'GET /metadataprofile',
      `GET /artist/lookup?term=lidarr:${RADIOHEAD}`,
      'POST /artist',
    ]);
    assert.deepStrictEqual(callTo('POST', '/artist')?.body, forAlbumAbsent);
    assert.strictEqual(
      await persistedMediaStatus(seeded),
      MediaStatus.PROCESSING
    );
  });
});

describe('an album request whose artist Lidarr holds (R-7, D-352)', () => {
  it('leaves the artist as it is, monitors the album and starts its search', async () => {
    scenario.held = heldArtist();
    const seeded = await seedRequest(
      MusicKind.ALBUM,
      MediaRequestStatus.APPROVED
    );

    assert.deepStrictEqual(lines(), [
      'GET /artist',
      `GET /album?artistId=${HELD_ID}`,
      'PUT /album/monitor',
      'POST /command',
      `GET /album?artistId=${HELD_ID}`,
    ]);
    assert.deepStrictEqual(callTo('PUT', '/album/monitor')?.body, {
      albumIds: [OK_COMPUTER_ID],
      monitored: true,
    });
    assert.deepStrictEqual(
      {
        name: (callTo('POST', '/command')?.body as { name: string }).name,
        albumIds: (callTo('POST', '/command')?.body as { albumIds: number[] })
          .albumIds,
      },
      { name: 'AlbumSearch', albumIds: [OK_COMPUTER_ID] }
    );
    assert.strictEqual(
      await persistedMediaStatus(seeded),
      MediaStatus.PROCESSING
    );
  });

  it('leaves an unmonitored artist unmonitored (its own flag stays)', async () => {
    scenario.held = heldArtist({ monitored: false });
    await seedRequest(MusicKind.ALBUM, MediaRequestStatus.APPROVED);

    assert.strictEqual(
      calls.filter((c) => c.path.startsWith('/artist') && c.method !== 'GET')
        .length,
      0
    );
  });

  it("adds an album Lidarr does not list for the artist by Lidarr's album add, monitored, addType manual, no search on add, then starts AlbumSearch for the id Lidarr answers", async () => {
    scenario.held = heldArtist();
    const seeded = await seedNotListed(MediaRequestStatus.APPROVED);

    assert.deepStrictEqual(lines(), [
      'GET /artist',
      `GET /album?artistId=${HELD_ID}`,
      `GET /album/lookup?term=lidarr:${NOT_LISTED}`,
      'POST /album',
      'POST /command',
      `GET /album?artistId=${HELD_ID}`,
    ]);
    assert.deepStrictEqual(callTo('POST', '/album')?.body, albumAddBody);
    const command = callTo('POST', '/command')?.body as {
      name: string;
      albumIds: number[];
    };
    assert.strictEqual(command.name, 'AlbumSearch');
    assert.deepStrictEqual(command.albumIds, [ADDED_ALBUM_ID]);
    assert.strictEqual(
      calls.filter((c) => c.path.startsWith('/artist') && c.method !== 'GET')
        .length,
      0,
      'nothing of the artist is changed'
    );
    assert.strictEqual(
      await persistedStatus(seeded),
      MediaRequestStatus.APPROVED
    );
    assert.strictEqual(
      await persistedMediaStatus(seeded),
      MediaStatus.PROCESSING
    );
  });

  it('marks the request failed, starting no search, where Lidarr answers the album add without an id', async () => {
    scenario.held = heldArtist();
    scenario.answers = { 'POST /album': { status: 201, body: {} } };
    const seeded = await seedNotListed(MediaRequestStatus.APPROVED);

    assert.strictEqual(
      await persistedStatus(seeded),
      MediaRequestStatus.FAILED
    );
    assert.strictEqual(callTo('POST', '/command'), undefined);
  });

  it('marks the request failed where Lidarr refuses the album add', async () => {
    scenario.held = heldArtist();
    scenario.answers = {
      'POST /album': { status: 400, body: fixture('error-add-400') },
    };
    const seeded = await seedNotListed(MediaRequestStatus.APPROVED);

    assert.strictEqual(
      await persistedStatus(seeded),
      MediaRequestStatus.FAILED
    );
    assert.notStrictEqual(
      await persistedMediaStatus(seeded),
      MediaStatus.PROCESSING
    );
  });
});

describe('an album request outside the saved metadata profile, its artist absent (R-7, R-14, D-352)', () => {
  it('adds the artist in one call, then the album by the album add, then starts AlbumSearch for the id Lidarr answers, with no PUT of the artist', async () => {
    const seeded = await seedNotListed(MediaRequestStatus.APPROVED);

    assert.deepStrictEqual(lines(), [
      'GET /artist',
      `GET /album/lookup?term=lidarr:${NOT_LISTED}`,
      'GET /metadataprofile',
      `GET /artist/lookup?term=lidarr:${RADIOHEAD}`,
      'POST /artist',
      `GET /album/lookup?term=lidarr:${NOT_LISTED}`,
      'POST /album',
      'POST /command',
      // the check, for the artist the add answered (id 7 in its fixture)
      'GET /album?artistId=7',
    ]);
    assert.deepStrictEqual(callTo('POST', '/artist')?.body, {
      ...forAlbumAbsent,
      addOptions: {
        ...forAlbumAbsent.addOptions,
        albumsToMonitor: [NOT_LISTED],
      },
    });
    assert.deepStrictEqual(callTo('POST', '/album')?.body, albumAddBody);
    assert.deepStrictEqual(
      (callTo('POST', '/command')?.body as { albumIds: number[] }).albumIds,
      [ADDED_ALBUM_ID]
    );
    assert.strictEqual(calls.filter((c) => c.method === 'PUT').length, 0);
    assert.strictEqual(
      await persistedStatus(seeded),
      MediaRequestStatus.APPROVED
    );
    assert.strictEqual(
      await persistedMediaStatus(seeded),
      MediaStatus.PROCESSING
    );
  });

  // the album's types against the profile as Lidarr's filter reads them: each
  // lookup below changes one thing of the album inside the profile
  const base = fixture<LidarrAlbum[]>('album-lookup-mbid')[0];
  const outsideCases: [string, Partial<LidarrAlbum>, boolean][] = [
    [
      'a primary type the profile does not allow (EP)',
      { albumType: 'EP' },
      true,
    ],
    [
      'a secondary type the profile does not allow (Live)',
      { secondaryTypes: ['Live'] },
      true,
    ],
    [
      'no release of an allowed status',
      {
        releases: [
          { foreignReleaseId: 'r', status: 'Bootleg', monitored: true },
        ],
      },
      true,
    ],
    ['no primary type', { albumType: undefined }, true],
    ['an album with no secondary type (Studio allowed)', {}, false],
    [
      'a secondary type the profile allows (Studio)',
      { secondaryTypes: ['Studio'] },
      false,
    ],
    [
      'several secondary types, one the profile allows (Studio, Live)',
      { secondaryTypes: ['Studio', 'Live'] },
      false,
    ],
    [
      'several secondary types, the allowed one last (Live, Studio)',
      { secondaryTypes: ['Live', 'Studio'] },
      false,
    ],
    [
      'several secondary types, none the profile allows (Live, Compilation)',
      { secondaryTypes: ['Live', 'Compilation'] },
      true,
    ],
    [
      'an official release among bootlegs',
      {
        releases: [
          { foreignReleaseId: 'a', status: 'Bootleg', monitored: false },
          { foreignReleaseId: 'b', status: 'Official', monitored: true },
        ],
      },
      false,
    ],
  ];

  for (const [name, change, outside] of outsideCases) {
    it(`reads ${name} as ${outside ? 'outside' : 'inside'} the profile`, async () => {
      // as Lidarr answers once it holds the artist (id 7 as in the fixture
      // of the album outside the profile)
      scenario.albumLookup = [
        {
          ...base,
          artistId: 7,
          artist: { ...(base.artist as LidarrArtist), id: 7 },
          ...change,
        },
      ];
      await seedRequest(MusicKind.ALBUM, MediaRequestStatus.APPROVED);

      assert.strictEqual(
        calls.some((c) => c.method === 'POST' && c.path === '/album'),
        outside
      );
      assert.strictEqual(
        calls.some((c) => c.method === 'POST' && c.path === '/command'),
        outside
      );
      assert.strictEqual(calls.filter((c) => c.method === 'PUT').length, 0);
    });
  }

  it('reads an album with no secondary type as outside a profile that does not allow Studio', async () => {
    const [standard, none] = fixture<MetadataProfile[]>('metadataprofiles');

    scenario.profiles = [
      {
        ...standard,
        secondaryAlbumTypes: standard.secondaryAlbumTypes?.map((t) => ({
          ...t,
          allowed: false,
        })),
      },
      none,
    ];
    scenario.albumLookup = [
      {
        ...fixture<LidarrAlbum[]>('album-lookup-mbid')[0],
        artistId: 7,
        artist: {
          ...(fixture<LidarrAlbum[]>('album-lookup-mbid')[0]
            .artist as LidarrArtist),
          id: 7,
        },
      },
    ];
    await seedRequest(MusicKind.ALBUM, MediaRequestStatus.APPROVED);

    assert.ok(callTo('POST', '/album'), 'added by the album add');
    assert.ok(callTo('POST', '/command'), 'and searched');
  });

  it('marks the request failed where the album add is refused after the artist add, and where the profile cannot be read', async () => {
    scenario.answers = {
      'POST /album': { status: 400, body: fixture('error-add-400') },
    };
    const refused = await seedNotListed(MediaRequestStatus.APPROVED);

    assert.strictEqual(
      await persistedStatus(refused),
      MediaRequestStatus.FAILED
    );
    assert.ok(callTo('POST', '/artist'), 'the artist add was made first');

    calls = [];
    scenario = { answers: { 'GET /metadataprofile': { status: 500 } } };
    const unread = await seedRequest(
      MusicKind.ALBUM,
      MediaRequestStatus.APPROVED
    );

    assert.strictEqual(
      await persistedStatus(unread),
      MediaRequestStatus.FAILED
    );
    assert.strictEqual(calls.filter((c) => c.method === 'POST').length, 0);
  });

  it('retried after the artist add Lidarr took and the album add that failed, adds the album by the album add (artist held, not listing it)', async () => {
    scenario.answers = { 'POST /album': 'drop' };
    const seeded = await seedNotListed(MediaRequestStatus.APPROVED);

    assert.strictEqual(
      await persistedStatus(seeded),
      MediaRequestStatus.FAILED
    );

    // the retry: the artist is held as the one add left it, the EP not listed
    calls = [];
    const albumLookup = scenario.albumLookup;
    scenario = {
      albumLookup,
      held: heldArtist({ monitored: true, monitorNewItems: 'none' }),
    };
    await approve(seeded);

    assert.deepStrictEqual(lines(), [
      'GET /artist',
      `GET /album?artistId=${HELD_ID}`,
      `GET /album/lookup?term=lidarr:${NOT_LISTED}`,
      'POST /album',
      'POST /command',
      `GET /album?artistId=${HELD_ID}`,
    ]);
    assert.deepStrictEqual(callTo('POST', '/album')?.body, albumAddBody);
    assert.strictEqual(
      await persistedStatus(seeded),
      MediaRequestStatus.APPROVED
    );
    assert.strictEqual(
      await persistedMediaStatus(seeded),
      MediaStatus.PROCESSING
    );
  });

  it('retried after an album add Lidarr took, finds the album listed and only monitors and searches it', async () => {
    scenario.answers = { 'POST /command': { status: 500 } };
    const seeded = await seedNotListed(MediaRequestStatus.APPROVED);

    assert.strictEqual(
      await persistedStatus(seeded),
      MediaRequestStatus.FAILED
    );
    assert.ok(callTo('POST', '/album'), 'Lidarr took the album add');

    // the retry: Lidarr now lists the EP (id 61) for the held artist
    calls = [];
    const albums = fixture<LidarrAlbum[]>('albums');
    scenario = {
      held: heldArtist(),
      albums: [
        ...albums,
        { ...fixture<LidarrAlbum>('album-add'), id: ADDED_ALBUM_ID },
      ],
    };
    await approve(seeded);

    assert.deepStrictEqual(lines(), [
      'GET /artist',
      `GET /album?artistId=${HELD_ID}`,
      'PUT /album/monitor',
      'POST /command',
      `GET /album?artistId=${HELD_ID}`,
    ]);
    assert.deepStrictEqual(callTo('PUT', '/album/monitor')?.body, {
      albumIds: [ADDED_ALBUM_ID],
      monitored: true,
    });
    assert.strictEqual(
      await persistedStatus(seeded),
      MediaRequestStatus.APPROVED
    );
  });
});

describe('an album request retried after Lidarr took the add (R-7, R-9, D-352)', () => {
  it('finds the artist held as the add left it and only monitors and searches the album', async () => {
    // the first try: Lidarr takes the add and the answer never reaches Seerr
    scenario.answers = { 'POST /artist': 'drop' };
    const seeded = await seedRequest(
      MusicKind.ALBUM,
      MediaRequestStatus.APPROVED
    );

    assert.deepStrictEqual(lines(), absentLines);
    assert.deepStrictEqual(callTo('POST', '/artist')?.body, forAlbumAbsent);
    assert.strictEqual(
      await persistedStatus(seeded),
      MediaRequestStatus.FAILED
    );

    // the retry: the artist is held, monitored, new-album monitoring none
    calls = [];
    scenario = {
      held: heldArtist({ monitored: true, monitorNewItems: 'none' }),
    };
    await approve(seeded);

    assert.deepStrictEqual(lines(), [
      'GET /artist',
      `GET /album?artistId=${HELD_ID}`,
      'PUT /album/monitor',
      'POST /command',
      `GET /album?artistId=${HELD_ID}`,
    ]);
    assert.deepStrictEqual(callTo('PUT', '/album/monitor')?.body, {
      albumIds: [OK_COMPUTER_ID],
      monitored: true,
    });
    assert.strictEqual(
      await persistedStatus(seeded),
      MediaRequestStatus.APPROVED
    );
    assert.strictEqual(
      await persistedMediaStatus(seeded),
      MediaStatus.PROCESSING
    );
  });

  it('sends a retry after an add Lidarr never took by the same calls as the first try', async () => {
    scenario.answers = { 'GET /artist/lookup': { status: 500 } };
    const seeded = await seedRequest(
      MusicKind.ALBUM,
      MediaRequestStatus.APPROVED
    );

    assert.strictEqual(
      await persistedStatus(seeded),
      MediaRequestStatus.FAILED
    );

    calls = [];
    scenario = {};
    await approve(seeded);

    assert.deepStrictEqual(lines(), absentLines);
    assert.deepStrictEqual(callTo('POST', '/artist')?.body, forAlbumAbsent);
    assert.strictEqual(
      await persistedStatus(seeded),
      MediaRequestStatus.APPROVED
    );
  });
});

describe('a whole-artist request (R-46, D-352)', () => {
  const forArtistAbsent = {
    foreignArtistId: RADIOHEAD,
    artistName: 'Radiohead',
    qualityProfileId: 3,
    metadataProfileId: 1,
    rootFolderPath: '/music',
    monitored: true,
    monitorNewItems: 'all',
    addOptions: {
      monitor: 'all',
      albumsToMonitor: [],
      searchForMissingAlbums: true,
    },
  };

  it('adds an artist Lidarr lacks with every album and new albums monitored and a search on add', async () => {
    scenario.artistAdd = fixture('artist-add-all');
    const seeded = await seedRequest(
      MusicKind.ARTIST,
      MediaRequestStatus.APPROVED
    );

    assert.deepStrictEqual(lines(), [
      'GET /artist',
      `GET /artist/lookup?term=lidarr:${RADIOHEAD}`,
      'POST /artist',
    ]);
    assert.deepStrictEqual(callTo('POST', '/artist')?.body, forArtistAbsent);
    assert.strictEqual(
      await persistedMediaStatus(seeded),
      MediaStatus.PROCESSING
    );
  });

  it('puts the artist monitored where Lidarr answers the add unmonitored, changing nothing else', async () => {
    // the answer of an add with monitor 'none': held with monitored false
    scenario.artistAdd = fixture('artist-add');
    scenario.albums = fixture<LidarrAlbum[]>('albums').map((a) => ({
      ...a,
      monitored: true,
    }));
    await seedRequest(MusicKind.ARTIST, MediaRequestStatus.APPROVED);

    assert.deepStrictEqual(lines(), [
      'GET /artist',
      `GET /artist/lookup?term=lidarr:${RADIOHEAD}`,
      'POST /artist',
      `GET /artist/${HELD_ID}`,
      `PUT /artist/${HELD_ID}`,
      // the check reads every album Lidarr lists back
      `GET /album?artistId=${HELD_ID}`,
    ]);
    assert.deepStrictEqual(callTo('PUT', `/artist/${HELD_ID}`)?.body, {
      ...fixture<LidarrArtist>('artist-by-id'),
      monitored: true,
    });
  });

  it('updates an artist Lidarr holds monitored with new-album monitoring all, monitors every album it lists and starts its search', async () => {
    scenario.held = heldArtist({ monitored: false, monitorNewItems: 'none' });
    scenario.answers = {
      'POST /command': { status: 201, body: fixture('command-artistsearch') },
    };
    const seeded = await seedRequest(
      MusicKind.ARTIST,
      MediaRequestStatus.APPROVED
    );

    assert.deepStrictEqual(lines(), [
      'GET /artist',
      `GET /artist/${HELD_ID}`,
      `PUT /artist/${HELD_ID}`,
      `GET /album?artistId=${HELD_ID}`,
      'PUT /album/monitor',
      'POST /command',
      `GET /album?artistId=${HELD_ID}`,
    ]);
    assert.deepStrictEqual(callTo('PUT', `/artist/${HELD_ID}`)?.body, {
      ...fixture<LidarrArtist>('artist-by-id'),
      monitored: true,
      monitorNewItems: 'all',
    });
    assert.deepStrictEqual(callTo('PUT', '/album/monitor')?.body, {
      albumIds: ALBUM_IDS,
      monitored: true,
    });
    const command = callTo('POST', '/command')?.body as {
      name: string;
      artistId: number;
    };
    assert.strictEqual(command.name, 'ArtistSearch');
    assert.strictEqual(command.artistId, HELD_ID);
    assert.strictEqual(
      await persistedMediaStatus(seeded),
      MediaStatus.PROCESSING
    );
  });

  it('sends a retry of a whole-artist request after a taken add by the held branch', async () => {
    scenario.answers = { 'POST /artist': 'drop' };
    const seeded = await seedRequest(
      MusicKind.ARTIST,
      MediaRequestStatus.APPROVED
    );

    assert.strictEqual(
      await persistedStatus(seeded),
      MediaRequestStatus.FAILED
    );

    calls = [];
    scenario = { held: heldArtist({ monitored: false }) };
    await approve(seeded);

    assert.deepStrictEqual(lines(), [
      'GET /artist',
      `GET /artist/${HELD_ID}`,
      `PUT /artist/${HELD_ID}`,
      `GET /album?artistId=${HELD_ID}`,
      'PUT /album/monitor',
      'POST /command',
      `GET /album?artistId=${HELD_ID}`,
    ]);
    assert.strictEqual(
      await persistedStatus(seeded),
      MediaRequestStatus.APPROVED
    );
  });
});

describe('a music request Lidarr cannot take is marked failed (R-9, R-14, D-352)', () => {
  it('marks it failed where no default Lidarr server is configured, calling nothing', async () => {
    configureLidarr((server.address() as AddressInfo).port, false);
    const seeded = await seedRequest(
      MusicKind.ALBUM,
      MediaRequestStatus.APPROVED
    );

    assert.deepStrictEqual(lines(), []);
    assert.strictEqual(
      await persistedStatus(seeded),
      MediaRequestStatus.FAILED
    );
    assert.strictEqual(await persistedMediaStatus(seeded), MediaStatus.PENDING);
  });

  const failures: [string, Scenario, MusicKind][] = [
    [
      'the artist list answers an error',
      { answers: { 'GET /artist': { status: 401 } } },
      MusicKind.ALBUM,
    ],
    [
      'the lookup of the artist answers an error',
      { answers: { 'GET /artist/lookup': { status: 500 } } },
      MusicKind.ALBUM,
    ],
    [
      'Lidarr does not know the artist',
      {
        answers: {
          'GET /artist/lookup': { status: 200, body: [] },
        },
      },
      MusicKind.ARTIST,
    ],
    [
      'the artist add is refused',
      {
        answers: {
          'POST /artist': { status: 400, body: fixture('error-add-400') },
        },
      },
      MusicKind.ALBUM,
    ],
    [
      'the artist add of a whole artist is refused',
      {
        answers: {
          'POST /artist': { status: 400, body: fixture('error-add-400') },
        },
      },
      MusicKind.ARTIST,
    ],
    [
      'the album monitoring of a held artist fails',
      {
        held: heldArtist(),
        answers: { 'PUT /album/monitor': { status: 500 } },
      },
      MusicKind.ALBUM,
    ],
    [
      'the album search of a held artist fails',
      { held: heldArtist(), answers: { 'POST /command': { status: 500 } } },
      MusicKind.ALBUM,
    ],
    [
      'the update of a held artist fails',
      {
        held: heldArtist(),
        answers: { [`PUT /artist/${HELD_ID}`]: { status: 500 } },
      },
      MusicKind.ARTIST,
    ],
    [
      'the artist search of a held artist fails',
      { held: heldArtist(), answers: { 'POST /command': { status: 500 } } },
      MusicKind.ARTIST,
    ],
    [
      'the PUT of an artist answered unmonitored fails',
      {
        artistAdd: fixture('artist-add'),
        answers: { [`PUT /artist/${HELD_ID}`]: { status: 500 } },
      },
      MusicKind.ARTIST,
    ],
  ];

  for (const [name, failing, kind] of failures) {
    it(`marks it failed where ${name}, the media row left as it was`, async () => {
      scenario = failing;
      const seeded = await seedRequest(kind, MediaRequestStatus.APPROVED);

      assert.strictEqual(
        await persistedStatus(seeded),
        MediaRequestStatus.FAILED
      );
      assert.strictEqual(
        await persistedMediaStatus(seeded),
        MediaStatus.PENDING
      );
    });
  }

  it('marks it failed where Lidarr is stopped', async () => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    const seeded = await seedRequest(
      MusicKind.ALBUM,
      MediaRequestStatus.APPROVED
    );

    assert.strictEqual(
      await persistedStatus(seeded),
      MediaRequestStatus.FAILED
    );
    assert.strictEqual(await persistedMediaStatus(seeded), MediaStatus.PENDING);
    server = createServer(handle);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
  });

  it('marks it failed where Lidarr does not answer within the timeout', async () => {
    getSettings().network.apiRequestTimeout = 300;
    scenario.answers = { 'GET /artist': 'hang' };
    const seeded = await seedRequest(
      MusicKind.ALBUM,
      MediaRequestStatus.APPROVED
    );

    assert.strictEqual(
      await persistedStatus(seeded),
      MediaRequestStatus.FAILED
    );
  });

  it('marks it failed where Lidarr takes the call and the answer is lost, and the retry sends again', async () => {
    scenario.answers = { 'POST /artist': 'drop' };
    const seeded = await seedRequest(
      MusicKind.ARTIST,
      MediaRequestStatus.APPROVED
    );

    assert.strictEqual(
      await persistedStatus(seeded),
      MediaRequestStatus.FAILED
    );

    calls = [];
    scenario = { artistAdd: fixture('artist-add-all') };
    await approve(seeded);

    assert.deepStrictEqual(lines(), [
      'GET /artist',
      `GET /artist/lookup?term=lidarr:${RADIOHEAD}`,
      'POST /artist',
    ]);
    assert.strictEqual(
      await persistedStatus(seeded),
      MediaRequestStatus.APPROVED
    );
    assert.strictEqual(
      await persistedMediaStatus(seeded),
      MediaStatus.PROCESSING
    );
  });
});

// What the request flow writes on a music row lidarr-scan made available or
// partially available (D-352, R-6, R-13): nothing, at any step; a row not
// available goes to processing on a send as before.
describe('a music row lidarr-scan made available or partially available (D-352, R-6)', () => {
  const rowOf = async (seeded: Seeded): Promise<unknown> =>
    (
      await dataSource.query('SELECT * FROM media WHERE id = ?', [
        seeded.media.id,
      ])
    )[0];

  for (const status of [
    MediaStatus.PARTIALLY_AVAILABLE,
    MediaStatus.AVAILABLE,
  ]) {
    it(`leaves a whole-artist row ${status === MediaStatus.AVAILABLE ? 'available' : 'partially available'} through its request created, approved, sent, failed and retried`, async () => {
      scenario.answers = { 'POST /artist': { status: 500 } };
      const seeded = await seedRequest(
        MusicKind.ARTIST,
        MediaRequestStatus.PENDING
      );

      await getRepository(Media).update(seeded.media.id, { status });
      const before = await rowOf(seeded);

      // created pending: nothing written
      assert.deepStrictEqual(await rowOf(seeded), before);

      // approved, and the send fails
      await approve(seeded);
      assert.strictEqual(
        await persistedStatus(seeded),
        MediaRequestStatus.FAILED
      );
      assert.ok(callTo('POST', '/artist'));
      assert.deepStrictEqual(await rowOf(seeded), before);

      // retried, and the send goes through
      calls = [];
      scenario = { artistAdd: fixture('artist-add-all') };
      await approve(seeded);
      assert.deepStrictEqual(lines(), [
        'GET /artist',
        `GET /artist/lookup?term=lidarr:${RADIOHEAD}`,
        'POST /artist',
      ]);
      assert.strictEqual(
        await persistedStatus(seeded),
        MediaRequestStatus.APPROVED
      );
      assert.deepStrictEqual(await rowOf(seeded), before);
    });
  }

  it('leaves a partially available artist row as it is where the request is approved at its creation and sent', async () => {
    scenario.artistAdd = fixture('artist-add-all');
    const requestedBy = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });
    const media = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MUSIC,
        musicBrainzId: RADIOHEAD,
        musicKind: MusicKind.ARTIST,
        status: MediaStatus.PARTIALLY_AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    const seeded = { media, request: undefined } as unknown as Seeded;
    const before = await rowOf(seeded);

    await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.MUSIC,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy,
        modifiedBy: requestedBy,
        is4k: false,
      })
    );
    await lidarrSendsEnded();

    assert.ok(callTo('POST', '/artist'));
    assert.deepStrictEqual(await rowOf(seeded), before);
  });

  it('leaves an available album row as it is through its request approved and sent', async () => {
    scenario.artistAdd = fixture('artist-add-existing');
    const seeded = await seedRequest(
      MusicKind.ALBUM,
      MediaRequestStatus.PENDING
    );

    await getRepository(Media).update(seeded.media.id, {
      status: MediaStatus.AVAILABLE,
    });
    const before = await rowOf(seeded);

    await approve(seeded);

    assert.ok(callTo('POST', '/artist'));
    assert.deepStrictEqual(await rowOf(seeded), before);
  });

  it('puts an artist row that is not available to processing on a send, as before', async () => {
    scenario.artistAdd = fixture('artist-add-all');
    const seeded = await seedRequest(
      MusicKind.ARTIST,
      MediaRequestStatus.PENDING
    );

    await getRepository(Media).update(seeded.media.id, {
      status: MediaStatus.UNKNOWN,
    });
    await approve(seeded);

    assert.strictEqual(
      await persistedMediaStatus(seeded),
      MediaStatus.PROCESSING
    );
  });
});

// Lidarr's command queue as the test Lidarr answered it while it refreshed an
// artist it had just been given (Lidarr id 9 in the fixtures), naming the
// artist of the scenario instead
const queueOf = (name: string, artistId: number): LidarrCommand[] =>
  fixture<LidarrCommand[]>(name).map((command) => ({
    ...command,
    body: {
      ...command.body,
      ...(command.body.artistIds?.includes(9) ? { artistIds: [artistId] } : {}),
      ...(command.body.artistId === 9 ? { artistId } : {}),
    },
  }));
const queued = (commands: LidarrCommand[]): LidarrCommand[] =>
  commands.map((c) =>
    c.status === 'started' ? { ...c, status: 'queued' } : c
  );
const settled = fixture<LidarrCommand[]>('command-queue-settled');

const nth = (all: string[], line: string, n: number): number =>
  all.reduce<number[]>((at, l, i) => (l === line ? [...at, i] : at), [])[n];
const until = async (done: () => boolean): Promise<void> => {
  for (let i = 0; i < 300 && !done(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(done(), 'the condition did not come true');
};
const releasable = (key: string): (() => void) => {
  let open!: () => void;

  gate = {
    key,
    open: new Promise<void>((resolve) => (open = resolve)),
    taken: false,
  };

  return open;
};

describe('the wait on Lidarr and the check after the calls (D-352, R-7, R-46)', () => {
  it('waits at two seconds and five minutes as D-352 sets them', () => {
    assert.deepStrictEqual(defaultTimings, {
      pollMs: 2000,
      boundMs: 5 * 60 * 1000,
    });
  });

  it('makes no album call before Lidarr holds no command naming the artist queued or started (queued, started, then completed)', async () => {
    scenario.held = heldArtist();
    scenario.queue = [
      queued(queueOf('command-queue-refresh-started', HELD_ID)),
      queueOf('command-queue-refresh-started', HELD_ID),
      queueOf('command-queue-rescan-started', HELD_ID),
      settled,
    ];
    const seeded = await seedRequest(
      MusicKind.ALBUM,
      MediaRequestStatus.APPROVED
    );

    assert.deepStrictEqual(allLines(), [
      'GET /artist',
      'GET /command',
      'GET /command',
      'GET /command',
      'GET /command',
      `GET /album?artistId=${HELD_ID}`,
      'PUT /album/monitor',
      'POST /command',
      // the check waits again, and reads back
      'GET /command',
      `GET /album?artistId=${HELD_ID}`,
    ]);
    assert.strictEqual(
      await persistedStatus(seeded),
      MediaRequestStatus.APPROVED
    );
  });

  it('reads the queue again after the poll interval while a command naming the artist is queued or started', async () => {
    lidarrSendTimings.pollMs = 150;
    scenario.held = heldArtist();
    scenario.queue = [
      queueOf('command-queue-refresh-started', HELD_ID),
      queueOf('command-queue-refresh-started', HELD_ID),
      settled,
    ];
    await seedRequest(MusicKind.ALBUM, MediaRequestStatus.APPROVED);

    const reads = calls.filter(
      (c) => c.method === 'GET' && c.path === '/command'
    );

    assert.ok(reads[1].at - reads[0].at >= 140, 'the second read waits');
    assert.ok(reads[2].at - reads[1].at >= 140, 'and the third');
  });

  it('does not wait on a search naming the artist, queued or started (MissingAlbumSearch, ArtistSearch)', async () => {
    scenario.held = heldArtist();
    const artistSearch = {
      ...fixture<LidarrCommand>('command-artistsearch'),
      id: 77,
      status: 'queued',
    };
    scenario.queue = [
      queueOf('command-queue-search-started', HELD_ID),
      [
        {
          ...artistSearch,
          body: { ...artistSearch.body, artistId: HELD_ID },
        },
      ],
    ];
    await seedRequest(MusicKind.ALBUM, MediaRequestStatus.APPROVED);

    assert.deepStrictEqual(allLines().slice(0, 3), [
      'GET /artist',
      'GET /command',
      `GET /album?artistId=${HELD_ID}`,
    ]);
    // and the check after the calls does not wait on it either
    assert.deepStrictEqual(allLines().slice(-2), [
      'GET /command',
      `GET /album?artistId=${HELD_ID}`,
    ]);
    assert.strictEqual(
      allLines().filter((l) => l === 'GET /command').length,
      2
    );
  });

  it('waits on a RefreshArtist naming the artist while a search naming it runs, and goes on once only the search is left', async () => {
    scenario.held = heldArtist();
    scenario.queue = [
      [
        ...queueOf('command-queue-search-started', HELD_ID),
        ...queueOf('command-queue-refresh-started', HELD_ID),
      ],
      queueOf('command-queue-search-started', HELD_ID),
    ];
    const seeded = await seedRequest(
      MusicKind.ALBUM,
      MediaRequestStatus.APPROVED
    );

    assert.deepStrictEqual(allLines().slice(0, 4), [
      'GET /artist',
      'GET /command',
      'GET /command',
      `GET /album?artistId=${HELD_ID}`,
    ]);
    assert.ok(callTo('PUT', '/album/monitor'), 'the calls were made');
    assert.notStrictEqual(
      await persistedStatus(seeded),
      MediaRequestStatus.FAILED
    );
  });

  it('does not wait on a command naming another artist', async () => {
    scenario.held = heldArtist();
    scenario.queue = [queueOf('command-queue-refresh-started', 99)];
    await seedRequest(MusicKind.ALBUM, MediaRequestStatus.APPROVED);

    assert.deepStrictEqual(allLines().slice(0, 3), [
      'GET /artist',
      'GET /command',
      `GET /album?artistId=${HELD_ID}`,
    ]);
  });

  it('marks the request failed, calling no album, where the wait passes five minutes', async () => {
    scenario.held = heldArtist();
    scenario.queue = [queueOf('command-queue-refresh-started', HELD_ID)];
    const seeded = await seedRequest(
      MusicKind.ALBUM,
      MediaRequestStatus.APPROVED
    );

    assert.strictEqual(
      await persistedStatus(seeded),
      MediaRequestStatus.FAILED
    );
    assert.strictEqual(
      calls.filter((c) => c.method !== 'GET').length,
      0,
      'no call that changes Lidarr was made'
    );
    assert.strictEqual(await persistedMediaStatus(seeded), MediaStatus.PENDING);
  });

  it('marks the request failed where the wait after the calls passes five minutes', async () => {
    scenario.held = heldArtist();
    scenario.queue = [settled, queueOf('command-queue-refresh-started', 3)];
    const seeded = await seedRequest(
      MusicKind.ALBUM,
      MediaRequestStatus.APPROVED
    );

    assert.ok(callTo('PUT', '/album/monitor'), 'the calls were made');
    assert.strictEqual(
      await persistedStatus(seeded),
      MediaRequestStatus.FAILED
    );
  });

  it('sets an album monitored once more, with its search, where Lidarr answers it unmonitored after the first setting', async () => {
    scenario.held = heldArtist();
    scenario.unmonitored = [OK_COMPUTER_ID];
    scenario.dropFirstSetting = true;
    const seeded = await seedRequest(
      MusicKind.ALBUM,
      MediaRequestStatus.APPROVED
    );

    assert.deepStrictEqual(lines(), [
      'GET /artist',
      `GET /album?artistId=${HELD_ID}`,
      'PUT /album/monitor',
      'POST /command',
      `GET /album?artistId=${HELD_ID}`,
      'PUT /album/monitor',
      'POST /command',
      `GET /album?artistId=${HELD_ID}`,
    ]);
    for (const put of calls.filter((c) => c.path === '/album/monitor')) {
      assert.deepStrictEqual(put.body, {
        albumIds: [OK_COMPUTER_ID],
        monitored: true,
      });
    }
    for (const search of calls.filter(
      (c) => c.method === 'POST' && c.path === '/command'
    )) {
      assert.deepStrictEqual(
        {
          name: (search.body as { name: string }).name,
          albumIds: (search.body as { albumIds: number[] }).albumIds,
        },
        { name: 'AlbumSearch', albumIds: [OK_COMPUTER_ID] }
      );
    }
    assert.strictEqual(
      await persistedStatus(seeded),
      MediaRequestStatus.APPROVED
    );
    assert.strictEqual(
      await persistedMediaStatus(seeded),
      MediaStatus.PROCESSING
    );
  });

  it('marks the request failed where an album is still answered unmonitored after it was set once more', async () => {
    scenario.held = heldArtist();
    scenario.stuck = [OK_COMPUTER_ID];
    const seeded = await seedRequest(
      MusicKind.ALBUM,
      MediaRequestStatus.APPROVED
    );

    assert.strictEqual(
      calls.filter((c) => c.method === 'PUT' && c.path === '/album/monitor')
        .length,
      2
    );
    assert.strictEqual(
      calls.filter((c) => c.method === 'POST' && c.path === '/command').length,
      2
    );
    assert.strictEqual(
      calls.filter((c) => c.path.startsWith('/artist') && c.method !== 'GET')
        .length,
      0,
      'the check changes nothing of the artist'
    );
    assert.strictEqual(
      await persistedStatus(seeded),
      MediaRequestStatus.FAILED
    );
    assert.strictEqual(await persistedMediaStatus(seeded), MediaStatus.PENDING);
  });

  it('sets once more only the albums of a whole artist that Lidarr answers unmonitored', async () => {
    scenario.held = heldArtist();
    scenario.dropFirstSetting = true;
    scenario.answers = {
      'POST /command': { status: 201, body: fixture('command-artistsearch') },
    };
    // 27 (OK Computer) is monitored in Lidarr already; the first setting of
    // the others does not hold
    scenario.queue = [settled];
    const seeded = await seedRequest(
      MusicKind.ARTIST,
      MediaRequestStatus.APPROVED
    );

    const settings = calls.filter(
      (c) => c.method === 'PUT' && c.path === '/album/monitor'
    );

    assert.deepStrictEqual(
      settings.map((c) => c.body),
      [
        { albumIds: ALBUM_IDS, monitored: true },
        { albumIds: ALBUM_IDS.slice(0, 8), monitored: true },
      ]
    );
    assert.strictEqual(
      await persistedStatus(seeded),
      MediaRequestStatus.APPROVED
    );
  });

  it('makes no update of a held artist before Lidarr holds no command naming it', async () => {
    scenario.held = heldArtist({ monitored: false });
    scenario.queue = [
      queueOf('command-queue-refresh-started', HELD_ID),
      settled,
    ];
    await seedRequest(MusicKind.ARTIST, MediaRequestStatus.APPROVED);

    const all = allLines();

    assert.ok(
      all.indexOf(`PUT /artist/${HELD_ID}`) > nth(all, 'GET /command', 1),
      'the update follows the read that found the queue settled'
    );
    assert.ok(all.indexOf('PUT /album/monitor') > all.indexOf('PUT /artist/3'));
  });

  it('waits again after the update of a held artist before monitoring its albums', async () => {
    scenario.held = heldArtist({ monitored: false });
    // the update starts a command naming the artist (Lidarr's MoveArtist)
    scenario.queue = [
      settled,
      queueOf('command-queue-refresh-started', HELD_ID),
      settled,
    ];
    await seedRequest(MusicKind.ARTIST, MediaRequestStatus.APPROVED);

    const all = allLines();

    assert.ok(
      nth(all, 'GET /command', 0) < all.indexOf(`PUT /artist/${HELD_ID}`)
    );
    assert.ok(
      all.indexOf(`PUT /artist/${HELD_ID}`) < nth(all, 'GET /command', 1)
    );
    assert.ok(
      nth(all, 'GET /command', 2) < all.indexOf('PUT /album/monitor'),
      'the albums are monitored once the queue is settled again'
    );
  });

  it('waits before putting monitored an artist added unmonitored, and again before reading its albums back', async () => {
    scenario.artistAdd = fixture('artist-add');
    scenario.albums = fixture<LidarrAlbum[]>('albums').map((a) => ({
      ...a,
      monitored: true,
    }));
    scenario.queue = [
      queueOf('command-queue-refresh-started', HELD_ID),
      settled,
    ];
    await seedRequest(MusicKind.ARTIST, MediaRequestStatus.APPROVED);

    const all = allLines();

    assert.ok(all.indexOf('POST /artist') < all.indexOf('GET /command'));
    assert.ok(
      nth(all, 'GET /command', 1) < all.indexOf(`PUT /artist/${HELD_ID}`)
    );
    assert.ok(
      nth(all, 'GET /command', 2) <
        all.indexOf(`GET /album?artistId=${HELD_ID}`),
      'the check waits before it reads'
    );
  });

  it('waits again after setting an album once more, before reading it back the last time', async () => {
    scenario.held = heldArtist();
    scenario.unmonitored = [OK_COMPUTER_ID];
    scenario.dropFirstSetting = true;
    // the first wait, the check's wait, then busy after the second setting
    scenario.queue = [
      settled,
      settled,
      queueOf('command-queue-refresh-started', HELD_ID),
      settled,
    ];
    await seedRequest(MusicKind.ALBUM, MediaRequestStatus.APPROVED);

    const all = allLines();
    const reads = all.reduce<number[]>(
      (at, l, i) => (l.startsWith('GET /album?') ? [...at, i] : at),
      []
    );

    assert.ok(
      nth(all, 'GET /command', 3) < reads[reads.length - 1],
      'the last read-back follows the wait that found the queue settled'
    );
  });

  it('waits, after the artist add, before adding an album outside the profile', async () => {
    scenario.queue = [queueOf('command-queue-refresh-started', 7), settled];
    await seedNotListed(MediaRequestStatus.APPROVED);

    const all = allLines();

    assert.ok(all.indexOf('POST /artist') < all.indexOf('GET /command'));
    assert.ok(nth(all, 'GET /command', 1) < all.indexOf('POST /album'));
  });
});

describe('the sends of one artist run one at a time (D-352, R-7, R-46)', () => {
  const FIRST_ALBUM = fixture<LidarrAlbum[]>('albums')[0].foreignAlbumId;
  const PORTISHEAD = '8f6bd1e4-fbe1-4f50-aa9b-94c450ec0f11';

  it('starts the send of a second album of an artist only once the send that adds the artist has ended, and finds the artist held without a second add', async () => {
    scenario.addedHeld = true;
    const open = releasable('POST /artist');
    const first = await seedRequest(
      MusicKind.ALBUM,
      MediaRequestStatus.APPROVED,
      { sent: false }
    );
    const second = await seedRequest(
      MusicKind.ALBUM,
      MediaRequestStatus.APPROVED,
      { sent: false, albumMbid: FIRST_ALBUM }
    );

    await until(() => calls.some((c) => c.method === 'POST'));
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.strictEqual(
      allLines().filter((l) => l === 'GET /artist').length,
      1,
      'the second send has made no call while the first adds the artist'
    );

    open();
    await lidarrSendsEnded();

    const all = allLines();

    assert.strictEqual(all.filter((l) => l === 'POST /artist').length, 1);
    assert.ok(nth(all, 'GET /artist', 1) > all.indexOf('POST /artist'));
    assert.deepStrictEqual(callTo('PUT', '/album/monitor')?.body, {
      albumIds: [19],
      monitored: true,
    });
    for (const seeded of [first, second]) {
      assert.strictEqual(
        await persistedStatus(seeded),
        MediaRequestStatus.APPROVED
      );
      assert.strictEqual(
        await persistedMediaStatus(seeded),
        MediaStatus.PROCESSING
      );
    }
  });

  it('does not hold the send of another artist while one artist is added', async () => {
    scenario.addedHeld = true;
    const open = releasable('POST /artist');

    await seedRequest(MusicKind.ALBUM, MediaRequestStatus.APPROVED, {
      sent: false,
    });
    await until(() => calls.some((c) => c.method === 'POST'));
    scenario.artistAdd = fixture('artist-add-all');

    const other = await seedRequest(
      MusicKind.ARTIST,
      MediaRequestStatus.APPROVED,
      { sent: false, artistMbid: PORTISHEAD }
    );

    await until(
      () =>
        calls.filter((c) => c.method === 'POST' && c.path === '/artist')
          .length === 2
    );

    const posts = calls.filter(
      (c) => c.method === 'POST' && c.path === '/artist'
    );

    assert.deepStrictEqual(
      posts.map((c) => (c.body as { foreignArtistId: string }).foreignArtistId),
      [RADIOHEAD, PORTISHEAD]
    );
    open();
    await lidarrSendsEnded();
    assert.strictEqual(
      await persistedStatus(other),
      MediaRequestStatus.APPROVED
    );
  });

  it('sends a whole-artist request made seconds after an album request of the same absent artist by the held branch, once the album send has ended', async () => {
    scenario.addedHeld = true;
    scenario.queue = [settled];
    const open = releasable('POST /artist');

    await seedRequest(MusicKind.ALBUM, MediaRequestStatus.APPROVED, {
      sent: false,
    });
    await until(() => calls.some((c) => c.method === 'POST'));
    const artist = await seedRequest(
      MusicKind.ARTIST,
      MediaRequestStatus.APPROVED,
      { sent: false }
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    open();
    await lidarrSendsEnded();

    const all = allLines();

    assert.strictEqual(all.filter((l) => l === 'POST /artist').length, 1);
    assert.ok(
      all.indexOf(`PUT /artist/${HELD_ID}`) > all.indexOf('POST /artist')
    );
    assert.deepStrictEqual(callTo('PUT', `/artist/${HELD_ID}`)?.body, {
      ...fixture<LidarrArtist>('artist-by-id'),
      monitored: true,
      monitorNewItems: 'all',
    });
    assert.deepStrictEqual(callTo('PUT', '/album/monitor')?.body, {
      albumIds: ALBUM_IDS,
      monitored: true,
    });
    assert.strictEqual(
      await persistedStatus(artist),
      MediaRequestStatus.APPROVED
    );
  });

  it('goes on with the next send of the artist after one that failed', async () => {
    scenario.addedHeld = true;
    scenario.answers = { 'POST /artist': { status: 500 } };
    const open = releasable('POST /artist');
    const first = await seedRequest(
      MusicKind.ALBUM,
      MediaRequestStatus.APPROVED,
      { sent: false }
    );
    const second = await seedRequest(
      MusicKind.ALBUM,
      MediaRequestStatus.APPROVED,
      { sent: false, albumMbid: FIRST_ALBUM }
    );

    open();
    await lidarrSendsEnded();

    assert.strictEqual(await persistedStatus(first), MediaRequestStatus.FAILED);
    // the failed add was taken by the fake as an add: the second finds the
    // artist held and sets its album
    assert.strictEqual(
      await persistedStatus(second),
      MediaRequestStatus.APPROVED
    );
  });
});

describe('no route waits on the send to Lidarr (D-352)', () => {
  it('lets the save of an approved request return while the send is still at its first call, then puts the media row to processing as the send ends', async () => {
    const open = releasable('GET /artist');
    const seeded = await seedRequest(
      MusicKind.ALBUM,
      MediaRequestStatus.APPROVED,
      { sent: false }
    );

    assert.strictEqual(
      await persistedStatus(seeded),
      MediaRequestStatus.APPROVED
    );
    assert.strictEqual(await persistedMediaStatus(seeded), MediaStatus.PENDING);
    assert.strictEqual(callTo('POST', '/artist'), undefined);

    open();
    await lidarrSendsEnded();

    assert.ok(callTo('POST', '/artist'));
    assert.strictEqual(
      await persistedMediaStatus(seeded),
      MediaStatus.PROCESSING
    );
  });

  it('lets the save return while the send waits on Lidarr', async () => {
    scenario.held = heldArtist();
    scenario.queue = [queueOf('command-queue-refresh-started', HELD_ID)];
    lidarrSendTimings.boundMs = 100000;
    const started = Date.now();
    const seeded = await seedRequest(
      MusicKind.ALBUM,
      MediaRequestStatus.APPROVED,
      { sent: false }
    );

    assert.ok(Date.now() - started < 1000);
    assert.strictEqual(
      await persistedStatus(seeded),
      MediaRequestStatus.APPROVED
    );
    scenario.queue = [settled];
    await lidarrSendsEnded();
    assert.strictEqual(
      await persistedMediaStatus(seeded),
      MediaStatus.PROCESSING
    );
  });

  it('leaves a request declined while its send was under way as it is, though the send fails', async () => {
    const open = releasable('GET /artist');
    scenario.answers = { 'GET /artist/lookup': { status: 500 } };
    const seeded = await seedRequest(
      MusicKind.ALBUM,
      MediaRequestStatus.APPROVED,
      { sent: false }
    );

    await getRepository(MediaRequest).update(seeded.request.id, {
      status: MediaRequestStatus.DECLINED,
    });
    open();
    await lidarrSendsEnded();

    assert.strictEqual(
      await persistedStatus(seeded),
      MediaRequestStatus.DECLINED
    );
  });

  it('does not bring back a request deleted while its send was under way', async () => {
    const open = releasable('GET /artist');
    scenario.answers = { 'POST /artist': { status: 500 } };
    const seeded = await seedRequest(
      MusicKind.ALBUM,
      MediaRequestStatus.APPROVED,
      { sent: false }
    );

    await getRepository(MediaRequest).delete(seeded.request.id);
    open();
    await lidarrSendsEnded();

    assert.strictEqual(
      await getRepository(MediaRequest).count({
        where: { id: seeded.request.id },
      }),
      0
    );
  });
});

describe('what is not sent to Lidarr (R-9, D-8)', () => {
  const stubs = new MethodStubs();

  afterEach(() => stubs.restore());

  it('sends nothing for a declined music request', async () => {
    const seeded = await seedRequest(
      MusicKind.ALBUM,
      MediaRequestStatus.PENDING
    );
    const request = await getRepository(MediaRequest).findOneOrFail({
      where: { id: seeded.request.id },
      relations: { media: true, requestedBy: true },
    });

    request.status = MediaRequestStatus.DECLINED;
    await getRepository(MediaRequest).save(request);

    assert.deepStrictEqual(lines(), []);
  });

  it('sends a movie and a TV request nothing to Lidarr', async () => {
    const details = {
      genres: [],
      original_language: 'en',
      keywords: { keywords: [] },
      external_ids: {},
    };

    stubs.stub(TheMovieDb.prototype, 'getMovie', async () => details);
    stubs.stub(TheMovieDb.prototype, 'getTvShow', async () => details);

    const requestedBy = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    for (const [mediaType, tmdbId] of [
      [MediaType.MOVIE, 603],
      [MediaType.TV, 1396],
    ] as const) {
      const media = await getRepository(Media).save(
        new Media({
          mediaType,
          tmdbId,
          status: MediaStatus.PENDING,
          status4k: MediaStatus.UNKNOWN,
        })
      );
      const request = await getRepository(MediaRequest).save(
        new MediaRequest({
          type: mediaType,
          status: MediaRequestStatus.APPROVED,
          media,
          requestedBy,
          is4k: false,
        })
      );

      assert.strictEqual(
        (
          await getRepository(MediaRequest).findOneOrFail({
            where: { id: request.id },
          })
        ).status,
        MediaRequestStatus.APPROVED,
        'no Radarr or Sonarr is configured, and the request is left as it is'
      );
    }

    assert.deepStrictEqual(lines(), []);
  });
});
