import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { getKindsShown } from '@server/lib/kindsShown';
import { getSettings } from '@server/lib/settings';
import { radarrServer, sonarrServer } from '@server/test/servers';

const lidarr = (isDefault: boolean) => ({
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
  isDefault,
});

describe('getKindsShown', () => {
  afterEach(() => {
    const settings = getSettings();
    settings.radarr = [];
    settings.sonarr = [];
    settings.lidarr = [];
  });

  const cases = [
    {
      name: 'no server at all shows no kind',
      radarr: [],
      sonarr: [],
      lidarr: [],
      shown: [],
    },
    {
      name: 'a Radarr server shows movies and people',
      radarr: [radarrServer()],
      sonarr: [],
      lidarr: [],
      shown: ['movie', 'person'],
    },
    {
      name: 'a 4K-only Radarr server counts as a Radarr server',
      radarr: [radarrServer({ is4k: true, isDefault: false })],
      sonarr: [],
      lidarr: [],
      shown: ['movie', 'person'],
    },
    {
      name: 'a Sonarr server shows series and people',
      radarr: [],
      sonarr: [sonarrServer()],
      lidarr: [],
      shown: ['tv', 'person'],
    },
    {
      name: 'a 4K-only Sonarr server counts as a Sonarr server',
      radarr: [],
      sonarr: [sonarrServer({ is4k: true, isDefault: false })],
      lidarr: [],
      shown: ['tv', 'person'],
    },
    {
      name: 'a default Lidarr server alone shows music and no people',
      radarr: [],
      sonarr: [],
      lidarr: [lidarr(true)],
      shown: ['music'],
    },
    {
      name: 'Lidarr servers none of which is the default show no music',
      radarr: [],
      sonarr: [],
      lidarr: [lidarr(false), { ...lidarr(false), id: 2 }],
      shown: [],
    },
    {
      name: 'a second Lidarr server that is the default shows music beside a first that is not',
      radarr: [],
      sonarr: [],
      lidarr: [lidarr(false), { ...lidarr(true), id: 2 }],
      shown: ['music'],
    },
    {
      name: 'all three services show every kind, in the order movie, tv, music, person',
      radarr: [radarrServer()],
      sonarr: [sonarrServer()],
      lidarr: [lidarr(true)],
      shown: ['movie', 'tv', 'music', 'person'],
    },
    {
      name: 'a Radarr and a default Lidarr server show movies, music and people but not series',
      radarr: [radarrServer()],
      sonarr: [],
      lidarr: [lidarr(true)],
      shown: ['movie', 'music', 'person'],
    },
  ];

  for (const { name, shown, ...servers } of cases) {
    it(`${name}`, () => {
      assert.deepStrictEqual(getKindsShown(servers), shown);
    });
  }

  it('reads the settings at each call: a server added, edited or deleted changes the next answer', () => {
    const settings = getSettings();
    assert.deepStrictEqual(getKindsShown(), []);

    settings.sonarr = [sonarrServer()];
    assert.deepStrictEqual(getKindsShown(), ['tv', 'person']);

    settings.lidarr = [lidarr(false)];
    assert.deepStrictEqual(getKindsShown(), ['tv', 'person']);
    settings.lidarr = [lidarr(true)];
    assert.deepStrictEqual(getKindsShown(), ['tv', 'music', 'person']);

    settings.sonarr = [];
    assert.deepStrictEqual(getKindsShown(), ['music']);
  });
});
