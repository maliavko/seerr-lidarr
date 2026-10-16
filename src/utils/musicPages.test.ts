import axios, { AxiosError } from 'axios';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { createElement } from 'react';
import { loadClient, renderClient } from './musicTestSupport';

// The pages /music/artist/[mbid] and /music/album/[mbid]: what they fetch, and
// what they show for an answer, a 404 and a failure (R-14).
type Page = {
  default: (props: never) => React.ReactNode;
  getServerSideProps: (
    ctx: never
  ) => Promise<{ props: Record<string, unknown> }>;
};

const pages = {
  artist: 'pages/music/artist/[mbid]',
  album: 'pages/music/album/[mbid]',
} as const;

const ctx = (mbid: string) =>
  ({ query: { mbid }, req: { headers: { cookie: 'connect.sid=1' } } }) as never;

const failure = (status?: number) =>
  status === undefined
    ? new Error('connection refused')
    : new AxiosError('failed', 'ERR_BAD_RESPONSE', undefined, undefined, {
        status,
      } as never);

afterEach(() => mock.restoreAll());

for (const kind of ['artist', 'album'] as const) {
  describe(`the ${kind} page`, () => {
    const load = () => loadClient<Page>(pages[kind]);

    it(`fetches /api/v1/music/${kind}/:mbid with the user's cookie and hands the answer to the page`, async () => {
      const get = mock.method(axios, 'get', async () => ({
        data: { id: 'x', name: 'N' },
      }));
      const { props } = await load().getServerSideProps(ctx('mbid-1'));

      assert.deepEqual(props, { [kind]: { id: 'x', name: 'N' } });
      assert.match(
        String(get.mock.calls[0].arguments[0]),
        new RegExp(`/api/v1/music/${kind}/mbid-1$`)
      );
      assert.deepEqual(get.mock.calls[0].arguments[1], {
        headers: { cookie: 'connect.sid=1' },
      });
    });

    it('passes a 404 and a 500 of the route on, and any other failure as 500, and does not throw', async () => {
      const results: unknown[] = [];

      for (const error of [failure(404), failure(500), failure()]) {
        mock.method(axios, 'get', async () => {
          throw error;
        });
        results.push((await load().getServerSideProps(ctx('m'))).props);
        mock.restoreAll();
      }

      assert.deepEqual(results, [
        { statusCode: 404 },
        { statusCode: 500 },
        { statusCode: 500 },
      ]);
    });

    it('shows the not-found page for a 404 and the error page for a 500', async () => {
      const Page = load().default;
      const show = (statusCode: number) =>
        renderClient(
          () => createElement(Page as never, { statusCode } as never),
          { mbid: 'm' }
        );

      assert.match(await show(404), /404 - Something Went Wrong/);
      assert.match(await show(500), /500 - Internal Server Error/);
    });
  });
}

describe('the pages show what their route answered', () => {
  it('shows the artist and the album', async () => {
    const artistPage = loadClient<Page>(pages.artist).default;
    const albumPage = loadClient<Page>(pages.album).default;

    assert.match(
      await renderClient(
        () =>
          createElement(
            artistPage as never,
            {
              artist: { id: 'a', name: 'Radiohead', genres: [], albums: [] },
            } as never
          ),
        { mbid: 'a' }
      ),
      /data-testid="media-title">Radiohead</
    );
    assert.match(
      await renderClient(
        () =>
          createElement(
            albumPage as never,
            {
              album: {
                id: 'b',
                title: 'Kid A',
                artist: { id: 'a', name: 'Radiohead' },
                genres: [],
                tracks: [],
              },
            } as never
          ),
        { mbid: 'b' }
      ),
      /data-testid="media-title">Kid A/
    );
  });
});
