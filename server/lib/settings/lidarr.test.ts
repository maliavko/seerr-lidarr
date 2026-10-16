import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type Settings from '@server/lib/settings';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The settings file path is fixed when the module is first loaded, so the
// config directory is set first and the module loaded after.
let configDirectory: string;
let SettingsClass: typeof Settings;
let previousConfigDirectory: string | undefined;

// A settings file that records the migrations as run is already at the
// current version: loading it runs none of them, and 0007 needs a DataSource
// that this test does not have (it would end the process).
const migrationsRun = [
  '0007_migrate_arr_tags',
  '0008_migrate_blacklist_to_blocklist',
];

before(async () => {
  previousConfigDirectory = process.env.CONFIG_DIRECTORY;
  configDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'seerr-settings-'));
  process.env.CONFIG_DIRECTORY = configDirectory;
  SettingsClass = (await import('@server/lib/settings')).default;
});

after(async () => {
  if (previousConfigDirectory === undefined) {
    delete process.env.CONFIG_DIRECTORY;
  } else {
    process.env.CONFIG_DIRECTORY = previousConfigDirectory;
  }
  await fs.rm(configDirectory, { recursive: true, force: true });
});

describe('the lidarr list of the settings', () => {
  it('is empty on new settings', () => {
    assert.deepStrictEqual(new SettingsClass().lidarr, []);
  });

  it('is empty when an existing settings file has no lidarr', async () => {
    // the first load writes the settings as this version saves them
    await new SettingsClass().load();
    const onDisk = JSON.parse(
      await fs.readFile(path.join(configDirectory, 'settings.json'), 'utf-8')
    );
    delete onDisk.lidarr;
    onDisk.migrations = migrationsRun;
    onDisk.radarr = [{ id: 0, name: 'Radarr', hostname: 'radarr.local' }];
    await fs.writeFile(
      path.join(configDirectory, 'settings.json'),
      JSON.stringify(onDisk)
    );
    assert.strictEqual('lidarr' in onDisk, false);

    const loaded = await new SettingsClass().load();

    assert.deepStrictEqual(loaded.lidarr, []);
    assert.strictEqual(loaded.radarr.length, 1);
  });

  it('keeps the servers a settings file holds', async () => {
    const lidarr = [
      {
        id: 0,
        name: 'Lidarr Main',
        hostname: '127.0.0.1',
        port: 8686,
        useSsl: false,
        apiKey: 'key',
        activeProfileId: 1,
        activeProfileName: 'Any',
        activeMetadataProfileId: 2,
        activeMetadataProfileName: 'Standard',
        activeDirectory: '/music',
        isDefault: true,
      },
    ];
    const onDisk = JSON.parse(
      await fs.readFile(path.join(configDirectory, 'settings.json'), 'utf-8')
    );
    await fs.writeFile(
      path.join(configDirectory, 'settings.json'),
      JSON.stringify({ ...onDisk, lidarr, migrations: migrationsRun })
    );

    const loaded = await new SettingsClass().load();

    assert.deepStrictEqual(loaded.lidarr, lidarr);
  });
});
