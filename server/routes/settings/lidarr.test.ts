import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import cacheManager from '@server/lib/cache';
import type { LidarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import router from '@server/routes';
import authRoutes from '@server/routes/auth';
import { setupTestDb } from '@server/test/db';
import type {
  AxiosAdapter,
  AxiosRequestConfig,
  InternalAxiosRequestConfig,
} from 'axios';
import axios, { AxiosError } from 'axios';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';

type FakeLidarr = (config: InternalAxiosRequestConfig) => {
  status: number;
  data?: unknown;
};

// The Lidarr client is mocked at the HTTP boundary: every axios instance made
// while a fake is installed answers from it, so LidarrAPI itself runs.
let fakeLidarr: FakeLidarr | undefined;
const lidarrCalls: AxiosRequestConfig[] = [];

const adapter: AxiosAdapter = async (config) => {
  lidarrCalls.push(config);
  if (!fakeLidarr) {
    throw new Error('Unexpected request with no fake Lidarr installed');
  }
  const answer = fakeLidarr(config);
  const response = {
    status: answer.status,
    statusText: String(answer.status),
    data: answer.data ?? {},
    headers: {},
    config,
  };
  if (answer.status >= 400) {
    throw new AxiosError(
      `Request failed with status code ${answer.status}`,
      AxiosError.ERR_BAD_RESPONSE,
      config,
      null,
      response
    );
  }
  return response;
};

const realCreate = axios.create.bind(axios);
mock.method(axios, 'create', (config?: AxiosRequestConfig) =>
  realCreate({ ...config, adapter })
);

const saveMock = mock.method(getSettings(), 'save', async () => undefined).mock;

const goodLidarr: FakeLidarr = (config) => {
  assert.strictEqual(config.params?.apikey, 'good-key');
  switch (config.url) {
    case '/system/status':
      return { status: 200, data: { urlBase: '/lidarr' } };
    case '/qualityProfile':
      return { status: 200, data: [{ id: 1, name: 'Lossless' }] };
    case '/metadataprofile':
      return { status: 200, data: [{ id: 2, name: 'Standard' }] };
    case '/rootfolder':
      return {
        status: 200,
        data: [{ id: 3, path: '/music', freeSpace: 1, unmappedFolders: [] }],
      };
    default:
      throw new Error(`Unstubbed Lidarr endpoint: ${config.url}`);
  }
};

function server(overrides: Partial<LidarrSettings> = {}) {
  return {
    name: 'Lidarr Main',
    hostname: '127.0.0.1',
    port: 8686,
    useSsl: false,
    baseUrl: '',
    apiKey: 'good-key',
    activeProfileId: 1,
    activeProfileName: 'Lossless',
    activeMetadataProfileId: 2,
    activeMetadataProfileName: 'Standard',
    activeDirectory: '/music',
    isDefault: false,
    ...overrides,
  };
}

let app: Express;

function createApp() {
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
  app.use('/', router);
  app.use(
    (
      err: { status?: number | string; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      const status = Number(err.status ?? 500);
      res.status(status).json({ status, message: err.message });
    }
  );
  return app;
}

before(() => {
  app = createApp();
});

setupTestDb();

beforeEach(() => {
  getSettings().lidarr = [];
  saveMock.resetCalls();
  lidarrCalls.length = 0;
  fakeLidarr = goodLidarr;
  cacheManager.getCache('lidarr').flush();
});

afterEach(() => {
  fakeLidarr = undefined;
});

async function loginAs(email: string) {
  const settings = getSettings();
  const priorLocalLogin = settings.main.localLogin;
  settings.main.localLogin = true;

  try {
    const agent = request.agent(app);
    const res = await agent
      .post('/auth/local')
      .send({ email, password: 'test1234' });
    assert.strictEqual(res.status, 200);
    return agent;
  } finally {
    settings.main.localLogin = priorLocalLogin;
  }
}

describe('/settings/lidarr is behind the settings permission', () => {
  it('refuses an unauthenticated client and a user without Admin', async () => {
    const anonymous = await request(app).get('/settings/lidarr');
    assert.strictEqual(anonymous.status, 403);

    const demo = await loginAs('demo@seerr.dev');
    assert.strictEqual((await demo.get('/settings/lidarr')).status, 403);
    assert.strictEqual(
      (await demo.post('/settings/lidarr').send(server())).status,
      403
    );
    assert.strictEqual(getSettings().lidarr.length, 0);
  });
});

describe('adding, editing, deleting and listing Lidarr servers', () => {
  it('lists no server on a fresh settings', async () => {
    const admin = await loginAs('admin@seerr.dev');
    const res = await admin.get('/settings/lidarr');

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, []);
  });

  it('adds servers with consecutive ids, saves them and lists them', async () => {
    const admin = await loginAs('admin@seerr.dev');

    const first = await admin.post('/settings/lidarr').send(server());
    assert.strictEqual(first.status, 201);
    assert.strictEqual(first.body.id, 0);
    assert.strictEqual(saveMock.callCount(), 1);

    const second = await admin
      .post('/settings/lidarr')
      .send(server({ name: 'Lidarr Two', port: 8687 }));
    assert.strictEqual(second.status, 201);
    assert.strictEqual(second.body.id, 1);
    assert.strictEqual(saveMock.callCount(), 2);

    const list = await admin.get('/settings/lidarr');
    assert.deepStrictEqual(list.body, [
      { id: 0, ...server() },
      { id: 1, ...server({ name: 'Lidarr Two', port: 8687 }) },
    ]);
    assert.deepStrictEqual(getSettings().lidarr, list.body);
  });

  it('keeps the fields of R-1 only', async () => {
    const admin = await loginAs('admin@seerr.dev');

    const res = await admin.post('/settings/lidarr').send({
      ...server(),
      id: 99,
      tags: [1],
      externalUrl: 'http://lidarr.example.com',
      syncEnabled: true,
      preventSearch: true,
      tagRequests: true,
      is4k: true,
    });

    assert.strictEqual(res.status, 201);
    assert.deepStrictEqual(res.body, { id: 0, ...server() });

    const edit = await admin
      .put('/settings/lidarr/0')
      .send({ ...server(), tags: [1], externalUrl: 'http://x', is4k: true });
    assert.strictEqual(edit.status, 200);
    assert.deepStrictEqual(edit.body, { id: 0, ...server() });
    assert.deepStrictEqual(getSettings().lidarr, [{ id: 0, ...server() }]);
  });

  it('edits a server in place and keeps its id', async () => {
    const admin = await loginAs('admin@seerr.dev');
    await admin.post('/settings/lidarr').send(server());
    await admin.post('/settings/lidarr').send(server({ name: 'Lidarr Two' }));
    saveMock.resetCalls();

    const res = await admin
      .put('/settings/lidarr/1')
      .send(
        server({ name: 'Renamed', activeDirectory: '/other', id: 7 } as never)
      );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.id, 1);
    assert.strictEqual(res.body.name, 'Renamed');
    assert.strictEqual(res.body.activeDirectory, '/other');
    assert.strictEqual(saveMock.callCount(), 1);
    assert.deepStrictEqual(
      getSettings().lidarr.map((l) => [l.id, l.name]),
      [
        [0, 'Lidarr Main'],
        [1, 'Renamed'],
      ]
    );
  });

  it('answers 404 for an unknown id on edit and delete, changing nothing', async () => {
    const admin = await loginAs('admin@seerr.dev');
    await admin.post('/settings/lidarr').send(server());
    saveMock.resetCalls();

    assert.strictEqual(
      (await admin.put('/settings/lidarr/5').send(server())).status,
      404
    );
    assert.strictEqual((await admin.delete('/settings/lidarr/5')).status, 404);
    assert.strictEqual(saveMock.callCount(), 0);
    assert.strictEqual(getSettings().lidarr.length, 1);
  });

  it('deletes a server, answers it and saves', async () => {
    const admin = await loginAs('admin@seerr.dev');
    await admin.post('/settings/lidarr').send(server());
    await admin.post('/settings/lidarr').send(server({ name: 'Lidarr Two' }));
    saveMock.resetCalls();

    const res = await admin.delete('/settings/lidarr/0');

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { id: 0, ...server() });
    assert.strictEqual(saveMock.callCount(), 1);
    assert.deepStrictEqual(
      getSettings().lidarr.map((l) => l.id),
      [1]
    );
    assert.strictEqual((await admin.get('/settings/lidarr')).body.length, 1);
  });

  it('gives a new server an id no listed server has, after a delete', async () => {
    const admin = await loginAs('admin@seerr.dev');
    await admin.post('/settings/lidarr').send(server());
    await admin.post('/settings/lidarr').send(server({ name: 'Lidarr Two' }));
    await admin.delete('/settings/lidarr/0');

    const res = await admin
      .post('/settings/lidarr')
      .send(server({ name: 'Lidarr Three' }));

    assert.strictEqual(res.status, 201);
    assert.deepStrictEqual(
      getSettings().lidarr.map((l) => l.id),
      [1, res.body.id]
    );
    assert.notStrictEqual(res.body.id, 1);
  });

  it('does not touch Radarr or Sonarr settings', async () => {
    const admin = await loginAs('admin@seerr.dev');
    const settings = getSettings();
    const radarr = settings.radarr;
    const sonarr = settings.sonarr;

    await admin.post('/settings/lidarr').send(server({ isDefault: true }));
    await admin.delete('/settings/lidarr/0');

    assert.strictEqual(settings.radarr, radarr);
    assert.strictEqual(settings.sonarr, sonarr);
  });
});

describe('marking a Lidarr server as the default', () => {
  it('clears the default flag of the others when adding', async () => {
    const admin = await loginAs('admin@seerr.dev');
    await admin.post('/settings/lidarr').send(server({ isDefault: true }));
    await admin
      .post('/settings/lidarr')
      .send(server({ name: 'Two', isDefault: true }));
    await admin.post('/settings/lidarr').send(server({ name: 'Three' }));

    const list = (await admin.get('/settings/lidarr')).body as LidarrSettings[];
    assert.deepStrictEqual(
      list.map((l) => [l.name, l.isDefault]),
      [
        ['Lidarr Main', false],
        ['Two', true],
        ['Three', false],
      ]
    );
  });

  it('clears the default flag of the others when editing', async () => {
    const admin = await loginAs('admin@seerr.dev');
    await admin.post('/settings/lidarr').send(server({ isDefault: true }));
    await admin.post('/settings/lidarr').send(server({ name: 'Two' }));
    await admin.post('/settings/lidarr').send(server({ name: 'Three' }));

    const res = await admin
      .put('/settings/lidarr/2')
      .send(server({ name: 'Three', isDefault: true }));
    assert.strictEqual(res.status, 200);

    assert.deepStrictEqual(
      getSettings().lidarr.map((l) => [l.name, l.isDefault]),
      [
        ['Lidarr Main', false],
        ['Two', false],
        ['Three', true],
      ]
    );
  });

  it('leaves the default alone when the server added is not one', async () => {
    const admin = await loginAs('admin@seerr.dev');
    await admin.post('/settings/lidarr').send(server({ isDefault: true }));
    await admin.post('/settings/lidarr').send(server({ name: 'Two' }));

    assert.deepStrictEqual(
      getSettings().lidarr.map((l) => l.isDefault),
      [true, false]
    );
  });
});

describe('POST /settings/lidarr/test', () => {
  const body = {
    hostname: '127.0.0.1',
    port: 8686,
    useSsl: false,
    baseUrl: '/lidarr',
    apiKey: 'good-key',
  };

  it('answers profiles, metadata profiles, root folders and urlBase from a reachable Lidarr', async () => {
    const admin = await loginAs('admin@seerr.dev');
    const res = await admin.post('/settings/lidarr/test').send(body);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, {
      profiles: [{ id: 1, name: 'Lossless' }],
      metadataProfiles: [{ id: 2, name: 'Standard' }],
      rootFolders: [{ id: 3, path: '/music' }],
      urlBase: '/lidarr',
    });
  });

  it('talks to the address, URL base and API key it was given, reading only', async () => {
    const admin = await loginAs('admin@seerr.dev');
    await admin
      .post('/settings/lidarr/test')
      .send({ ...body, hostname: 'lidarr.local', port: 9999, useSsl: true });

    assert.ok(lidarrCalls.length > 0);
    for (const call of lidarrCalls) {
      assert.strictEqual(call.method, 'get');
      assert.strictEqual(
        call.baseURL,
        'https://lidarr.local:9999/lidarr/api/v1'
      );
      assert.strictEqual(call.params.apikey, 'good-key');
    }
    assert.deepStrictEqual(lidarrCalls.map((c) => c.url).sort(), [
      '/metadataprofile',
      '/qualityProfile',
      '/rootfolder',
      '/system/status',
    ]);
  });

  it('saves nothing on a successful test', async () => {
    const admin = await loginAs('admin@seerr.dev');
    await admin.post('/settings/lidarr/test').send(body);

    assert.strictEqual(saveMock.callCount(), 0);
    assert.deepStrictEqual(getSettings().lidarr, []);
  });

  it('fails and saves nothing against a Lidarr that refuses the API key', async () => {
    fakeLidarr = () => ({ status: 401 });
    const admin = await loginAs('admin@seerr.dev');
    const res = await admin
      .post('/settings/lidarr/test')
      .send({ ...body, apiKey: 'wrong-key' });

    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.body.message, 'Failed to connect to Lidarr');
    assert.strictEqual(res.body.profiles, undefined);
    assert.strictEqual(res.body.rootFolders, undefined);
    assert.strictEqual(saveMock.callCount(), 0);
    assert.deepStrictEqual(getSettings().lidarr, []);
  });

  it('fails and saves nothing against an address that does not answer', async () => {
    fakeLidarr = () => {
      throw new AxiosError('connect ECONNREFUSED', AxiosError.ECONNABORTED);
    };
    const admin = await loginAs('admin@seerr.dev');
    const res = await admin
      .post('/settings/lidarr/test')
      .send({ ...body, port: 1 });

    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.body.message, 'Failed to connect to Lidarr');
    assert.strictEqual(res.body.metadataProfiles, undefined);
    assert.strictEqual(saveMock.callCount(), 0);
    assert.deepStrictEqual(getSettings().lidarr, []);
  });

  it('fails when only the status of Lidarr is refused', async () => {
    fakeLidarr = (config) =>
      config.url === '/system/status' ? { status: 401 } : goodLidarr(config);
    const admin = await loginAs('admin@seerr.dev');
    const res = await admin.post('/settings/lidarr/test').send(body);

    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.body.profiles, undefined);
    assert.strictEqual(saveMock.callCount(), 0);
  });

  it('does not save a server that is already listed when its test fails', async () => {
    const admin = await loginAs('admin@seerr.dev');
    await admin.post('/settings/lidarr').send(server());
    saveMock.resetCalls();
    fakeLidarr = () => ({ status: 401 });

    const res = await admin
      .post('/settings/lidarr/test')
      .send({ ...body, apiKey: 'wrong-key' });

    assert.strictEqual(res.status, 500);
    assert.strictEqual(saveMock.callCount(), 0);
    assert.deepStrictEqual(getSettings().lidarr, [{ id: 0, ...server() }]);
  });

  it('fails when the metadata profiles cannot be read', async () => {
    fakeLidarr = (config) =>
      config.url === '/metadataprofile' ? { status: 500 } : goodLidarr(config);
    const admin = await loginAs('admin@seerr.dev');
    const res = await admin.post('/settings/lidarr/test').send(body);

    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.body.profiles, undefined);
  });
});
