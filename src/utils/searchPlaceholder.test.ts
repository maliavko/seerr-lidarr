import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { getSearchPlaceholderKey } from './searchPlaceholder';

const en = JSON.parse(
  readFileSync(
    path.join(process.cwd(), 'src', 'i18n', 'locale', 'en.json'),
    'utf8'
  )
) as Record<string, string>;

const prefix = 'components.Layout.SearchInput.';

// [kinds shown, key, words]
const sets: [string[], string, string][] = [
  [
    ['movie', 'tv', 'music'],
    'searchPlaceholderAll',
    'Search Movies, Series & Music',
  ],
  [['movie', 'tv'], 'searchPlaceholder', 'Search Movies & Series'],
  [['movie', 'music'], 'searchPlaceholderMoviesMusic', 'Search Movies & Music'],
  [['tv', 'music'], 'searchPlaceholderSeriesMusic', 'Search Series & Music'],
  [['movie'], 'searchPlaceholderMovies', 'Search Movies'],
  [['tv'], 'searchPlaceholderSeries', 'Search Series'],
  [['music'], 'searchPlaceholderMusic', 'Search Music'],
  [[], 'searchPlaceholderNone', 'Search'],
];

describe('the search box placeholder by the kinds shown (F2-D-131)', () => {
  for (const [kinds, key, words] of sets) {
    const label = kinds.length ? kinds.join(', ') : 'none';

    it(`${label}: ${key}`, () => {
      assert.equal(getSearchPlaceholderKey(kinds), key);
    });

    it(`${label}: person changes nothing`, () => {
      assert.equal(getSearchPlaceholderKey([...kinds, 'person']), key);
      assert.equal(getSearchPlaceholderKey(['person', ...kinds]), key);
    });

    it(`${label}: order changes nothing`, () => {
      assert.equal(getSearchPlaceholderKey([...kinds].reverse()), key);
      assert.equal(
        getSearchPlaceholderKey(['person', ...[...kinds].reverse()]),
        key
      );
    });

    it(`${label}: en.json says "${words}"`, () => {
      assert.equal(en[prefix + key], words);
    });
  }

  it('anything else than movie, tv and music is ignored', () => {
    assert.equal(
      getSearchPlaceholderKey(['person', 'artist', 'x']),
      'searchPlaceholderNone'
    );
  });

  it('the eight keys are distinct', () => {
    assert.equal(new Set(sets.map(([, key]) => key)).size, 8);
  });
});
