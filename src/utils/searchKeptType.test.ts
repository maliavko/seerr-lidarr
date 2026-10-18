import type { KindShown } from '@server/lib/kindsShown';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  KEPT_SEARCH_TYPE_KEY,
  readKeptSearchType,
  recordKeptSearchType,
} from './searchKeptType';

const store = (initial: Record<string, string> = {}) => {
  const data = { ...initial };

  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
};

const throwing = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

describe('the search type kept for the tab', () => {
  it('records each type under one key, and all for All', () => {
    for (const type of ['movie', 'tv', 'music', 'person'] as KindShown[]) {
      const s = store();
      recordKeptSearchType(s, type);
      assert.deepEqual(s.data, { [KEPT_SEARCH_TYPE_KEY]: type });
    }
    const s = store();
    recordKeptSearchType(s, undefined);
    assert.deepEqual(s.data, { [KEPT_SEARCH_TYPE_KEY]: 'all' });
  });

  it('a later press replaces the earlier one', () => {
    const s = store();
    recordKeptSearchType(s, 'music');
    recordKeptSearchType(s, undefined);
    assert.equal(readKeptSearchType(s), undefined);
    recordKeptSearchType(s, 'tv');
    assert.equal(readKeptSearchType(s), 'tv');
  });

  it('reads movie, tv, music and person as stored', () => {
    for (const type of ['movie', 'tv', 'music', 'person']) {
      assert.equal(
        readKeptSearchType(store({ [KEPT_SEARCH_TYPE_KEY]: type })),
        type
      );
    }
  });

  it('reads all, nothing stored and any other value as nothing', () => {
    assert.equal(
      readKeptSearchType(store({ [KEPT_SEARCH_TYPE_KEY]: 'all' })),
      undefined
    );
    assert.equal(readKeptSearchType(store()), undefined);
    for (const value of ['', 'Music', 'album', 'artist', 'null', ' music']) {
      assert.equal(
        readKeptSearchType(store({ [KEPT_SEARCH_TYPE_KEY]: value })),
        undefined
      );
    }
  });

  it('reads a type stored under another key as nothing', () => {
    assert.equal(readKeptSearchType(store({ other: 'music' })), undefined);
  });

  it('reads a throwing or missing storage as nothing, and records nothing without throwing', () => {
    assert.equal(readKeptSearchType(throwing), undefined);
    assert.equal(readKeptSearchType(undefined), undefined);
    assert.equal(readKeptSearchType(null), undefined);
    assert.doesNotThrow(() => recordKeptSearchType(throwing, 'music'));
    assert.doesNotThrow(() => recordKeptSearchType(undefined, 'music'));
  });
});
