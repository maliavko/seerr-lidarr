import { MediaStatus, MediaType, MusicKind } from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { getSettings } from '@server/lib/settings';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import type { Express } from 'express';
import express, { Router } from 'express';
import session from 'express-session';
import assert from 'node:assert/strict';
import request from 'supertest';

export interface MusicRows {
  artist: Media;
  album: Media;
}

// A music artist row and a music album row as the music feature leaves them
// (D-111): no TMDB, TVDB, IMDb, service or media-server field, status4k
// unknown. Their status is the one a reader under test would look at.
export async function saveMusicRows(
  status: MediaStatus = MediaStatus.AVAILABLE
): Promise<MusicRows> {
  const repository = getRepository(Media);

  const artist = await repository.save(
    new Media({
      mediaType: MediaType.MUSIC,
      musicBrainzId: '11111111-2222-3333-4444-555555555555',
      musicKind: MusicKind.ARTIST,
      status,
      status4k: MediaStatus.UNKNOWN,
      mediaAddedAt: new Date('2024-02-01T00:00:00Z'),
    })
  );
  const album = await repository.save(
    new Media({
      mediaType: MediaType.MUSIC,
      musicBrainzId: '66666666-7777-8888-9999-000000000000',
      musicKind: MusicKind.ALBUM,
      artistMusicBrainzId: '11111111-2222-3333-4444-555555555555',
      status,
      status4k: MediaStatus.UNKNOWN,
      mediaAddedAt: new Date('2024-02-02T00:00:00Z'),
    })
  );

  return { artist, album };
}

// Every column of the given media rows as the database holds it, so a test can
// show a reader left a row exactly as it was.
export async function rawMediaRows(ids: number[]): Promise<unknown[]> {
  if (ids.length === 0) {
    return [];
  }

  return dataSource.query(
    `SELECT * FROM media WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
    ids
  );
}

export async function assertRowsUnchanged(
  rows: Media[],
  before: unknown[],
  message?: string
): Promise<void> {
  assert.deepStrictEqual(
    await rawMediaRows(rows.map((row) => row.id)),
    before,
    message ?? 'a music row was changed'
  );
}

// the routes behind authentication, as routes/index.ts mounts them
export function authenticated(routes: Router): Router {
  const router = Router();
  router.use(isAuthenticated(), routes);
  return router;
}

export function createRoutesApp(routes: Record<string, Router>): Express {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
    })
  );
  app.use(checkUser);
  app.use('/auth', authRoutes);
  for (const [path, router] of Object.entries(routes)) {
    app.use(path, router);
  }
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res
        .status(err.status ?? 500)
        .json({ status: err.status ?? 500, message: err.message });
    }
  );
  return app;
}

export async function loginAs(
  app: Express,
  email = 'admin@seerr.dev',
  password = 'test1234'
) {
  const settings = getSettings();
  const priorLocalLogin = settings.main.localLogin;
  settings.main.localLogin = true;

  try {
    const agent = request.agent(app);
    const res = await agent.post('/auth/local').send({ email, password });
    assert.strictEqual(res.status, 200);
    return agent;
  } finally {
    settings.main.localLogin = priorLocalLogin;
  }
}

// Several API clients assign their methods in the constructor, so a prototype
// has no method to mock: a getter that answers a recording function stands in
// for it, as the other tests of the scanners do.
export class MethodStubs {
  private restores: (() => void)[] = [];

  public stub<T extends object>(
    prototype: T,
    name: string,
    implementation: (...args: never[]) => unknown = async () => undefined
  ): { calls: unknown[][] } {
    const calls: unknown[][] = [];
    const original = Object.getOwnPropertyDescriptor(prototype, name);

    Object.defineProperty(prototype, name, {
      get() {
        return async (...args: unknown[]) => {
          calls.push(args);
          return (implementation as (...a: unknown[]) => unknown)(...args);
        };
      },
      set() {},
      configurable: true,
    });
    this.restores.push(() => {
      if (original) {
        Object.defineProperty(prototype, name, original);
      } else {
        delete (prototype as Record<string, unknown>)[name];
      }
    });

    return { calls };
  }

  public restore(): void {
    for (const restore of this.restores.reverse()) {
      restore();
    }
    this.restores = [];
  }
}
