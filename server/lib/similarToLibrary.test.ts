import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  pickSpread,
  rankSimilarToLibrary,
  SIMILAR_TO_LIBRARY_LIMIT,
} from '@server/lib/similarToLibrary';

const artists = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1 }));

describe('pickSpread', () => {
  it('gives all of them, ordered by Lidarr id, where there are 30 or fewer', () => {
    assert.deepStrictEqual(pickSpread([{ id: 3 }, { id: 1 }, { id: 2 }], 30), [
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ]);
    assert.strictEqual(pickSpread(artists(30), 30).length, 30);
    assert.deepStrictEqual(pickSpread([], 30), []);
  });

  it('takes the 30 at index floor(i * n / 30) of the list ordered by id where there are more', () => {
    const picked = pickSpread([...artists(100)].reverse(), 30);

    assert.deepStrictEqual(
      picked.map((a) => a.id),
      Array.from({ length: 30 }, (_, i) => Math.floor((i * 100) / 30) + 1)
    );
  });

  it('is spread from the oldest artist to near the newest, not the newest only', () => {
    const picked = pickSpread(artists(1000), 30).map((a) => a.id);

    assert.strictEqual(picked[0], 1);
    assert.ok(picked[29] > 950);
    assert.ok(picked[15] > 450 && picked[15] < 550);
  });

  it('is the same part at every call, whatever order Lidarr answers in', () => {
    const forward = pickSpread(artists(77), 30);

    assert.deepStrictEqual(pickSpread([...artists(77)].reverse(), 30), forward);
    assert.deepStrictEqual(pickSpread(artists(77), 30), forward);
  });

  it('has no artist twice', () => {
    for (const n of [31, 45, 59, 60, 61, 100, 1000]) {
      const ids = pickSpread(artists(n), 30).map((a) => a.id);

      assert.strictEqual(new Set(ids).size, 30, `n = ${n}`);
    }
  });

  it('puts an artist with no id last, keeping the order of such', () => {
    const picked = pickSpread(
      [
        { id: undefined, n: 'x' },
        { id: 2 },
        { id: undefined, n: 'y' },
        { id: 1 },
      ],
      30
    );

    assert.deepStrictEqual(picked, [
      { id: 1 },
      { id: 2 },
      { id: undefined, n: 'x' },
      { id: undefined, n: 'y' },
    ]);
  });
});

describe('rankSimilarToLibrary', () => {
  const sim = (mbid: string, score: number, name = mbid) => ({
    mbid,
    name,
    score,
  });

  it('leaves out every artist whose id is in the library', () => {
    const ranked = rankSimilarToLibrary(
      [{ similar: [sim('held', 99), sim('b', 1)] }],
      ['held', 'other']
    );

    assert.deepStrictEqual(
      ranked.map((r) => r.mbid),
      ['b']
    );
  });

  it('leaves out an artist the library holds though it is not one of those read', () => {
    // libraryIds is the whole library: 'unread' was never one of the answers
    const ranked = rankSimilarToLibrary(
      [{ similar: [sim('unread', 99), sim('b', 1)] }],
      ['read', 'unread']
    );

    assert.deepStrictEqual(
      ranked.map((r) => r.mbid),
      ['b']
    );
  });

  it('puts the artist similar to more of the read artists first, before the better score', () => {
    const ranked = rankSimilarToLibrary(
      [
        { similar: [sim('a', 1), sim('b', 90)] },
        { similar: [sim('a', 2)] },
        { similar: [sim('c', 100)] },
      ],
      []
    );

    assert.deepStrictEqual(
      ranked.map((r) => [r.mbid, r.count, r.score]),
      [
        ['a', 2, 2],
        ['c', 1, 100],
        ['b', 1, 90],
      ]
    );
  });

  it('puts equal counts by the higher best score, then by id', () => {
    const ranked = rankSimilarToLibrary(
      [{ similar: [sim('z', 5), sim('y', 5), sim('x', 5), sim('w', 9)] }],
      []
    );

    assert.deepStrictEqual(
      ranked.map((r) => r.mbid),
      ['w', 'x', 'y', 'z']
    );
  });

  it('keeps the best score of an artist across the answers, and the name of that entry', () => {
    const ranked = rankSimilarToLibrary(
      [
        { similar: [sim('a', 3, 'low')] },
        { similar: [sim('a', 8, 'high')] },
        { similar: [sim('a', 5, 'mid')] },
      ],
      []
    );

    assert.deepStrictEqual(ranked, [
      { mbid: 'a', name: 'high', score: 8, count: 3 },
    ]);
  });

  it('counts an artist once for a read artist that lists it twice', () => {
    const ranked = rankSimilarToLibrary(
      [{ similar: [sim('a', 3), sim('a', 4)] }],
      []
    );

    assert.deepStrictEqual(ranked, [
      { mbid: 'a', name: 'a', score: 4, count: 1 },
    ]);
  });

  it('gives at most 20', () => {
    const ranked = rankSimilarToLibrary(
      [
        {
          similar: Array.from({ length: 30 }, (_, i) =>
            sim(`m${String(i).padStart(2, '0')}`, i)
          ),
        },
      ],
      []
    );

    assert.strictEqual(SIMILAR_TO_LIBRARY_LIMIT, 20);
    assert.strictEqual(ranked.length, 20);
    assert.strictEqual(ranked[0].mbid, 'm29');
    assert.strictEqual(ranked[19].mbid, 'm10');
  });

  it('gives none for no answers or answers with nothing outside the library', () => {
    assert.deepStrictEqual(rankSimilarToLibrary([], ['a']), []);
    assert.deepStrictEqual(
      rankSimilarToLibrary(
        [{ similar: [sim('a', 1)] }, { similar: [] }],
        ['a']
      ),
      []
    );
  });
});
