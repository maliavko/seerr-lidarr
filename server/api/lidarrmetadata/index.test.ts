import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import type { LidarrMetadataArtist } from '@server/api/lidarrmetadata';
import LidarrMetadataAPI, {
  getLidarrMetadata,
} from '@server/api/lidarrmetadata';
import { getMusicBrainzUserAgent } from '@server/api/musicbrainz';
import cacheManager from '@server/lib/cache';
import type {
  AxiosAdapter,
  AxiosInstance,
  InternalAxiosRequestConfig,
} from 'axios';

// The metadata service's answer for Radiohead, recorded from api.lidarr.audio
// (its list of albums left out)
const radiohead = JSON.parse(
  readFileSync(
    join(__dirname, 'lidarrmetadata.fixtures', 'artist-radiohead.json'),
    'utf8'
  )
) as LidarrMetadataArtist;

const RADIOHEAD = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

interface Call {
  url: string;
  baseURL: string;
  headers: Record<string, unknown>;
}

// Replaces what the client sends over the wire: the requests it makes are
// recorded after its interceptors and answered by respond.
function wire(
  client: LidarrMetadataAPI,
  respond: (call: Call) => { status?: number; data?: unknown; error?: Error }
): Call[] {
  const calls: Call[] = [];
  const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
    const call: Call = {
      url: config.url ?? '',
      baseURL: config.baseURL ?? '',
      headers: config.headers.toJSON() as Record<string, unknown>,
    };
    calls.push(call);

    const { status = 200, data, error } = respond(call);

    if (error) {
      throw error;
    }

    const response = {
      data,
      status,
      statusText: String(status),
      headers: {},
      config,
    };

    if (status >= 400) {
      throw Object.assign(
        new Error(`Request failed with status code ${status}`),
        { response }
      );
    }

    return response;
  };

  (client as unknown as { axios: AxiosInstance }).axios.defaults.adapter =
    adapter;

  return calls;
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (e) {
    return e as Error;
  }
  throw new assert.AssertionError({ message: 'expected a rejection' });
}

describe("Lidarr's metadata service client", () => {
  beforeEach(() => cacheManager.getCache('lidarrmetadata').flush());

  it('is one shared instance for the whole server', () => {
    assert.strictEqual(getLidarrMetadata(), getLidarrMetadata());
    assert.ok(getLidarrMetadata() instanceof LidarrMetadataAPI);
  });

  it("asks api.lidarr.audio's v0.4 artist route for the MusicBrainz id, with Seerr's User-Agent and no key", async () => {
    const client = new LidarrMetadataAPI();
    const calls = wire(client, () => ({ data: radiohead }));

    const artist = await client.getArtist(RADIOHEAD);

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].baseURL, 'https://api.lidarr.audio/api/v0.4');
    assert.strictEqual(calls[0].url, `/artist/${RADIOHEAD}`);
    assert.strictEqual(
      calls[0].headers['User-Agent'],
      getMusicBrainzUserAgent()
    );
    assert.strictEqual(calls[0].headers['X-Api-Key'], undefined);
    assert.deepStrictEqual(artist, radiohead);
  });

  it("answers the artist's overview and its images by CoverType, each with an https Url", async () => {
    const client = new LidarrMetadataAPI();
    wire(client, () => ({ data: radiohead }));

    const artist = await client.getArtist(RADIOHEAD);

    assert.ok(artist?.overview);
    for (const type of ['Poster', 'Fanart']) {
      assert.match(
        artist?.images?.find((image) => image.CoverType === type)?.Url ?? '',
        /^https:\/\//
      );
    }
  });

  it('times a request out after 10 seconds', () => {
    const client = new LidarrMetadataAPI();

    assert.strictEqual(
      (client as unknown as { axios: AxiosInstance }).axios.defaults.timeout,
      10000
    );
  });

  it('keeps its answer 24 hours in the lidarrmetadata cache, and asks again for another artist', async () => {
    const client = new LidarrMetadataAPI();
    const calls = wire(client, () => ({ data: radiohead }));
    const cache = cacheManager.getCache('lidarrmetadata');

    assert.strictEqual(cache.id, 'lidarrmetadata');
    assert.strictEqual(cache.name, 'Lidarr Metadata API');

    await client.getArtist(RADIOHEAD);
    await client.getArtist(RADIOHEAD);
    assert.strictEqual(calls.length, 1);

    const [key] = [
      ...(
        cache.data as unknown as { cache: { keys(): Iterable<string> } }
      ).cache.keys(),
    ];
    const ttl = cache.data.getTtl(key);
    assert.ok(ttl);
    assert.ok(Math.abs(ttl - Date.now() - 86400 * 1000) < 5000);
    assert.strictEqual(cache.getStats().keys, 1);

    await client.getArtist(UNKNOWN_ID);
    assert.strictEqual(calls.length, 2);
  });

  it('answers null for an id it answers 404 for, and does not keep that', async () => {
    const client = new LidarrMetadataAPI();
    const calls = wire(client, () => ({ status: 404, data: { error: 'x' } }));

    assert.strictEqual(await client.getArtist(UNKNOWN_ID), null);
    assert.strictEqual(await client.getArtist(UNKNOWN_ID), null);

    assert.strictEqual(calls.length, 2);
    assert.strictEqual(
      cacheManager.getCache('lidarrmetadata').getStats().keys,
      0
    );
  });

  it('throws a [Lidarr Metadata] error with the cause on any other failure, and does not keep it', async () => {
    const client = new LidarrMetadataAPI();
    const calls = wire(client, () => ({ status: 500, data: {} }));

    const error = await rejection(client.getArtist(RADIOHEAD));

    assert.match(
      error.message,
      /^\[Lidarr Metadata\] Failed to retrieve artist/
    );
    assert.ok(error.cause instanceof Error);
    await rejection(client.getArtist(RADIOHEAD));
    assert.strictEqual(calls.length, 2);
  });

  it('throws a [Lidarr Metadata] error when the request times out', async () => {
    const client = new LidarrMetadataAPI();
    wire(client, () => ({
      error: Object.assign(new Error('timeout of 10000ms exceeded'), {
        code: 'ECONNABORTED',
      }),
    }));

    const error = await rejection(client.getArtist(RADIOHEAD));

    assert.match(error.message, /^\[Lidarr Metadata\] .*timeout/);
  });
});
