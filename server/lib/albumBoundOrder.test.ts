import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BoundAlbum, ImportRecord } from './albumBoundOrder';
import { nextAlbumsByBound } from './albumBoundOrder';

// The order Recently Added visits albums in (F2-D-311): by a bound no album's
// time exceeds, reading Lidarr's import history only as deep as the order needs.

const day = (n: number) => Date.parse('2026-01-01T00:00:00Z') + n * 86_400_000;

const album = (id: number, earliestDay: number | null): BoundAlbum => ({
  id,
  index: id,
  earliest: earliestDay === null ? null : day(earliestDay),
});

const record = (albumId: number, atDay: number): ImportRecord => ({
  albumId,
  at: day(atDay),
});

const idsOf = (order: ReturnType<typeof nextAlbumsByBound>) =>
  order.next.map(({ album: a }) => a.id);

const args = (
  albums: BoundAlbum[],
  imports: ImportRecord[],
  complete: boolean,
  extra: { visited?: Set<number>; count?: number } = {}
) => ({
  albums,
  imports,
  complete,
  visited: extra.visited ?? new Set<number>(),
  count: extra.count ?? 5,
});

describe('nextAlbumsByBound', () => {
  it('reads an album whose latest import is later than its earliest held file before one whose earliest held file alone is later', () => {
    // album 1: earliest file day 10, re-imported day 50 (bound 50); album 2:
    // earliest file day 30, imported day 30 (bound 30); album 3: file day 40
    // found by a scan, no import in the history (bound 40)
    const albums = [album(1, 10), album(2, 30), album(3, 40)];
    const imports = [record(1, 50), record(2, 30)];

    assert.deepStrictEqual(
      idsOf(nextAlbumsByBound(args(albums, imports, true))),
      [1, 3, 2]
    );
  });

  it("takes an album's bound as its earliest file where that is later than its latest import", () => {
    const albums = [album(1, 60), album(2, 30)];
    const imports = [record(1, 20), record(2, 30)];
    const order = nextAlbumsByBound(args(albums, imports, true));

    assert.deepStrictEqual(idsOf(order), [1, 2]);
    assert.deepStrictEqual(
      order.next.map((n) => n.bound),
      [day(60), day(30)]
    );
  });

  it('orders equal bounds in Lidarr order', () => {
    const albums = [album(3, 10), album(1, 10), album(2, 10)].map((a, i) => ({
      ...a,
      index: i,
    }));

    assert.deepStrictEqual(
      idsOf(nextAlbumsByBound(args(albums, [], true))),
      [3, 1, 2]
    );
  });

  it('leaves out the albums already read and gives at most the count asked', () => {
    const albums = [1, 2, 3, 4, 5, 6, 7].map((id) => album(id, id));
    const order = nextAlbumsByBound(
      args(albums, [], true, { visited: new Set([7, 6]), count: 3 })
    );

    assert.deepStrictEqual(idsOf(order), [5, 4, 3]);
    assert.strictEqual(order.needPage, false);
  });

  it('places an album whose earliest file is dated as the last import read, asking no further page', () => {
    // pages read back to day 20 (album 3's import); album 2 (not seen, earliest
    // file on day 20) has a bound of day 20, no page can lift it above that
    const albums = [album(1, 40), album(2, 20), album(3, 10)];
    const imports = [record(1, 40), record(3, 20)];
    const order = nextAlbumsByBound(args(albums, imports, false));

    assert.deepStrictEqual(idsOf(order), [1, 2, 3]);
    assert.strictEqual(order.needPage, false);
  });

  it('gives the latest bound an album not given can have', () => {
    const albums = [album(1, 50), album(2, 40), album(3, 30)];
    const order = nextAlbumsByBound(args(albums, [], true, { count: 2 }));

    assert.deepStrictEqual(idsOf(order), [1, 2]);
    assert.strictEqual(order.ceiling, day(30));
  });

  it('asks a page where nothing has been read', () => {
    const order = nextAlbumsByBound(args([album(1, 10)], [], false));

    assert.strictEqual(order.needPage, true);
    assert.deepStrictEqual(idsOf(order), []);
  });

  it('asks no further page where an album is placed from the pages read', () => {
    // pages reach back to day 40: album 1 was seen (bound 50) and album 2's
    // earliest file (day 45) is later than any import not yet read
    const albums = [album(1, 10), album(2, 45), album(3, 5)];
    const imports = [record(1, 50), record(9, 42), record(9, 40)];
    const order = nextAlbumsByBound(args(albums, imports, false));

    assert.deepStrictEqual(idsOf(order), [1, 2]);
    assert.strictEqual(order.needPage, false);
  });

  it('asks a further page where every album left may have an import not yet read', () => {
    // pages reach back to day 40; album 2's earliest file is earlier, so its
    // latest import may be as late as day 40
    const albums = [album(2, 30), album(3, 5)];
    const imports = [record(1, 50), record(1, 40)];
    const order = nextAlbumsByBound(args(albums, imports, false));

    assert.deepStrictEqual(idsOf(order), []);
    assert.strictEqual(order.needPage, true);
    assert.strictEqual(order.ceiling, day(40));
  });

  it('holds back an album a page not yet read could still move', () => {
    // album 3 (earliest file day 20, no import seen) may have an import on day
    // 40 or later in the pages not read: album 2 (bound 41) is certain, album 3
    // is not
    const albums = [album(3, 20), album(2, 41)];
    const imports = [record(2, 41), record(2, 40)];
    const order = nextAlbumsByBound(args(albums, imports, false));

    assert.deepStrictEqual(idsOf(order), [2]);
    assert.strictEqual(order.needPage, false);
  });

  it('places the albums never imported by their earliest file once the last page is read', () => {
    const albums = [album(1, 10), album(2, null), album(3, 30)];
    const order = nextAlbumsByBound(args(albums, [record(1, 5)], true));

    assert.deepStrictEqual(idsOf(order), [3, 1, 2]);
    assert.strictEqual(order.next[2].bound, -Infinity);
  });

  it('ignores an import of an album it was not given', () => {
    const order = nextAlbumsByBound(
      args([album(1, 10)], [record(99, 80)], true)
    );

    assert.deepStrictEqual(idsOf(order), [1]);
    assert.strictEqual(order.next[0].bound, day(10));
  });

  it('is done where every album is read', () => {
    const order = nextAlbumsByBound(
      args([album(1, 10)], [record(1, 10)], true, {
        visited: new Set([1]),
      })
    );

    assert.deepStrictEqual(idsOf(order), []);
    assert.strictEqual(order.needPage, false);
  });
});
