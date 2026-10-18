import type {
  LidarrHistoryEvent,
  LidarrTrack,
  LidarrTrackFile,
} from '@server/api/servarr/lidarr';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { HeldFile } from './albumCameInAt';
import { albumCameInAt } from './albumCameInAt';

// albumCameInAt (F2-D-311): when an album came into the library, from its
// history and the files Lidarr holds of it.

let nextId = 1;

const at = (iso: string) => Date.parse(iso);

const imported = (
  date: string,
  trackId: number | undefined,
  id = nextId++
): LidarrHistoryEvent => ({
  id,
  date,
  eventType: 'trackFileImported',
  trackId,
});

const deleted = (
  date: string,
  trackId: number,
  reason?: string,
  id = nextId++
): LidarrHistoryEvent => ({
  id,
  date,
  eventType: 'trackFileDeleted',
  trackId,
  data: reason === undefined ? {} : { reason },
});

const other = (
  eventType: string,
  date: string,
  trackId: number
): LidarrHistoryEvent => ({ id: nextId++, date, eventType, trackId });

let nextFileId = 1000;

const file = (dateAdded: string, ...trackIds: number[]): HeldFile => ({
  id: nextFileId++,
  dateAdded,
  trackIds,
});

// the album's tracks now, where a case names none: every track its history and
// its held files name (the album has them all)
const came = (
  events: LidarrHistoryEvent[],
  held: HeldFile[],
  albumTrackIds?: number[]
): number | null =>
  albumCameInAt(
    events,
    held,
    albumTrackIds ?? [
      ...new Set([
        ...events.flatMap((e) =>
          e.trackId === undefined || e.trackId === null ? [] : [e.trackId]
        ),
        ...held.flatMap((f) => f.trackIds),
      ]),
    ]
  );

describe('albumCameInAt', () => {
  it('is the first import of an album held since it came', () => {
    const events = [
      imported('2026-01-01T10:00:05Z', 1),
      imported('2026-01-01T10:00:06Z', 2),
    ];

    assert.strictEqual(
      came(events, [
        file('2026-01-01T10:00:00Z', 1),
        file('2026-01-01T10:00:00Z', 2),
      ]),
      at('2026-01-01T10:00:05Z')
    );
  });

  it('is the second import of an album whose every file was deleted and imported again', () => {
    const events = [
      imported('2026-01-01T10:00:05Z', 1),
      imported('2026-01-01T10:00:06Z', 2),
      deleted('2026-02-01T00:00:00Z', 1, 'MissingFromDisk'),
      deleted('2026-02-01T00:00:01Z', 2, 'Manual'),
      imported('2026-03-01T09:00:05Z', 1),
      imported('2026-03-01T09:00:06Z', 2),
    ];

    assert.strictEqual(
      came(events, [
        file('2026-03-01T09:00:00Z', 1),
        file('2026-03-01T09:00:00Z', 2),
      ]),
      at('2026-03-01T09:00:05Z')
    );
  });

  it("still stands at the second import where that run's records are dated ten minutes after its files' dateAdded", () => {
    const events = [
      imported('2026-01-01T10:00:05Z', 1),
      imported('2026-01-01T10:00:06Z', 2),
      deleted('2026-02-01T00:00:00Z', 1, 'MissingFromDisk'),
      deleted('2026-02-01T00:00:01Z', 2, 'MissingFromDisk'),
      imported('2026-03-01T09:10:00Z', 1),
      imported('2026-03-01T09:10:30Z', 2),
    ];

    assert.strictEqual(
      came(events, [
        file('2026-03-01T09:00:00Z', 1),
        file('2026-03-01T09:00:00Z', 2),
      ]),
      at('2026-03-01T09:10:00Z')
    );
  });

  it('is not moved by an upgrade (a delete with reason Upgrade, then an import) or a manual override', () => {
    for (const reason of ['Upgrade', 'ManualOverride']) {
      const events = [
        imported('2026-01-01T10:00:05Z', 1),
        deleted('2026-02-01T00:00:00Z', 1, reason),
        imported('2026-02-01T00:00:02Z', 1),
      ];

      assert.strictEqual(
        came(events, [file('2026-02-01T00:00:00Z', 1)]),
        at('2026-01-01T10:00:05Z'),
        reason
      );
    }
  });

  it('is not moved by an upgrade whose delete is dated after its import record', () => {
    const events = [
      imported('2026-01-01T10:00:05Z', 1),
      imported('2026-02-01T00:00:02Z', 1),
      deleted('2026-02-01T00:00:03Z', 1, 'Upgrade'),
    ];

    assert.strictEqual(
      came(events, [file('2026-02-01T00:00:00Z', 1)]),
      at('2026-01-01T10:00:05Z')
    );
  });

  it('is not moved by a rename or a retag', () => {
    const events = [
      imported('2026-01-01T10:00:05Z', 1),
      other('trackFileRenamed', '2026-02-01T00:00:00Z', 1),
      other('trackFileRetagged', '2026-03-01T00:00:00Z', 1),
      other('grabbed', '2026-04-01T00:00:00Z', 1),
    ];

    assert.strictEqual(
      came(events, [file('2026-01-01T10:00:00Z', 1)]),
      at('2026-01-01T10:00:05Z')
    );
  });

  it('is not moved by a missing track added', () => {
    const events = [
      imported('2026-01-01T10:00:05Z', 1),
      imported('2026-03-01T00:00:05Z', 2),
    ];

    assert.strictEqual(
      came(events, [
        file('2026-01-01T10:00:00Z', 1),
        file('2026-03-01T00:00:00Z', 2),
      ]),
      at('2026-01-01T10:00:05Z')
    );
  });

  it('does not take a coming-in dated after the mark of a held file whose import the history does not keep', () => {
    // track 1's file (held since January) has no record in the history; the
    // only import it keeps is of track 2, made while none was held in its view
    const events = [imported('2026-02-01T00:00:05Z', 2)];

    assert.strictEqual(
      came(events, [
        file('2026-01-01T00:00:00Z', 1),
        file('2026-02-01T00:00:00Z', 2),
      ]),
      at('2026-01-01T00:00:00Z')
    );
  });

  it('is the import that brought the album back after a file of it was removed and lost for good', () => {
    const events = [
      imported('2026-01-01T00:00:05Z', 1),
      deleted('2026-02-01T00:00:00Z', 1, 'Manual'),
      imported('2026-03-01T00:00:05Z', 1),
    ];

    assert.strictEqual(
      came(events, [file('2026-03-01T00:00:00Z', 1)]),
      at('2026-03-01T00:00:05Z')
    );
  });

  it('gives the earliest held file where the history has no event', () => {
    assert.strictEqual(
      came(
        [],
        [file('2026-02-01T00:00:00Z', 1), file('2026-01-15T00:00:00Z', 2)]
      ),
      at('2026-01-15T00:00:00Z')
    );
  });

  it('gives the earliest held file where the history has only other events', () => {
    assert.strictEqual(
      came(
        [other('grabbed', '2026-04-01T00:00:00Z', 1)],
        [file('2026-02-01T00:00:00Z', 1)]
      ),
      at('2026-02-01T00:00:00Z')
    );
  });

  it('gives null where no held file has a date', () => {
    assert.strictEqual(came([imported('2026-01-01T00:00:00Z', 1)], []), null);
    assert.strictEqual(
      came([imported('2026-01-01T00:00:00Z', 1)], [file('soon', 1)]),
      null
    );
  });

  it('replays the history by date, whatever the order it is given in', () => {
    const events = [
      imported('2026-03-01T00:00:05Z', 1),
      deleted('2026-02-01T00:00:00Z', 1, 'Manual'),
      imported('2026-01-01T00:00:05Z', 1),
    ];

    assert.strictEqual(
      came(events, [file('2026-03-01T00:00:00Z', 1)]),
      at('2026-03-01T00:00:05Z')
    );
  });

  it('replays events of one date by id', () => {
    // the delete first, then the import: the import is a coming-in
    assert.strictEqual(
      came(
        [
          imported('2026-01-01T00:00:05Z', 1, 1),
          deleted('2026-03-01T00:00:05Z', 1, 'Manual', 2),
          imported('2026-03-01T00:00:05Z', 1, 3),
        ],
        [file('2026-03-01T00:00:00Z', 1)]
      ),
      at('2026-03-01T00:00:05Z')
    );
    // the import first, then the delete: the import is a replacement, no more
    assert.strictEqual(
      came(
        [
          imported('2026-01-01T00:00:05Z', 1, 1),
          imported('2026-03-01T00:00:05Z', 1, 2),
          deleted('2026-03-01T00:00:05Z', 1, 'Manual', 3),
        ],
        [file('2026-03-01T00:00:00Z', 1)]
      ),
      at('2026-01-01T00:00:05Z')
    );
  });

  it("does not take a held file's mark from an older import of its track, dated before the file's dateAdded", () => {
    // track 1 imported in January and its file lost (Manual) in February;
    // track 2 imported in March (the album back); track 1's file found again
    // by a scan of the disk on March 5, no import of it in the history: the
    // album came back on March 1
    const events = [
      imported('2026-01-01T00:00:05Z', 1),
      deleted('2026-02-01T00:00:00Z', 1, 'Manual'),
      imported('2026-03-01T00:00:05Z', 2),
    ];

    assert.strictEqual(
      came(events, [
        file('2026-03-05T00:00:00Z', 1),
        file('2026-03-01T00:00:00Z', 2),
      ]),
      at('2026-03-01T00:00:05Z')
    );
  });

  it('replays events of one date by id, however the history is given', () => {
    // Lidarr answers newest first: import 3 and delete 2 (Manual) share one
    // second, after an import in January; the delete came first, so the import
    // brought the album back
    const events = [
      imported('2026-03-01T00:00:05Z', 1, 3),
      deleted('2026-03-01T00:00:05Z', 1, 'Manual', 2),
      imported('2026-01-01T00:00:05Z', 1, 1),
    ];

    assert.strictEqual(
      came(events, [file('2026-03-01T00:00:00Z', 1)]),
      at('2026-03-01T00:00:05Z')
    );
  });

  it('is moved by no event but an import and a delete (a rename, a retag, a grab) even with later imports after it', () => {
    for (const type of [
      'trackFileRenamed',
      'trackFileRetagged',
      'grabbed',
      'albumImportIncomplete',
    ]) {
      // track 1 imported in January, the other event on February 1, track 2
      // added in March, track 1 upgraded in April
      const events = [
        imported('2026-01-01T00:00:05Z', 1),
        other(type, '2026-02-01T00:00:00Z', 1),
        imported('2026-03-01T00:00:05Z', 2),
        deleted('2026-04-01T00:00:00Z', 1, 'Upgrade'),
        imported('2026-04-01T00:00:05Z', 1),
      ];

      assert.strictEqual(
        came(events, [
          file('2026-04-01T00:00:00Z', 1),
          file('2026-03-01T00:00:00Z', 2),
        ]),
        at('2026-01-01T00:00:05Z'),
        type
      );
    }
  });

  it('replays by date, not by id', () => {
    // import 1 is dated March, import 2 January (a lower id, a later date): by
    // date the January import brought the album in and the March one replaced
    // a file; by id the March import would have
    const events = [
      imported('2026-03-01T00:00:05Z', 1, 1),
      imported('2026-01-01T00:00:05Z', 1, 2),
    ];

    assert.strictEqual(
      came(events, [file('2026-03-01T00:00:00Z', 1)]),
      at('2026-01-01T00:00:05Z')
    );
  });

  it('keeps the other tracks held where one track loses its file', () => {
    // tracks 1 and 2 imported in January, track 1's file lost in February and
    // imported again on March 1: track 2 was held all the while, so March 1 is
    // no coming-in; track 2's file (re-found by a scan on March 10) has no
    // import record dated after its dateAdded
    const events = [
      imported('2026-01-01T00:00:05Z', 1),
      imported('2026-01-01T00:00:06Z', 2),
      deleted('2026-02-01T00:00:00Z', 1, 'Manual'),
      imported('2026-03-01T00:00:05Z', 1),
    ];

    assert.strictEqual(
      came(events, [
        file('2026-03-01T00:00:00Z', 1),
        file('2026-03-10T00:00:00Z', 2),
      ]),
      at('2026-01-01T00:00:05Z')
    );
  });

  it('takes no window on time: a coming-in a millisecond after the mark of a held file is not taken', () => {
    // track 1's file, held since February 1, has no record in the history;
    // track 2 was imported a millisecond later, while none was held in the
    // history's view
    const events = [imported('2026-02-01T00:00:00.001Z', 2)];

    assert.strictEqual(
      came(events, [
        file('2026-02-01T00:00:00.000Z', 1),
        file('2026-02-01T00:00:00.001Z', 2),
      ]),
      at('2026-02-01T00:00:00.000Z')
    );
  });

  it('ignores an event whose date cannot be read', () => {
    const events = [
      imported('2026-01-01T00:00:05Z', 1),
      deleted('not a date', 1, 'Manual'),
      imported('2026-03-01T00:00:05Z', 1),
    ];

    assert.strictEqual(
      came(events, [file('2026-03-01T00:00:00Z', 1)]),
      at('2026-01-01T00:00:05Z')
    );
  });

  it('counts an import that names no track as one track of its own', () => {
    // two imports with no track: both held, so the second is no coming-in
    const events = [
      imported('2026-01-01T00:00:05Z', undefined),
      imported('2026-02-01T00:00:05Z', undefined),
    ];

    assert.strictEqual(
      came(events, [
        file('2026-01-01T00:00:05Z'),
        file('2026-02-01T00:00:05Z'),
      ]),
      at('2026-01-01T00:00:05Z')
    );
  });

  it('stands albums of one import run by their own times', () => {
    const album1 = came(
      [imported('2026-05-01T12:00:10Z', 1)],
      [file('2026-05-01T12:00:00Z', 1)]
    );
    const album2 = came(
      [imported('2026-05-01T12:00:20Z', 2)],
      [file('2026-05-01T12:00:00Z', 2)]
    );

    assert.strictEqual(album1, at('2026-05-01T12:00:10Z'));
    assert.strictEqual(album2, at('2026-05-01T12:00:20Z'));
    assert.ok((album2 as number) > (album1 as number));
  });

  it('takes the file whose track was imported again as its own import record', () => {
    // track 1 imported in January, its file replaced (Upgrade) in May; track 2
    // lost its file and was imported in June while track 1's stayed: the album
    // was held all the while and stands at January
    const events = [
      imported('2026-01-01T00:00:05Z', 1),
      imported('2026-01-01T00:00:06Z', 2),
      deleted('2026-05-01T00:00:00Z', 1, 'Upgrade'),
      imported('2026-05-01T00:00:05Z', 1),
      deleted('2026-06-01T00:00:00Z', 2, 'Manual'),
      imported('2026-06-01T00:00:05Z', 2),
    ];

    assert.strictEqual(
      came(events, [
        file('2026-05-01T00:00:00Z', 1),
        file('2026-06-01T00:00:00Z', 2),
      ]),
      at('2026-01-01T00:00:05Z')
    );
  });
});

// Lidarr's own answers, recorded from the test Lidarr after manual imports into
// albums it held nothing of (lidarr-test v3.1.0.4875): its history of an album,
// the track files it holds and the tracks with the file each holds.
function recorded(albumN: number) {
  const read = <T>(name: string): T =>
    JSON.parse(
      readFileSync(
        join(__dirname, '../api/servarr/lidarr.fixtures', name),
        'utf8'
      )
    ) as T;
  const events = read<LidarrHistoryEvent[]>(`history-album-${albumN}.json`);
  const files = read<LidarrTrackFile[]>(
    `trackfiles-history-album-${albumN}.json`
  );
  const tracks = read<LidarrTrack[]>(`tracks-history-album-${albumN}.json`);
  const held: HeldFile[] = files.map((f) => ({
    id: f.id,
    dateAdded: f.dateAdded,
    trackIds: tracks.filter((t) => t.trackFileId === f.id).map((t) => t.id),
  }));
  const dates = (type: string) =>
    events
      .filter((e) => e.eventType === type)
      .map((e) => Date.parse(e.date))
      .sort((a, b) => a - b);

  return { events, held, dates, tracks };
}

describe('albumCameInAt over what Lidarr answers', () => {
  it('stands an album whose only file was deleted and imported again at the second import', () => {
    const { events, held, dates, tracks } = recorded(3);

    assert.strictEqual(dates('trackFileImported').length, 2);
    assert.strictEqual(
      albumCameInAt(
        events,
        held,
        tracks.map((t) => t.id)
      ),
      dates('trackFileImported')[1]
    );
  });

  it('does not move an album whose file Lidarr replaced (a delete of reason Upgrade)', () => {
    const { events, held, dates, tracks } = recorded(5);

    assert.strictEqual(
      events.find((e) => e.eventType === 'trackFileDeleted')?.data?.reason,
      'Upgrade'
    );
    assert.strictEqual(
      albumCameInAt(
        events,
        held,
        tracks.map((t) => t.id)
      ),
      dates('trackFileImported')[0]
    );
  });

  it('does not move an album given a second track', () => {
    const { events, held, dates, tracks } = recorded(4);

    assert.strictEqual(held.length, 2);
    assert.strictEqual(
      albumCameInAt(
        events,
        held,
        tracks.map((t) => t.id)
      ),
      dates('trackFileImported')[0]
    );
  });
});

// F2-D-561: Lidarr holds files only of an album's tracks now, and where it
// replaces an album's tracks it removes the files of the old ones writing no
// history; an Upgrade deletion holds the album only until the import that
// follows it, whatever track that is of; a held file's own import is the one
// whose data.fileId is its id.

const fixture = <T>(name: string): T =>
  JSON.parse(
    readFileSync(join(__dirname, 'albumCameInAt.fixtures', name), 'utf8')
  ) as T;

const importedFile = (
  date: string,
  trackId: number | undefined,
  fileId: number | string
): LidarrHistoryEvent => ({
  ...imported(date, trackId),
  data: { fileId },
});

describe('albumCameInAt after F2-D-561', () => {
  describe("an album whose tracks Lidarr replaced (F2-SD-10's case 2)", () => {
    it('stands at the second import where it was imported with tracks it no longer has, no deletion recorded, and again with its tracks now', () => {
      const events = [
        imported('2026-10-09T04:48:59Z', 11),
        imported('2026-10-09T04:48:59Z', 12),
        imported('2026-10-16T23:21:01Z', 13),
        imported('2026-10-16T23:21:01Z', 14),
      ];
      const held = [
        file('2026-10-16T23:21:01Z', 13),
        file('2026-10-16T23:21:01Z', 14),
      ];

      assert.strictEqual(
        albumCameInAt(events, held, [13, 14]),
        at('2026-10-16T23:21:01Z')
      );
      // the same history of an album that has kept its tracks is held since the
      // first import: the tracks the album has now decide
      assert.strictEqual(
        albumCameInAt(events, held, [11, 12, 13, 14]),
        at('2026-10-09T04:48:59Z')
      );
    });

    it("stands Greta Van Fleet 'Palace for the People' of the production export at the import of 2026-10-16T23:21:01Z", () => {
      const album = exported().find((a) => a.albumId === 12806);

      assert.ok(album);
      // the export holds no deletion for it and the old tracks' imports
      assert.ok(
        !album.events.some((e) => e.eventType === 'trackFileDeleted') &&
          album.events.some((e) => e.date === '2026-10-09T04:48:59Z')
      );
      assert.strictEqual(timeOf(album), at('2026-10-16T23:21:01Z'));
    });

    it('stands what the test Lidarr wrote after a release switch (no history of the removal) at the import of the tracks now', () => {
      const { events, held, tracks } = testLidarr('test-lidarr-release-switch');
      const importsOfNow = events.filter(
        (e) => e.trackId !== undefined && tracks.includes(e.trackId)
      );

      // the history holds imports of tracks the album no longer has, and no
      // deletion
      assert.ok(events.some((e) => !tracks.includes(e.trackId as number)));
      assert.ok(!events.some((e) => e.eventType === 'trackFileDeleted'));
      assert.ok(importsOfNow.length > 0);
      assert.strictEqual(
        albumCameInAt(events, held, tracks),
        Date.parse(importsOfNow[0].date)
      );
      assert.ok(Date.parse(importsOfNow[0].date) > Date.parse(events[0].date));
    });

    it('does not move an album whose old-track files Lidarr re-linked to its tracks now, a missing track imported later', () => {
      // files 10, 11 imported as tracks 1, 2 in March, re-linked to tracks 3,
      // 4 (their rows kept, their import records by data.fileId); track 5
      // imported in April
      const events = [
        importedFile('2026-03-01T00:00:05Z', 1, '10'),
        importedFile('2026-03-01T00:00:06Z', 2, '11'),
        importedFile('2026-04-01T00:00:05Z', 5, '12'),
      ];
      const held: HeldFile[] = [
        { id: 10, dateAdded: '2026-03-01T00:00:00Z', trackIds: [3] },
        { id: 11, dateAdded: '2026-03-01T00:00:00Z', trackIds: [4] },
        { id: 12, dateAdded: '2026-04-01T00:00:00Z', trackIds: [5] },
      ];

      assert.strictEqual(
        albumCameInAt(events, held, [3, 4, 5]),
        at('2026-03-01T00:00:05Z')
      );
    });

    it('takes a track the album has not as held no longer once a track it has is imported, and a missing track id as no track it has', () => {
      // an import naming no track, then an import of track 1 (the album's)
      const events = [
        imported('2026-01-01T00:00:05Z', undefined),
        imported('2026-02-01T00:00:05Z', 1),
      ];

      assert.strictEqual(
        albumCameInAt(events, [file('2026-02-01T00:00:00Z', 1)], [1]),
        at('2026-02-01T00:00:05Z')
      );
    });
  });

  describe('what removes the tracks the album no longer has', () => {
    // the files Lidarr holds were found by a scan of the disk in March (no
    // import record): the album's time is the latest coming-in before that
    const held = [file('2026-03-01T00:00:00Z', 5)];

    it('is only an import of a track the album has: an import of another track it no longer has removes nothing', () => {
      const events = [
        imported('2026-01-01T00:00:05Z', 1),
        imported('2026-02-01T00:00:05Z', 2),
      ];

      // tracks 1 and 2 are held together, so the import of track 2 is no
      // coming-in
      assert.strictEqual(
        albumCameInAt(events, held, [5]),
        at('2026-01-01T00:00:05Z')
      );
    });

    it('is not an import that names no track', () => {
      const events = [
        imported('2026-01-01T00:00:05Z', 1),
        imported('2026-02-01T00:00:05Z', undefined),
      ];

      assert.strictEqual(
        albumCameInAt(events, held, [5]),
        at('2026-01-01T00:00:05Z')
      );
    });

    it('is an import of a track the album has, whichever the tracks held', () => {
      const events = [
        imported('2026-01-01T00:00:05Z', 1),
        imported('2026-02-01T00:00:05Z', 5),
      ];

      assert.strictEqual(
        albumCameInAt(events, [file('2026-02-01T00:00:00Z', 5)], [5]),
        at('2026-02-01T00:00:05Z')
      );
    });
  });

  describe("QA S181's case: an Upgrade deletion of one track, the import of another", () => {
    it('stands an album emptied of its files and brought back by one import at that import', () => {
      const events = [
        imported('2026-01-01T00:00:05Z', 1),
        deleted('2026-01-02T00:00:00Z', 1, 'Upgrade'),
        imported('2026-01-02T00:00:02Z', 2),
        deleted('2026-02-01T00:00:00Z', 2, 'Manual'),
        imported('2026-03-01T00:00:05Z', 1),
      ];

      assert.strictEqual(
        albumCameInAt(events, [file('2026-03-01T00:00:00Z', 1)], [1, 2]),
        at('2026-03-01T00:00:05Z')
      );
    });

    it('stands what the test Lidarr wrote at the last import', () => {
      for (const name of [
        'test-lidarr-upgrade-then-other-track',
        'test-lidarr-upgrade-across-cycles',
      ]) {
        const { events, held, tracks } = testLidarr(name);
        const last = events
          .filter((e) => e.eventType === 'trackFileImported')
          .map((e) => Date.parse(e.date))
          .sort((a, b) => a - b)
          .pop();

        assert.ok(
          events.some((e) => e.data?.reason === 'Upgrade'),
          name
        );
        assert.strictEqual(albumCameInAt(events, held, tracks), last, name);
      }
    });

    it('leaves a replacement pending until the next import, whatever its track', () => {
      const events = [
        imported('2026-01-01T00:00:05Z', 1),
        deleted('2026-02-01T00:00:00Z', 1, 'Upgrade'),
        imported('2026-02-01T00:00:02Z', 2),
      ];

      assert.strictEqual(
        albumCameInAt(events, [file('2026-02-01T00:00:00Z', 2)], [1, 2]),
        at('2026-01-01T00:00:05Z')
      );
    });

    it('ends a pending replacement at the next import, so a later import into an emptied album is a coming-in', () => {
      // track 1 replaced (Upgrade) by an import of track 9 (the album has not),
      // which ends the replacement; the import of track 2 (the album's) then
      // removes track 9 and finds nothing held
      const events = [
        imported('2026-01-01T00:00:05Z', 1),
        deleted('2026-02-01T00:00:00Z', 1, 'Upgrade'),
        imported('2026-02-01T00:00:02Z', 9),
        imported('2026-03-01T00:00:05Z', 2),
      ];

      assert.strictEqual(
        albumCameInAt(events, [file('2026-03-01T00:00:00Z', 2)], [2]),
        at('2026-03-01T00:00:05Z')
      );
    });

    it('ends a pending replacement at a deletion of another reason', () => {
      // track 1 replaced (Upgrade), then track 2 lost (Manual): nothing is
      // held and nothing is pending, so the import of track 3 brought it back
      const events = [
        imported('2026-01-01T00:00:05Z', 1),
        imported('2026-01-01T00:00:06Z', 2),
        deleted('2026-02-01T00:00:00Z', 1, 'Upgrade'),
        deleted('2026-02-01T00:00:01Z', 2, 'Manual'),
        imported('2026-03-01T00:00:05Z', 3),
      ];

      assert.strictEqual(
        albumCameInAt(events, [file('2026-03-01T00:00:00Z', 3)], [1, 2, 3]),
        at('2026-03-01T00:00:05Z')
      );
    });

    it('never moves an album wholly upgraded, by the same tracks or by others', () => {
      for (const reason of ['Upgrade', 'ManualOverride']) {
        // by the same tracks
        const same = [
          imported('2026-01-01T00:00:05Z', 1),
          imported('2026-01-01T00:00:06Z', 2),
          deleted('2026-02-01T00:00:00Z', 1, reason),
          deleted('2026-02-01T00:00:00Z', 2, reason),
          imported('2026-02-01T00:00:03Z', 1),
          imported('2026-02-01T00:00:04Z', 2),
        ];
        // by others: each file replaced by a file of the other track
        const others = [
          imported('2026-01-01T00:00:05Z', 1),
          imported('2026-01-01T00:00:06Z', 2),
          deleted('2026-02-01T00:00:00Z', 1, reason),
          deleted('2026-02-01T00:00:00Z', 2, reason),
          imported('2026-02-01T00:00:03Z', 3),
          imported('2026-02-01T00:00:04Z', 4),
        ];

        assert.strictEqual(
          albumCameInAt(
            same,
            [file('2026-02-01T00:00:02Z', 1), file('2026-02-01T00:00:02Z', 2)],
            [1, 2]
          ),
          at('2026-01-01T00:00:05Z'),
          `same, ${reason}`
        );
        assert.strictEqual(
          albumCameInAt(
            others,
            [file('2026-02-01T00:00:02Z', 3), file('2026-02-01T00:00:02Z', 4)],
            [1, 2, 3, 4]
          ),
          at('2026-01-01T00:00:05Z'),
          `others, ${reason}`
        );
      }
    });
  });

  describe("a held file's own import record", () => {
    it("is read by data.fileId before the import of the file's tracks", () => {
      // file 7 (track 1, held since January) was imported 01-05; a later file of
      // track 1 (file 8, no longer held) was imported 02-05 after a deletion
      // the history gives: by the file's id its mark is 01-05, by its track it
      // would be 02-05 and the coming-in of 02-05 would be taken
      const events = [
        importedFile('2026-01-05T00:00:05Z', 1, 7),
        deleted('2026-02-04T00:00:00Z', 1, 'Manual'),
        importedFile('2026-02-05T00:00:05Z', 1, 8),
      ];
      const held: HeldFile[] = [
        { id: 7, dateAdded: '2026-01-01T00:00:00Z', trackIds: [1] },
      ];

      assert.strictEqual(
        albumCameInAt(events, held, [1]),
        at('2026-01-05T00:00:05Z')
      );
    });

    it('is read by data.fileId whether Lidarr gives it as a string or a number', () => {
      for (const fileId of ['7', 7]) {
        const events = [
          importedFile('2026-01-05T00:00:05Z', 1, fileId),
          deleted('2026-02-04T00:00:00Z', 1, 'Manual'),
          importedFile('2026-02-05T00:00:05Z', 1, 8),
        ];

        assert.strictEqual(
          albumCameInAt(
            events,
            [{ id: 7, dateAdded: '2026-01-01T00:00:00Z', trackIds: [1] }],
            [1]
          ),
          at('2026-01-05T00:00:05Z'),
          String(typeof fileId)
        );
      }
    });
  });

  describe('over the albums of the production export (F2-SD-10, F2-SD-11)', () => {
    const times = () =>
      exported()
        .map((album) => ({ album, time: timeOf(album) }))
        .sort((a, b) => b.time - a.time);
    const named = (title: string) => {
      const found = exported().find((a) => a.title === title);

      assert.ok(found, title);

      return found;
    };

    it('stands Echoes, Silence, Patience & Grace, Secret Garden and Cycles of Pain at their earliest held file (F2-SD-11), no import of them in the history', () => {
      for (const title of [
        'Echoes, Silence, Patience & Grace',
        'Secret Garden',
        'Cycles of Pain',
      ]) {
        const album = named(title);
        const earliest = Math.min(
          ...album.trackFiles.map((f) => Date.parse(f.dateAdded))
        );

        assert.ok(
          !album.events.some((e) => e.eventType === 'trackFileImported'),
          title
        );
        assert.ok(
          new Date(earliest).toISOString().startsWith('2026-10-17T22:49'),
          title
        );
        assert.strictEqual(timeOf(album), earliest, title);
      }
    });

    it("orders the albums as Lidarr's Track Imported history does after the three of F2-SD-11: Palace for the People, Divine Intervention, Atom Heart Mother, Netherworlds, Cleansing, Pure, Pandemonium", () => {
      const order = times().map(({ album }) => album.title);
      const first = order.slice(0, 3).sort();

      assert.deepStrictEqual(first, [
        'Cycles of Pain',
        'Echoes, Silence, Patience & Grace',
        'Secret Garden',
      ]);
      assert.deepStrictEqual(order.slice(3, 10), [
        'Palace for the People',
        'Divine Intervention',
        'Atom Heart Mother',
        'Netherworlds',
        'Cleansing',
        'Pure',
        'Pandemonium',
      ]);
      assert.strictEqual(
        timeOf(named('Palace for the People')),
        at('2026-10-16T23:21:01Z')
      );
    });
  });
});

// the production export's albums that hold a file, with their imports and
// deletions and their held files (ENVIRONMENT: read-only evidence)
interface ExportedAlbum {
  artist: string;
  albumId: number;
  title: string;
  events: LidarrHistoryEvent[];
  trackFiles: { id: number; dateAdded: string }[];
}

const exported = (): ExportedAlbum[] =>
  fixture<ExportedAlbum[]>('prod-export-albums.json');

// the export holds no getTracks answer: an album's tracks now are taken from
// its held files' import records by data.fileId, and each file's tracks too
function timeOf(album: ExportedAlbum): number {
  const trackOf = (fileId: number) =>
    album.events.find(
      (e) =>
        e.eventType === 'trackFileImported' &&
        String(e.data?.fileId) === String(fileId)
    )?.trackId;
  const held: HeldFile[] = album.trackFiles.map((f) => {
    const trackId = trackOf(f.id);

    return {
      id: f.id,
      dateAdded: f.dateAdded,
      trackIds: trackId === undefined ? [] : [trackId],
    };
  });

  return albumCameInAt(
    album.events,
    held,
    held.flatMap((f) => f.trackIds)
  ) as number;
}

// what the test Lidarr wrote and answered for an album (lidarr-test 3.1.0.4875)
function testLidarr(name: string) {
  const data = fixture<{
    events: LidarrHistoryEvent[];
    tracks: { id: number; trackFileId: number }[];
    trackFiles: { id: number; dateAdded: string }[];
  }>(`${name}.json`);
  const held: HeldFile[] = data.trackFiles.map((f) => ({
    id: f.id,
    dateAdded: f.dateAdded,
    trackIds: data.tracks
      .filter((t) => t.trackFileId === f.id)
      .map((t) => t.id),
  }));

  return {
    events: data.events,
    held,
    tracks: data.tracks.map((t) => t.id),
  };
}
