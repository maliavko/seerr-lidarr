import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isEndByPageCount,
  newLoadMark,
  newSearchAddress,
  readSearchType,
  searchLoadStep,
  searchTypeQuery,
  type LoadMark,
} from './searchLoading';

// F2-D-71: the end test and the load-on of the search page, its type and the
// addresses a pill and a new search give.
describe('isEndByPageCount', () => {
  it('is not the end on a short page before the last page', () => {
    assert.equal(isEndByPageCount([{ page: 1, totalPages: 5 }]), false);
    assert.equal(
      isEndByPageCount([
        { page: 1, totalPages: 5 },
        { page: 2, totalPages: 5 },
      ]),
      false
    );
  });

  it('is not the end on an emptied page before the last page', () => {
    assert.equal(isEndByPageCount([{ page: 3, totalPages: 4 }]), false);
  });

  it('is the end on the last page by the page count, short or not', () => {
    assert.equal(isEndByPageCount([{ page: 4, totalPages: 4 }]), true);
    assert.equal(isEndByPageCount([{ page: 1, totalPages: 1 }]), true);
  });

  it('is the end past the last page, and judges by the last page loaded only', () => {
    assert.equal(isEndByPageCount([{ page: 5, totalPages: 4 }]), true);
    assert.equal(
      isEndByPageCount([
        { page: 1, totalPages: 1 },
        { page: 2, totalPages: 3 },
      ]),
      false
    );
  });

  it('is not the end where nothing, or a page not yet loaded, is last', () => {
    assert.equal(isEndByPageCount(undefined), false);
    assert.equal(isEndByPageCount([]), false);
    assert.equal(
      isEndByPageCount([{ page: 1, totalPages: 1 }, undefined]),
      false
    );
  });
});

// a page: its number and page count; the titles shown are given apart
const pagesTo = (n: number, of: number) =>
  Array.from({ length: n }, (_, i) => ({ page: i + 1, totalPages: of }));

// feed the hook's renders: each settled load adds the titles given; the
// answer's mark and size are fed back, as the hook's effect does. Returns the
// sizes asked, and the mark after.
const run = (
  adds: number[],
  of: number,
  from: { mark?: LoadMark; size?: number; titles?: number } = {}
) => {
  let mark = from.mark ?? newLoadMark('k');
  let size = from.size ?? 3;
  let titles = from.titles ?? 0;
  const asked: number[] = [];

  // the first load (3 pages) or a scroll's (one page) settles with adds[0]
  // more titles, each load-on page with the next
  for (const add of adds) {
    titles += add;
    const answer = searchLoadStep({
      key: 'k',
      size,
      pages: pagesTo(size, of),
      titles,
      outstanding: false,
      mark,
    });
    mark = answer.mark;
    if (answer.size === undefined) {
      break;
    }
    asked.push(answer.size);
    size = answer.size;
  }

  return { asked, mark, size, titles };
};

describe('searchLoadStep', () => {
  const key = 'k';
  const step = (
    over: Partial<Parameters<typeof searchLoadStep>[0]> & { mark?: LoadMark }
  ) =>
    searchLoadStep({
      key,
      size: 3,
      pages: pagesTo(3, 10),
      titles: 0,
      outstanding: false,
      mark: newLoadMark(key),
      ...over,
    });

  it('loads on past short pages before the last', () => {
    assert.equal(step({ titles: 5 }).size, 4);
    assert.equal(step({ titles: 19 }).size, 4);
  });

  it('loads on past an emptied page', () => {
    assert.equal(step({ titles: 0 }).size, 4);
  });

  it("asks nothing while the list's last read failed, whatever the titles and pages", () => {
    assert.equal(step({ titles: 5, failed: true }).size, undefined);
    assert.equal(step({ titles: 0, failed: true }).size, undefined);
    assert.equal(
      step({ pages: pagesTo(1, 9), size: 1, failed: true }).size,
      undefined
    );
  });

  it('loads on again once the failed read is read again and its page has landed', () => {
    const failed = step({ pages: pagesTo(2, 10), titles: 5, failed: true });
    const retried = step({
      pages: pagesTo(3, 10),
      titles: 8,
      failed: false,
      mark: failed.mark,
    });

    assert.equal(failed.size, undefined);
    assert.equal(retried.size, 4);
  });

  it('does not load on at the last page, short or empty', () => {
    assert.equal(step({ pages: pagesTo(3, 3), titles: 4 }).size, undefined);
    assert.equal(step({ pages: pagesTo(3, 3), titles: 0 }).size, undefined);
    assert.equal(step({ pages: pagesTo(1, 1), size: 1 }).size, undefined);
  });

  it('counts the first load whole: 20 titles or more loads nothing on', () => {
    assert.equal(step({ titles: 20 }).size, undefined);
    assert.equal(step({ titles: 31 }).size, undefined);
  });

  it('counts the first load from 0: 15 titles load on only until 20 are shown', () => {
    const answer = run([15, 3, 4], 10);

    assert.deepEqual(answer.asked, [4, 5]);
    assert.equal(answer.titles, 22);
  });

  it('counts a run of load-on pages adding 8, 8 and 8 over the run, stopping after the third', () => {
    const answer = run([8, 8, 8, 8], 20);

    // 8, 16, 24: the third load-on page reaches 20, no fourth is asked
    assert.deepEqual(answer.asked, [4, 5]);
    assert.equal(answer.titles, 24);
  });

  it('counts a run adding 8 then 12 over the run, stopping after the second', () => {
    const answer = run([8, 12, 5], 20);

    assert.deepEqual(answer.asked, [4]);
    assert.equal(answer.titles, 20);
  });

  it('never counts per page: pages of 8 titles each do not go on past 20', () => {
    assert.deepEqual(run([8, 8, 8, 8, 8], 500).asked, [4, 5]);
  });

  it('begins a load a scroll asked at the titles shown before it', () => {
    // the first run stopped at 24 titles; a scroll loads page 4 adding 5
    const first = run([24], 20);
    assert.deepEqual(first.asked, []);

    const scrolled = searchLoadStep({
      key,
      size: 4,
      pages: pagesTo(4, 20),
      titles: 29,
      outstanding: false,
      mark: first.mark,
    });
    // 29 is 5 over 24: the run goes on, counting again from 24
    assert.equal(scrolled.size, 5);
    assert.equal(scrolled.mark.runStart, 24);

    const more = searchLoadStep({
      key,
      size: 5,
      pages: pagesTo(5, 20),
      titles: 44,
      outstanding: false,
      mark: scrolled.mark,
    });
    // 44 is 20 over 24: it stops
    assert.equal(more.size, undefined);
    assert.equal(more.mark.runStart, 24);
  });

  it('a scroll after a stopped run asks nothing where its page adds 20', () => {
    const first = run([24], 20);
    const scrolled = searchLoadStep({
      key,
      size: 4,
      pages: pagesTo(4, 20),
      titles: 44,
      outstanding: false,
      mark: first.mark,
    });

    assert.equal(scrolled.size, undefined);
  });

  it('reads the same settled pages once: the second read answers no size', () => {
    const first = step({ titles: 5 });
    const second = step({ titles: 5, mark: first.mark });

    assert.equal(first.size, 4);
    assert.equal(second.size, undefined);
    assert.deepEqual(second.mark, first.mark);
  });

  it('answers the mark unchanged and no size while a page is outstanding', () => {
    const mark: LoadMark = {
      key,
      runStart: 3,
      lastSettled: 7,
      pagesRead: 2,
      asked: 3,
    };
    const answer = step({ outstanding: true, titles: 5, mark });

    assert.equal(answer.size, undefined);
    assert.deepEqual(answer.mark, mark);
  });

  it('answers none where no page is loaded', () => {
    assert.equal(step({ pages: undefined }).size, undefined);
    assert.equal(step({ pages: [] }).size, undefined);
  });

  it('starts anew for another list: nothing read, run from 0', () => {
    const stale: LoadMark = {
      key: 'other',
      runStart: 50,
      lastSettled: 60,
      pagesRead: 3,
      asked: 3,
    };
    const answer = step({ titles: 5, mark: stale });

    assert.equal(answer.size, 4);
    assert.equal(answer.mark.key, key);
    assert.equal(answer.mark.runStart, 0);
  });

  it('takes a load of the size not asked as a load a scroll asked', () => {
    const mark: LoadMark = {
      key,
      runStart: 0,
      lastSettled: 10,
      pagesRead: 3,
      asked: 4,
    };
    // size 5 is not the size asked (4): a scroll's load, its run from 10
    const answer = step({
      size: 5,
      pages: pagesTo(5, 20),
      titles: 12,
      mark,
    });

    assert.equal(answer.mark.runStart, 10);
    assert.equal(answer.size, 6);
  });

  it('feeds its answer back over a whole run, reading each load once', () => {
    let mark = newLoadMark(key);
    const sizes: (number | undefined)[] = [];
    // first load: 3 pages, 4 titles; then load-on pages adding 6, 6, 6
    const loads: [number, number][] = [
      [3, 4],
      [4, 10],
      [5, 16],
      [6, 22],
    ];

    for (const [size, titles] of loads) {
      // each load is rendered twice
      for (let render = 0; render < 2; render++) {
        const answer = searchLoadStep({
          key,
          size,
          pages: pagesTo(size, 50),
          titles,
          outstanding: false,
          mark,
        });
        mark = answer.mark;
        sizes.push(answer.size);
      }
    }

    assert.deepEqual(sizes, [
      4,
      undefined,
      5,
      undefined,
      6,
      undefined,
      undefined,
      undefined,
    ]);
    assert.equal(mark.asked, undefined);
  });
});

describe('readSearchType', () => {
  const all = ['movie', 'tv', 'music', 'person'];

  it('reads movie, tv, music and person while shown', () => {
    for (const type of all) {
      assert.equal(readSearchType(type, all), type);
    }
  });

  it('reads a missing, unknown or repeated type as All', () => {
    assert.equal(readSearchType(undefined, all), undefined);
    assert.equal(readSearchType('', all), undefined);
    assert.equal(readSearchType('album', all), undefined);
    assert.equal(readSearchType('MOVIE', all), undefined);
    assert.equal(readSearchType(['movie', 'tv'], all), undefined);
  });

  it('reads a type not among the kinds shown as All', () => {
    assert.equal(readSearchType('movie', ['music']), undefined);
    assert.equal(readSearchType('music', ['music']), 'music');
    assert.equal(readSearchType('music', []), undefined);
  });
});

describe('searchTypeQuery', () => {
  it('keeps the query and sets the type', () => {
    assert.deepEqual(searchTypeQuery({ query: 'abba' }, 'music'), {
      query: 'abba',
      type: 'music',
    });
  });

  it('replaces the type already there', () => {
    assert.deepEqual(searchTypeQuery({ query: 'abba', type: 'tv' }, 'movie'), {
      query: 'abba',
      type: 'movie',
    });
  });

  it('removes the type for All, keeping the query', () => {
    assert.deepEqual(
      searchTypeQuery({ query: 'abba', type: 'tv' }, undefined),
      {
        query: 'abba',
      }
    );
  });
});

describe('newSearchAddress', () => {
  const at = (query: Record<string, string>, pathname = '/search') => ({
    pathname,
    query,
  });

  it('on /search sets the text and the kept type', () => {
    assert.deepEqual(newSearchAddress(at({ query: 'abba' }), 'abb', 'music'), {
      pathname: '/search',
      query: { query: 'abb', type: 'music' },
    });
  });

  it("on /search carries the kept type, never the address's own", () => {
    assert.deepEqual(
      newSearchAddress(at({ query: 'abba', type: 'movie' }), 'abb', 'music'),
      { pathname: '/search', query: { query: 'abb', type: 'music' } }
    );
  });

  it('on /search leaves the type out where none is kept, the address own type included', () => {
    assert.deepEqual(
      newSearchAddress(at({ query: 'abba', type: 'music' }), 'abb', undefined),
      { pathname: '/search', query: { query: 'abb' } }
    );
  });

  it('on /search keeps every other parameter and the pathname', () => {
    assert.deepEqual(
      newSearchAddress(at({ query: 'a', x: '1' }, '/search/x'), 'ab', 'tv'),
      { pathname: '/search/x', query: { query: 'ab', x: '1', type: 'tv' } }
    );
  });

  it('from another page goes to /search with the query and the kept type, nothing else', () => {
    assert.deepEqual(
      newSearchAddress(at({ id: '5', x: '1' }, '/movie/[id]'), 'abba', 'music'),
      { pathname: '/search', query: { type: 'music', query: 'abba' } }
    );
    assert.deepEqual(
      newSearchAddress(at({ id: '5' }, '/'), 'abba', undefined),
      { pathname: '/search', query: { query: 'abba' } }
    );
  });

  it('carries the kept type whatever the kinds shown, as kept', () => {
    assert.deepEqual(newSearchAddress(at({}, '/'), 'abba', 'person'), {
      pathname: '/search',
      query: { type: 'person', query: 'abba' },
    });
  });
});
