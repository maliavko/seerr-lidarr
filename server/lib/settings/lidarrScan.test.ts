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

// A settings file that records the migrations as run loads without running
// them (0007 needs a DataSource that this test does not have).
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

describe('the lidarr-scan job of settings.jobs', () => {
  it('has its default schedule on new settings', () => {
    assert.deepStrictEqual(new SettingsClass().jobs['lidarr-scan'], {
      schedule: '0 0 5 * * *',
    });
  });

  it('gains its default on load from a settings file saved before the job existed, and keeps an edited schedule', async () => {
    await new SettingsClass().load();
    const file = path.join(configDirectory, 'settings.json');
    const onDisk = JSON.parse(await fs.readFile(file, 'utf-8'));
    delete onDisk.jobs['lidarr-scan'];
    onDisk.jobs['radarr-scan'] = { schedule: '0 0 2 * * *' };
    onDisk.migrations = migrationsRun;
    await fs.writeFile(file, JSON.stringify(onDisk));
    assert.strictEqual('lidarr-scan' in onDisk.jobs, false);

    const loaded = await new SettingsClass().load();

    assert.deepStrictEqual(loaded.jobs['lidarr-scan'], {
      schedule: '0 0 5 * * *',
    });
    assert.deepStrictEqual(loaded.jobs['radarr-scan'], {
      schedule: '0 0 2 * * *',
    });

    // saved on load, then edited and loaded again: the edit is kept
    const saved = JSON.parse(await fs.readFile(file, 'utf-8'));
    assert.deepStrictEqual(saved.jobs['lidarr-scan'], {
      schedule: '0 0 5 * * *',
    });
    saved.jobs['lidarr-scan'] = { schedule: '0 0 7 * * *' };
    await fs.writeFile(
      file,
      JSON.stringify({ ...saved, migrations: migrationsRun })
    );

    assert.deepStrictEqual(
      (await new SettingsClass().load()).jobs['lidarr-scan'],
      {
        schedule: '0 0 7 * * *',
      }
    );
  });
});
