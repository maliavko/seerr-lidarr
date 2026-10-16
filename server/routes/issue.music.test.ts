import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import TheMovieDb from '@server/api/themoviedb';
import { IssueType } from '@server/constants/issue';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Issue from '@server/entity/Issue';
import IssueComment from '@server/entity/IssueComment';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { IssueCommentSubscriber } from '@server/subscriber/IssueCommentSubscriber';
import { IssueSubscriber } from '@server/subscriber/IssueSubscriber';
import { setupTestDb } from '@server/test/db';
import {
  MethodStubs,
  assertRowsUnchanged,
  createRoutesApp,
  loginAs,
  rawMediaRows,
  saveMusicRows,
} from '@server/test/musicRows';
import type { Express } from 'express';
import issueRoutes from './issue';
import issueCommentRoutes from './issueComment';

// A music artist row and a music album row in the media table: the issue
// routes neither fail on them nor change their answer for movies and TV, and an
// issue on a music row is refused before anything asks TMDB for it (D-84, D-8).

const issueNotifications = mock.method(
  IssueSubscriber.prototype as unknown as {
    sendIssueNotification: (...args: unknown[]) => Promise<void>;
  },
  'sendIssueNotification',
  async () => undefined
).mock;

mock.method(
  IssueCommentSubscriber.prototype as unknown as {
    sendIssueCommentNotification: (...args: unknown[]) => Promise<void>;
  },
  'sendIssueCommentNotification',
  async () => undefined
);

let app: Express;

before(() => {
  app = createRoutesApp({
    '/issue': issueRoutes,
    '/issueComment': issueCommentRoutes,
  });
});

setupTestDb();

const stubs = new MethodStubs();
let tmdbCalls: unknown[][] = [];

beforeEach(() => {
  issueNotifications.resetCalls();
  tmdbCalls = [];
  for (const method of ['getMovie', 'getTvShow']) {
    stubs.stub(TheMovieDb.prototype, method, async (...args: unknown[]) => {
      tmdbCalls.push(args);
      throw new Error('TMDB must not be asked');
    });
  }
});

afterEach(() => {
  stubs.restore();
});

async function saveIssues() {
  const admin = await getRepository(User).findOneByOrFail({ id: 1 });
  const issues: Issue[] = [];

  for (const [tmdbId, mediaType] of [
    [9951, MediaType.MOVIE],
    [9952, MediaType.TV],
  ] as const) {
    const media = await getRepository(Media).save(
      new Media({
        tmdbId,
        mediaType,
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    const issue = await getRepository(Issue).save(
      new Issue({
        issueType: IssueType.VIDEO,
        media,
        createdBy: admin,
        problemSeason: 0,
        problemEpisode: 0,
      })
    );
    await getRepository(IssueComment).save(
      new IssueComment({ user: admin, issue, message: `Problem ${tmdbId}` })
    );
    issues.push(issue);
  }

  return issues;
}

describe('issue routes with music rows in the table', () => {
  it('GET /issue, /issue/count and /issue/:id answer what they answer without them', async () => {
    const issues = await saveIssues();
    const agent = await loginAs(app);
    const urls = [
      '/issue',
      '/issue?filter=open',
      '/issue?sort=modified&take=1',
      '/issue/count',
      ...issues.map((issue) => `/issue/${issue.id}`),
    ];

    const without = await Promise.all(urls.map((url) => agent.get(url)));
    await saveMusicRows(MediaStatus.AVAILABLE);
    const withMusic = await Promise.all(urls.map((url) => agent.get(url)));

    withMusic.forEach((res, i) => {
      assert.strictEqual(res.status, 200, urls[i]);
      assert.deepStrictEqual(res.body, without[i].body, urls[i]);
    });
    assert.strictEqual(withMusic[0].body.pageInfo.results, 2);
  });

  it('POST /issue reports an issue on a movie or a show as before', async () => {
    const [movieIssue, showIssue] = await saveIssues();
    await saveMusicRows(MediaStatus.AVAILABLE);
    const agent = await loginAs(app);
    issueNotifications.resetCalls();

    for (const issue of [movieIssue, showIssue]) {
      const res = await agent.post('/issue').send({
        issueType: IssueType.AUDIO,
        message: 'No sound',
        mediaId: issue.media.id,
      });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.media.id, issue.media.id);
    }

    assert.strictEqual(await getRepository(Issue).count(), 4);
    assert.strictEqual(issueNotifications.callCount(), 2);
  });

  for (const kind of ['artist', 'album'] as const) {
    it(`POST /issue answers 404 for a music ${kind} row and saves no issue, sends no notification and asks TMDB nothing`, async () => {
      await saveIssues();
      const rows = await saveMusicRows(MediaStatus.AVAILABLE);
      const before = await rawMediaRows([rows[kind].id]);
      const agent = await loginAs(app);
      issueNotifications.resetCalls();

      const res = await agent.post('/issue').send({
        issueType: IssueType.OTHER,
        message: 'Wrong tags',
        mediaId: rows[kind].id,
      });

      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.message, 'Media does not exist.');
      assert.strictEqual(await getRepository(Issue).count(), 2);
      assert.strictEqual(issueNotifications.callCount(), 0);
      assert.deepStrictEqual(tmdbCalls, []);
      await assertRowsUnchanged([rows[kind]], before);
    });
  }
});
