import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import TheMovieDb from '@server/api/themoviedb';
import { findSearchProvider, isNotFound } from '@server/lib/search';
import { MethodStubs } from '@server/test/musicRows';

const status = (code: number) =>
  Object.assign(new Error(`Request failed with status code ${code}`), {
    response: { status: code },
  });

describe('isNotFound (F2-D-401)', () => {
  it('reads TMDB not found, HTTP 404, from the error or from its cause', () => {
    assert.strictEqual(isNotFound(status(404)), true);
    assert.strictEqual(
      isNotFound(new Error('[TMDB] Failed', { cause: status(404) })),
      true
    );
    assert.strictEqual(
      isNotFound(
        new Error('outer', {
          cause: new Error('inner', { cause: status(404) }),
        })
      ),
      true
    );
  });

  it('reads every other failure as no not found', () => {
    assert.strictEqual(isNotFound(status(500)), false);
    assert.strictEqual(isNotFound(status(401)), false);
    assert.strictEqual(
      isNotFound(new Error('[TMDB] Failed', { cause: status(503) })),
      false
    );
    assert.strictEqual(isNotFound(new Error('ECONNREFUSED')), false);
    assert.strictEqual(isNotFound(undefined), false);
    assert.strictEqual(isNotFound('404'), false);
  });
});

const emptyPage = { page: 1, results: [], total_pages: 1, total_results: 0 };

describe("the id providers' failed reads (F2-D-401)", () => {
  const stubs = new MethodStubs();

  afterEach(() => stubs.restore());

  it('year: sets failOnError on both of its TMDB searches and reports each failed one by its kind', async () => {
    const movies = stubs.stub(
      TheMovieDb.prototype,
      'searchMovies',
      async () => {
        throw new Error('TMDB is down');
      }
    );
    const shows = stubs.stub(
      TheMovieDb.prototype,
      'searchTvShows',
      async () => emptyPage
    );

    const provider = findSearchProvider('matrix year:1999');
    assert.ok(provider);
    const answer = await provider.search({
      id: '1999',
      query: 'matrix year:1999',
    });

    assert.strictEqual(
      (movies.calls[0][0] as { failOnError?: boolean }).failOnError,
      true
    );
    assert.strictEqual(
      (shows.calls[0][0] as { failOnError?: boolean }).failOnError,
      true
    );
    assert.deepStrictEqual(
      answer.failures?.map((failure) => failure.kind),
      ['movie']
    );
    assert.deepStrictEqual(answer.results, []);
  });

  it('year: reports no failure where both searches answer', async () => {
    stubs.stub(TheMovieDb.prototype, 'searchMovies', async () => emptyPage);
    stubs.stub(TheMovieDb.prototype, 'searchTvShows', async () => emptyPage);

    const provider = findSearchProvider('year:1999');
    assert.ok(provider);

    assert.deepStrictEqual(
      (await provider.search({ id: '1999', query: 'year:1999' })).failures,
      []
    );
  });

  it('tmdb: reports a read failing other than by 404 by its kind, and no read answered 404', async () => {
    stubs.stub(TheMovieDb.prototype, 'getMovie', async () => {
      throw new Error('[TMDB] Failed', { cause: status(500) });
    });
    stubs.stub(TheMovieDb.prototype, 'getTvShow', async () => {
      throw new Error('[TMDB] Failed', { cause: status(404) });
    });
    stubs.stub(TheMovieDb.prototype, 'getPerson', async () => {
      throw status(404);
    });

    const provider = findSearchProvider('tmdb:603');
    assert.ok(provider);
    const answer = await provider.search({ id: '603' });

    assert.deepStrictEqual(
      answer.failures?.map((failure) => failure.kind),
      ['movie']
    );
    assert.deepStrictEqual(answer.results, []);
  });

  it('tmdb: with all three reads answering 404 reports no failure and no results', async () => {
    for (const method of ['getMovie', 'getTvShow', 'getPerson'] as const) {
      stubs.stub(TheMovieDb.prototype, method, async () => {
        throw new Error('[TMDB] Failed', { cause: status(404) });
      });
    }

    const provider = findSearchProvider('tmdb:603');
    assert.ok(provider);
    const answer = await provider.search({ id: '603' });

    assert.deepStrictEqual(answer.failures, []);
    assert.deepStrictEqual(answer.results, []);
  });
});
