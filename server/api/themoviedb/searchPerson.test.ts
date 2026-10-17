import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import ExternalAPI from '@server/api/externalapi';
import TheMovieDb from '@server/api/themoviedb';

type Getter = { get: (...args: unknown[]) => Promise<unknown> };
const proto = ExternalAPI.prototype as unknown as Getter;

describe('TheMovieDb.searchPerson', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('reads /search/person with the query, the page, adult off and the language, and answers what TMDB answers', async () => {
    const answer = {
      page: 2,
      total_pages: 9,
      total_results: 170,
      results: [{ id: 1, name: 'Person' }],
    };
    const get = mock.method(proto, 'get', async () => answer);

    const res = await new TheMovieDb().searchPerson({
      query: 'keanu',
      page: 2,
      language: 'de',
    });

    assert.deepStrictEqual(res, answer);
    assert.strictEqual(get.mock.callCount(), 1);
    assert.deepStrictEqual(get.mock.calls[0].arguments, [
      '/search/person',
      {
        params: {
          query: 'keanu',
          page: 2,
          include_adult: false,
          language: 'de',
        },
      },
    ]);
  });

  it('answers an empty page 1 of 1 where TMDB fails, as searchMovies does', async () => {
    mock.method(
      ExternalAPI.prototype,
      'get' as never,
      (async () => {
        throw new Error('TMDB is down');
      }) as never
    );

    const res = await new TheMovieDb().searchPerson({ query: 'keanu' });

    assert.deepStrictEqual(res, {
      page: 1,
      results: [],
      total_pages: 1,
      total_results: 0,
    });
  });

  it('asks for page 1 where none is given', async () => {
    const get = mock.method(proto, 'get', async () => ({}));

    await new TheMovieDb().searchPerson({ query: 'keanu' });

    assert.strictEqual(
      (get.mock.calls[0].arguments[1] as { params: { page: number } }).params
        .page,
      1
    );
  });
});
