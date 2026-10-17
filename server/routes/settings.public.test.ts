import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, before, describe, it } from 'node:test';

import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import router from '@server/routes';
import { setupTestDb } from '@server/test/db';
import { radarrServer, sonarrServer } from '@server/test/servers';
import type { Express } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import session from 'express-session';
import yaml from 'js-yaml';
import request from 'supertest';

const API_SPEC_PATH = join(__dirname, '../../seerr-api.yml');

let app: Express;

// the API router as server/index.ts mounts it, the OpenAPI validator in front
// of it validating what it answers
before(() => {
  app = express();
  app.use(express.json());
  app.use(
    session({ secret: 'test-secret', resave: false, saveUninitialized: false })
  );
  app.use(checkUser);
  app.use(
    '/api/v1',
    OpenApiValidator.middleware({
      apiSpec: API_SPEC_PATH,
      validateRequests: true,
      validateResponses: true,
      validateSecurity: false,
    }),
    router
  );
});

setupTestDb();

afterEach(() => {
  const settings = getSettings();
  settings.radarr = [];
  settings.sonarr = [];
  settings.lidarr = [];
});

describe('GET /api/v1/settings/public', () => {
  it('carries kindsShown, [] while no server is configured', async () => {
    const res = await request(app).get('/api/v1/settings/public');

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.kindsShown, []);
  });

  it('carries the kinds the servers configured give, at each call and without restart', async () => {
    const settings = getSettings();

    settings.radarr = [radarrServer({ is4k: true, isDefault: false })];
    assert.deepStrictEqual(
      (await request(app).get('/api/v1/settings/public')).body.kindsShown,
      ['movie', 'person']
    );

    settings.lidarr = [
      {
        id: 1,
        name: 'Test Lidarr',
        hostname: '127.0.0.1',
        port: 18686,
        apiKey: 'test-key',
        useSsl: false,
        activeProfileId: 1,
        activeProfileName: 'Any',
        activeMetadataProfileId: 1,
        activeMetadataProfileName: 'Standard',
        activeDirectory: '/music',
        isDefault: true,
      },
    ];
    settings.sonarr = [sonarrServer()];
    assert.deepStrictEqual(
      (await request(app).get('/api/v1/settings/public')).body.kindsShown,
      ['movie', 'tv', 'music', 'person']
    );

    settings.radarr = [];
    settings.sonarr = [];
    assert.deepStrictEqual(
      (await request(app).get('/api/v1/settings/public')).body.kindsShown,
      ['music']
    );
  });
});

describe('seerr-api.yml on kindsShown', () => {
  const spec = yaml.load(readFileSync(API_SPEC_PATH, 'utf8')) as {
    components: {
      schemas: { PublicSettings: { properties: Record<string, unknown> } };
    };
  };

  it('describes kindsShown of the public settings as an array of movie, tv, music, person', () => {
    const kindsShown = spec.components.schemas.PublicSettings.properties
      .kindsShown as { type: string; items: { type: string; enum: string[] } };

    assert.strictEqual(kindsShown.type, 'array');
    assert.strictEqual(kindsShown.items.type, 'string');
    assert.deepStrictEqual(kindsShown.items.enum, [
      'movie',
      'tv',
      'music',
      'person',
    ]);
  });

  it('refuses an answer whose kindsShown holds another kind', async () => {
    // the validator holds the answer to the spec: a settings answer with
    // another kind in kindsShown is a 500 from the response validation
    getSettings().radarr = [radarrServer()];
    const original = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(getSettings()),
      'fullPublicSettings'
    );
    assert.ok(original?.get);
    Object.defineProperty(
      Object.getPrototypeOf(getSettings()),
      'fullPublicSettings',
      {
        configurable: true,
        get() {
          return { ...original.get?.call(this), kindsShown: ['collection'] };
        },
      }
    );
    try {
      const res = await request(app).get('/api/v1/settings/public');
      assert.strictEqual(res.status, 500);
    } finally {
      Object.defineProperty(
        Object.getPrototypeOf(getSettings()),
        'fullPublicSettings',
        original
      );
    }
  });
});
