import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';

import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import router from '@server/routes';
import authRoutes from '@server/routes/auth';
import { setupTestDb } from '@server/test/db';
import { loginAs } from '@server/test/musicRows';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';

const MBID = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';

// the API router as server/index.ts mounts it under /api/v1
let app: Express;

before(() => {
  app = express();
  app.use(express.json());
  app.use(
    session({ secret: 'test-secret', resave: false, saveUninitialized: false })
  );
  app.use(checkUser);
  app.use('/auth', authRoutes);
  app.use('/api/v1', router);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res.status(err.status ?? 500).json({ message: err.message });
    }
  );
});

setupTestDb();

beforeEach(() => {
  getSettings().lidarr = [];
});

describe('the music routes in the API router', () => {
  for (const kind of ['artist', 'album']) {
    it(`refuses an unauthenticated GET /api/v1/music/${kind}/:mbid with 403`, async () => {
      const res = await request(app).get(`/api/v1/music/${kind}/${MBID}`);

      assert.strictEqual(res.status, 403);
    });

    it(`serves GET /api/v1/music/${kind}/:mbid to a signed-in user, answering 404 where no Lidarr server is the default`, async () => {
      const agent = await loginAs(app);
      const res = await agent.get(`/api/v1/music/${kind}/${MBID}`);

      assert.strictEqual(res.status, 404);
      assert.match(res.body.message, new RegExp(`${kind} not found`, 'i'));
    });
  }

  for (const path of [
    '/api/v1/music/recentlyadded',
    '/api/v1/music/library/similar',
    `/api/v1/music/artist/${MBID}/similar`,
  ]) {
    it(`refuses an unauthenticated GET ${path} with 403`, async () => {
      const res = await request(app).get(path);

      assert.strictEqual(res.status, 403);
    });

    it(`serves GET ${path} to a signed-in user, answering an empty list where no Lidarr server is the default`, async () => {
      const agent = await loginAs(app);
      const res = await agent.get(path);

      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body, { results: [] });
    });
  }
});
