import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
  MusicKind,
} from '@server/constants/media';
import { Permission } from '@server/lib/permissions';
import axios from 'axios';
import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createElement } from 'react';
import { SWRConfig } from 'swr';
import {
  canEditMusicRequest,
  musicRequestEditBody,
  musicRequestTarget,
} from './musicRequests';
import { loadClient, renderClient } from './musicTestSupport';

// The requests lists' music row and card (R-12, R-9's actions there, R-14,
// D-311's edit): what they show of a music request, from the music routes'
// answers, and which actions each user is offered.
// The row and the card read the music routes once they are in view: the
// observer is put in place of the library's, which static markup cannot drive.
const observerPath = require.resolve('react-intersection-observer');
require.cache[observerPath] = {
  id: observerPath,
  filename: observerPath,
  loaded: true,
  exports: {
    useInView: () => ({ ref: () => {}, inView: true, entry: undefined }),
  },
} as never;

// The edit modal's frame and the library's listbox are put in place of the
// real ones so the modal's content can be rendered statically: the frame keeps
// its props (what its OK and its secondary button do, their texts), the
// listbox shows its options and keeps its value.
type ModalProps = Record<string, unknown> & {
  onOk?: () => Promise<void>;
  onSecondary?: () => Promise<void>;
};
let modal: ModalProps = {};
const stubModule = (file: string, exports: Record<string, unknown>) => {
  require.cache[file] = {
    id: file,
    filename: file,
    loaded: true,
    exports: { __esModule: true, ...exports },
  } as never;
};
stubModule(path.join(__dirname, '../components/Common/Modal/index.tsx'), {
  default: (props: ModalProps & { children?: React.ReactNode }) => {
    modal = props;

    return createElement('div', { 'data-testid': 'modal' }, props.children);
  },
});
const headlessPath = require.resolve('@headlessui/react');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const headless = require(headlessPath) as Record<string, unknown>;
type Children = React.ReactNode | ((state: unknown) => React.ReactNode);
const unwrap = (children: Children, state: unknown): React.ReactNode =>
  typeof children === 'function' ? children(state) : children;
stubModule(headlessPath, {
  ...headless,
  Listbox: ({ children }: { children: Children }) =>
    createElement('div', null, unwrap(children, { open: true })),
  ListboxButton: ({ children }: { children: React.ReactNode }) =>
    createElement('button', null, children),
  ListboxOptions: ({ children }: { children: React.ReactNode }) =>
    createElement('ul', { 'data-testid': 'requester-options' }, children),
  ListboxOption: ({ children }: { children: Children }) =>
    createElement(
      'li',
      { 'data-testid': 'requester-option' },
      unwrap(children, { selected: false, active: false })
    ),
  Label: ({ children }: { children: React.ReactNode }) =>
    createElement('label', null, children),
});

// An answer the music route did not give: the hook is made to report it failed.
type MusicHook = {
  default: (request: never, enabled: boolean) => Record<string, unknown>;
};
let routeFails = false;
const hook = loadClient<MusicHook>('hooks/useMusicRequestMedia');
const readRoute = hook.default;
hook.default = (request, enabled) => {
  const read = readRoute(request, enabled);

  return routeFails && read.loading ? { ...read, loading: false } : read;
};

const PLACEHOLDER = '/images/seerr_poster_not_found.png';
const ALBUM = 'd0a4f8c1-3b5e-4a47-9a39-5f4f0d1c0001';
const ARTIST = 'd0a4f8c1-3b5e-4a47-9a39-5f4f0d1c0002';

// The texts of the badges a row or a card shows (a request's status, the
// media's): not the labels of its fields, which a text match would also find.
const badges = (html: string) =>
  [
    ...html.matchAll(
      /rounded-full whitespace-nowrap[^"]*"[^>]*>(?:<div[^>]*><span>)?([^<]*)</g
    ),
  ].map((match) => match[1]);

const person = (id: number, name: string) => ({
  id,
  displayName: name,
  avatar: '/avatar.png',
  email: `${name}@x.test`,
});

type Props = Record<string, unknown>;
type Component = (props: never) => React.ReactNode;

const request = (over: Props = {}, mediaOver: Props = {}) => ({
  id: 7,
  type: MediaType.MUSIC,
  status: MediaRequestStatus.PENDING,
  is4k: false,
  createdAt: new Date(Date.now() - 3600_000).toISOString(),
  updatedAt: new Date(Date.now() - 1800_000).toISOString(),
  requestedBy: person(2, 'Alice'),
  seasons: [],
  media: {
    id: 3,
    mediaType: MediaType.MUSIC,
    musicBrainzId: ALBUM,
    musicKind: 'album',
    status: MediaStatus.PENDING,
    ...mediaOver,
  },
  ...over,
});

const albumAnswer = {
  id: ALBUM,
  title: 'OK Computer',
  artist: { id: ARTIST, name: 'Radiohead' },
  coverUrl: 'https://img.test/cover.jpg',
  releaseDate: '1997-05-21',
};

const artistAnswer = {
  id: ARTIST,
  name: 'Radiohead',
  imageUrl: 'https://img.test/artist.jpg',
};

const render = (
  file: string,
  props: Props,
  viewer: { id: number; permissions: number },
  answers: Record<string, unknown> = {}
) => {
  const Component = loadClient<{ default: Component }>(file).default;

  return renderClient(() =>
    createElement(
      SWRConfig,
      {
        value: {
          fallback: {
            '/api/v1/auth/me': { ...person(viewer.id, 'Viewer'), ...viewer },
            ...answers,
          },
        },
      },
      createElement(Component as never, props as never)
    )
  );
};

const row = (
  req: ReturnType<typeof request>,
  viewer: { id: number; permissions: number },
  answers?: Record<string, unknown>
) =>
  render(
    'components/RequestList/RequestItem/MusicRequestItem',
    { request: req, revalidateList: () => {} },
    viewer,
    answers
  );

const card = (
  req: ReturnType<typeof request>,
  viewer: { id: number; permissions: number },
  answers?: Record<string, unknown>
) =>
  render(
    'components/RequestCard/MusicRequestCard',
    { request: req },
    viewer,
    answers
  );

const MANAGER = { id: 1, permissions: Permission.MANAGE_REQUESTS };
const REQUESTER = { id: 2, permissions: Permission.REQUEST_MUSIC };
const ADVANCED_REQUESTER = {
  id: 2,
  permissions: Permission.REQUEST_MUSIC | Permission.REQUEST_ADVANCED,
};
const OTHER = { id: 9, permissions: Permission.REQUEST_MUSIC };

describe('a music request in the requests list', () => {
  it('shows an album request: cover, title, artist, kind, requester, date, status, linking to the album page', async () => {
    const html = await row(request(), MANAGER, {
      [`/api/v1/music/album/${ALBUM}`]: albumAnswer,
    });

    assert.match(html, /data-testid="music-request-item"/);
    assert.match(html, /data-testid="music-request-kind">Album</);
    assert.match(
      html,
      new RegExp(
        `data-testid="music-request-title" href="/music/album/${ALBUM}">OK Computer<`
      )
    );
    assert.match(
      html,
      new RegExp(
        `data-testid="music-request-artist" href="/music/artist/${ARTIST}">Radiohead<`
      )
    );
    assert.ok(html.includes('src="https://img.test/cover.jpg"'));
    assert.match(html, /href="\/users\/2"/);
    assert.match(html, />Alice</);
    assert.match(html, /hour ago|hours ago|minutes? ago/);
    assert.match(html, />Pending</);
  });

  it('shows an artist request: image, name, kind, linking to the artist page, no artist line', async () => {
    const html = await row(
      request({}, { musicKind: 'artist', musicBrainzId: ARTIST }),
      MANAGER,
      { [`/api/v1/music/artist/${ARTIST}`]: artistAnswer }
    );

    assert.match(html, /data-testid="music-request-kind">Artist</);
    assert.match(
      html,
      new RegExp(
        `data-testid="music-request-title" href="/music/artist/${ARTIST}">Radiohead<`
      )
    );
    assert.ok(html.includes('src="https://img.test/artist.jpg"'));
    assert.doesNotMatch(html, /music-request-artist/);
  });

  it('shows the request status and the media status, and who handled it', async () => {
    const answers = { [`/api/v1/music/album/${ALBUM}`]: albumAnswer };
    const handled = { modifiedBy: person(1, 'Boss') };

    const processing = await row(
      request(
        { status: MediaRequestStatus.APPROVED, ...handled },
        { status: MediaStatus.PROCESSING }
      ),
      MANAGER,
      answers
    );
    assert.match(processing, />Requested</);
    assert.match(processing, /Modified/);
    assert.match(processing, /href="\/users\/1"/);

    const available = await row(
      request(
        { status: MediaRequestStatus.COMPLETED, ...handled },
        { status: MediaStatus.AVAILABLE }
      ),
      MANAGER,
      answers
    );
    assert.match(available, />Available</);

    const partial = await row(
      request(
        { status: MediaRequestStatus.COMPLETED },
        { status: MediaStatus.PARTIALLY_AVAILABLE }
      ),
      MANAGER,
      answers
    );
    assert.match(partial, />Partially Available</);

    const declined = await row(
      request({ status: MediaRequestStatus.DECLINED, ...handled }),
      MANAGER,
      answers
    );
    assert.match(declined, />Declined</);

    const failed = await row(
      request({ status: MediaRequestStatus.FAILED }),
      MANAGER,
      answers
    );
    assert.match(failed, />Failed</);
  });

  it('shows a placeholder and what it has where the route fails or carries no image (R-14)', async () => {
    const noImage = await row(request(), MANAGER, {
      [`/api/v1/music/album/${ALBUM}`]: {
        ...albumAnswer,
        coverUrl: undefined,
      },
    });
    assert.ok(noImage.includes(`src="${PLACEHOLDER}"`));
    assert.match(noImage, />OK Computer</);

    // the route failed: the row has the kind, the requester, the date and the status
    routeFails = true;
    const none = await row(request(), MANAGER);
    routeFails = false;
    assert.ok(none.includes(`src="${PLACEHOLDER}"`));
    assert.match(none, /data-testid="music-request-kind">Album</);
    assert.match(none, />Unknown Title</);
    assert.match(none, new RegExp(`href="/music/album/${ALBUM}"`));
    assert.match(none, />Alice</);
    assert.match(none, />Pending</);
  });

  it('shows a bar, not a guess, while the route is being read', async () => {
    const html = await row(request(), MANAGER);

    assert.match(html, /animate-pulse/);
    assert.doesNotMatch(html, /Unknown Title/);
    assert.match(html, /data-testid="music-request-kind">Album</);
  });

  it('never asks TMDB for a music request', async () => {
    const html = await row(request(), MANAGER, {});

    assert.doesNotMatch(html, /image\.tmdb\.org|\/api\/v1\/(movie|tv)\//);
  });

  it('offers a user who manages requests approve, decline and edit on a pending request, and no cancel', async () => {
    const html = await row(request(), MANAGER);

    assert.match(html, /<span>Approve<\/span>/);
    assert.match(html, /<span>Decline<\/span>/);
    assert.match(html, /<span>Edit Request<\/span>/);
    assert.doesNotMatch(html, /Cancel Request|Delete Request|Retry/);
  });

  it('offers a manager retry and delete on a failed request, and delete on a handled one', async () => {
    const failed = await row(
      request({ status: MediaRequestStatus.FAILED }),
      MANAGER
    );
    assert.match(failed, /<span>Retry<\/span>/);
    assert.match(failed, /Delete Request/);
    assert.doesNotMatch(failed, /Approve|Edit Request/);

    for (const status of [
      MediaRequestStatus.APPROVED,
      MediaRequestStatus.DECLINED,
      MediaRequestStatus.COMPLETED,
    ]) {
      const html = await row(request({ status }), MANAGER);
      assert.match(html, /Delete Request/);
      assert.doesNotMatch(html, /Retry|Approve|Edit Request/);
    }
  });

  it('offers its requester cancel, and the edit only with Request Advanced, as a movie request does', async () => {
    const plain = await row(request(), REQUESTER);
    assert.match(plain, /Cancel Request/);
    assert.doesNotMatch(plain, /Edit Request|Approve|Delete Request/);

    const advanced = await row(request(), ADVANCED_REQUESTER);
    assert.match(advanced, /Cancel Request/);
    assert.match(advanced, /Edit Request/);
  });

  it('offers a requester who does not manage requests no retry on its failed request, and a manager who is the requester no cancel', async () => {
    const failed = await row(
      request({ status: MediaRequestStatus.FAILED }),
      REQUESTER
    );
    assert.doesNotMatch(failed, /Retry|Delete Request/);

    const own = await row(request({ requestedBy: person(1, 'Boss') }), MANAGER);
    assert.doesNotMatch(own, /Cancel Request/);
    assert.match(own, /<span>Approve<\/span>/);
  });

  it('offers another user without Manage Requests nothing', async () => {
    const html = await row(request(), OTHER);

    assert.doesNotMatch(
      html,
      /Cancel Request|Edit Request|Approve|Decline|Delete Request|Retry/
    );
  });

  it('offers the requester of a request no longer pending no edit and no cancel', async () => {
    const html = await row(
      request({ status: MediaRequestStatus.APPROVED }),
      ADVANCED_REQUESTER
    );

    assert.doesNotMatch(html, /Edit Request|Cancel Request/);
  });
});

describe('a music request on a request card', () => {
  it('shows kind, title, artist, requester, date, status and cover, linking to the page', async () => {
    const html = await card(
      request({ modifiedBy: person(1, 'Boss') }),
      MANAGER,
      { [`/api/v1/music/album/${ALBUM}`]: albumAnswer }
    );

    assert.match(html, /data-testid="request-card"/);
    assert.match(html, /data-testid="music-request-kind">Album</);
    assert.match(html, />OK Computer</);
    assert.match(html, />Radiohead</);
    assert.ok(html.includes('src="https://img.test/cover.jpg"'));
    assert.match(html, new RegExp(`href="/music/album/${ALBUM}"`));
    assert.match(html, />Alice</);
    assert.match(html, /Handled/);
    assert.match(html, />Boss</);
    assert.match(html, />Pending</);
  });

  it('shows a placeholder where the route fails (R-14)', async () => {
    routeFails = true;
    const html = await card(request(), MANAGER);
    routeFails = false;

    assert.ok(html.includes(`src="${PLACEHOLDER}"`));
    assert.match(html, />Unknown Title</);
    assert.match(html, /data-testid="music-request-kind">Album</);
  });

  it('offers a manager approve and decline, retry on a failed request, and the requester cancel and edit as a movie card does', async () => {
    const pending = await card(request(), MANAGER);
    assert.match(pending, /<span>Approve<\/span>/);
    assert.match(pending, /<span>Decline<\/span>/);

    const failed = await card(
      request({ status: MediaRequestStatus.FAILED }),
      MANAGER
    );
    assert.match(failed, /Retry/);

    const requesterFailed = await card(
      request({ status: MediaRequestStatus.FAILED }),
      REQUESTER
    );
    assert.doesNotMatch(requesterFailed, /Retry/);

    const ownCard = await card(
      request({ requestedBy: person(1, 'Boss') }),
      MANAGER
    );
    assert.doesNotMatch(ownCard, /<span>Cancel<\/span>/);

    const requester = await card(request(), ADVANCED_REQUESTER);
    assert.match(requester, /<span>Cancel<\/span>/);
    assert.match(requester, /<span>Edit<\/span>/);

    const plain = await card(request(), REQUESTER);
    assert.match(plain, /<span>Cancel<\/span>/);
    assert.doesNotMatch(plain, /<span>Edit<\/span>/);
  });
});

describe('the lists choose the music row and card by the request type', () => {
  it('renders a music request as the music row and card and a movie request as it did', async () => {
    const asRow = (req: unknown) =>
      render(
        'components/RequestList/RequestItem',
        { request: req, revalidateList: () => {} },
        MANAGER
      );
    const asCard = (req: unknown) =>
      render('components/RequestCard', { request: req }, MANAGER);

    assert.match(await asRow(request()), /data-testid="music-request-item"/);
    assert.doesNotMatch(
      await asRow(request({ type: MediaType.MOVIE })),
      /music-request-item/
    );
    assert.match(await asCard(request()), /music-request-kind/);
    assert.doesNotMatch(
      await asCard(request({ type: MediaType.MOVIE })),
      /music-request-kind/
    );
  });

  it('offers Music in the media type filter, beside All, Movies and Series', async () => {
    const html = await render('components/RequestList', {}, MANAGER, {
      '/api/v1/request?take=10&skip=0&filter=pending&mediaType=all&sort=added&sortDirection=desc':
        {
          pageInfo: { pages: 1, pageSize: 10, results: 0, page: 1 },
          results: [],
          serviceErrors: { radarr: [], sonarr: [] },
        },
    });

    const at = (value: string) => html.indexOf(`<option value="${value}"`);

    assert.ok(at('all') > 0 && at('all') < at('movie'));
    assert.ok(at('movie') < at('tv') && at('tv') < at('music'));
    assert.match(html, /<option value="music"[^>]*>Music<\/option>/);
  });
});

describe('the status a music request shows', () => {
  const answers = { [`/api/v1/music/album/${ALBUM}`]: albumAnswer };
  const cases: [string, MediaRequestStatus, MediaStatus, string][] = [
    ['pending', MediaRequestStatus.PENDING, MediaStatus.PENDING, 'Pending'],
    [
      'approved and processing',
      MediaRequestStatus.APPROVED,
      MediaStatus.PROCESSING,
      'Requested',
    ],
    [
      'approved, its album still pending under a whole-artist request',
      MediaRequestStatus.APPROVED,
      MediaStatus.PENDING,
      'Pending',
    ],
    [
      'completed and available',
      MediaRequestStatus.COMPLETED,
      MediaStatus.AVAILABLE,
      'Available',
    ],
    [
      'completed and partially available',
      MediaRequestStatus.COMPLETED,
      MediaStatus.PARTIALLY_AVAILABLE,
      'Partially Available',
    ],
    [
      'declined',
      MediaRequestStatus.DECLINED,
      MediaStatus.PROCESSING,
      'Declined',
    ],
    ['failed', MediaRequestStatus.FAILED, MediaStatus.PROCESSING, 'Failed'],
  ];

  for (const [name, status, mediaStatus, badge] of cases) {
    it(`shows ${name} as the badge ${badge} on the row and on the card`, async () => {
      const req = request({ status }, { status: mediaStatus });

      assert.deepEqual(badges(await row(req, MANAGER, answers)), [badge]);
      assert.deepEqual(badges(await card(req, MANAGER, answers)), [badge]);
    });
  }

  it('shows no badge where the media status is unknown', async () => {
    const req = request({}, { status: MediaStatus.UNKNOWN });

    assert.deepEqual(badges(await row(req, MANAGER, answers)), []);
    assert.deepEqual(badges(await card(req, MANAGER, answers)), []);
  });
});

describe('the edit of a music request in the lists', () => {
  const USERS = '/api/v1/user?take=1000&sort=displayname';
  const user = (id: number, name: string, permissions: number) => ({
    ...person(id, name),
    permissions,
  });
  const users = (...results: ReturnType<typeof user>[]) => ({
    [USERS]: { pageInfo: {}, results },
  });
  const ALICE = user(2, 'Alice', Permission.REQUEST_MUSIC);
  const BOB = user(3, 'Bob', Permission.REQUEST);
  const CAROL = user(4, 'Carol', Permission.REQUEST_MOVIE);
  const DAVE = user(5, 'Dave', Permission.REQUEST_TV);
  const EDITOR = {
    id: 1,
    permissions: Permission.MANAGE_REQUESTS | Permission.MANAGE_USERS,
  };

  const calls: [string, string, unknown?][] = [];
  const http = axios as unknown as Record<string, unknown>;
  const original = { put: http.put, post: http.post, delete: http.delete };
  let chosen: unknown;
  // the module's own exports (the import namespace has getters only)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const react = require('react') as Record<string, unknown>;
  const useState = react.useState;

  // The chosen requester is what a pick in the listbox sets: where the modal
  // holds the request's own requester as its state, it holds the chosen one.
  const holdChosen = (requestedBy: unknown) => {
    react.useState = (initial: unknown) => {
      const [value, set] = (useState as (v: unknown) => [unknown, unknown])(
        initial
      );

      return [initial === requestedBy && chosen ? chosen : value, set];
    };
  };

  const edit = async (
    viewer: { id: number; permissions: number },
    answers: Record<string, unknown> = {},
    req = request()
  ) => {
    calls.length = 0;
    http.put = async (url: string, body: unknown) => {
      calls.push(['put', url, body]);

      return { status: 200 };
    };
    http.post = async (url: string) => {
      calls.push(['post', url]);

      return { status: 200 };
    };
    http.delete = async (url: string) => {
      calls.push(['delete', url]);

      return { status: 204 };
    };
    holdChosen(req.requestedBy);
    try {
      let completed = 0;
      const html = await render(
        'components/RequestModal/MusicRequestEditModal',
        {
          show: true,
          request: req,
          kind: 'album',
          title: 'OK Computer',
          onComplete: () => {
            completed += 1;
          },
        },
        viewer,
        answers
      );

      return { html, completed: () => completed };
    } finally {
      react.useState = useState;
    }
  };
  const press = async (button: 'onOk' | 'onSecondary') => {
    const onPress = modal[button];

    assert.equal(typeof onPress, 'function');
    await (onPress as () => Promise<void>)();
  };

  afterEach(() => {
    Object.assign(http, original);
    chosen = undefined;
  });

  it('offers the requester choice to a user who manages requests and users, listing those who may request music', async () => {
    const { html } = await edit(EDITOR, users(ALICE, BOB, CAROL, DAVE));

    assert.match(html, /data-testid="music-edit-requester"/);
    assert.match(html, />Request As</);
    const options = html.split('data-testid="requester-option"').slice(1);
    const listed = options.map(
      (option) => /(Alice|Bob|Carol|Dave)/.exec(option)![1]
    );

    assert.deepEqual(listed, ['Alice', 'Bob']);
  });

  it('offers no choice to a user who does not manage both requests and users, or where fewer than two users may request music', async () => {
    const all = users(ALICE, BOB, CAROL, DAVE);

    for (const permissions of [
      Permission.MANAGE_REQUESTS,
      Permission.MANAGE_USERS,
      Permission.MANAGE_REQUESTS | Permission.REQUEST_ADVANCED,
    ]) {
      const { html } = await edit({ id: 1, permissions }, all);
      assert.doesNotMatch(html, /music-edit-requester|Request As/);
    }

    const { html } = await edit(EDITOR, users(ALICE, CAROL, DAVE));
    assert.doesNotMatch(html, /music-edit-requester/);
  });

  it('has a user who manages requests approve, saving the requester through PUT first', async () => {
    const { completed } = await edit(
      { id: 1, permissions: Permission.MANAGE_REQUESTS },
      {}
    );

    assert.equal(modal.okText, 'Approve Request');
    await press('onOk');
    assert.deepEqual(calls, [
      ['put', '/api/v1/request/7', { mediaType: 'music', userId: 2 }],
      ['post', '/api/v1/request/7/approve'],
    ]);
    assert.equal(completed(), 1);
  });

  it("saves the requester the user chose, not the request's own", async () => {
    chosen = BOB;
    await edit(EDITOR, users(ALICE, BOB));
    await press('onOk');

    assert.deepEqual(calls[0], [
      'put',
      '/api/v1/request/7',
      { mediaType: 'music', userId: 3 },
    ]);
    assert.equal(calls.length, 2);
  });

  it('has a requester with Request Advanced save the edit through PUT, and nothing else', async () => {
    const { completed } = await edit(ADVANCED_REQUESTER);

    assert.equal(modal.okText, 'Edit Request');
    await press('onOk');
    assert.deepEqual(calls, [
      ['put', '/api/v1/request/7', { mediaType: 'music', userId: 2 }],
    ]);
    assert.equal(completed(), 1);
  });

  it('has a requester without Request Advanced cancel its request, saving nothing', async () => {
    const { completed } = await edit(REQUESTER);

    assert.equal(modal.okText, 'Cancel Request');
    assert.equal(modal.onSecondary, undefined);
    await press('onOk');
    assert.deepEqual(calls, [['delete', '/api/v1/request/7']]);
    assert.equal(completed(), 1);
  });

  it('offers its owner, who edits or manages, a cancel beside it, and another user none', async () => {
    await edit(ADVANCED_REQUESTER);
    assert.equal(modal.secondaryText, 'Cancel Request');
    await press('onSecondary');
    assert.deepEqual(calls, [['delete', '/api/v1/request/7']]);

    await edit({ id: 2, permissions: Permission.MANAGE_REQUESTS });
    assert.equal(modal.secondaryText, 'Cancel Request');

    await edit({ id: 9, permissions: Permission.REQUEST_ADVANCED });
    assert.equal(modal.secondaryText, undefined);
    assert.equal(modal.onSecondary, undefined);
  });

  it('says whose request it is and saves nothing before OK is pressed', async () => {
    const mine = await edit(ADVANCED_REQUESTER);
    assert.match(mine.html, /Your request is pending approval\./);
    const theirs = await edit({
      id: 9,
      permissions: Permission.REQUEST_ADVANCED,
    });
    assert.match(theirs.html, /Alice&#x27;s request is pending approval\./);
    assert.deepEqual(calls, []);
  });
});

describe('who is offered the edit', () => {
  const base = {
    status: MediaRequestStatus.PENDING,
    requesterId: 2,
    userId: 2,
    canManageRequests: false,
    canRequestAdvanced: false,
  };

  it('follows a movie request row: a manager, or the requester with Request Advanced, on a pending request', () => {
    assert.equal(canEditMusicRequest(base), false);
    assert.equal(
      canEditMusicRequest({ ...base, canRequestAdvanced: true }),
      true
    );
    assert.equal(
      canEditMusicRequest({ ...base, userId: 9, canRequestAdvanced: true }),
      false
    );
    assert.equal(
      canEditMusicRequest({ ...base, userId: 9, canManageRequests: true }),
      true
    );
    assert.equal(
      canEditMusicRequest({
        ...base,
        status: MediaRequestStatus.APPROVED,
        canManageRequests: true,
      }),
      false
    );
  });

  it('follows a movie request card: the requester with Request Advanced who does not manage requests', () => {
    const asCard = { ...base, card: true };

    assert.equal(
      canEditMusicRequest({ ...asCard, canRequestAdvanced: true }),
      true
    );
    assert.equal(
      canEditMusicRequest({
        ...asCard,
        canRequestAdvanced: true,
        canManageRequests: true,
      }),
      false
    );
    assert.equal(canEditMusicRequest(asCard), false);
  });

  it('saves the edit as the requester alone', () => {
    assert.deepEqual(musicRequestEditBody(13), {
      mediaType: 'music',
      userId: 13,
    });
    assert.deepEqual(Object.keys(musicRequestEditBody(13)).sort(), [
      'mediaType',
      'userId',
    ]);
  });

  it('finds the item of a request by its MusicBrainz id and kind', () => {
    assert.deepEqual(
      musicRequestTarget({ musicBrainzId: ALBUM, musicKind: MusicKind.ALBUM }),
      {
        kind: 'album',
        mbid: ALBUM,
        href: `/music/album/${ALBUM}`,
        apiUrl: `/api/v1/music/album/${ALBUM}`,
      }
    );
    assert.equal(musicRequestTarget({ musicBrainzId: ALBUM }), undefined);
    assert.equal(musicRequestTarget(undefined), undefined);
  });
});
