import migrateLidarrScanSchedule from '@server/lib/settings/migrations/0009_migrate_lidarr_scan_schedule';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import type Settings from '@server/lib/settings';
import type { AllSettings } from '@server/lib/settings';

// a settings file as saved: only what the migration reads
const saved = (settings: object) => settings as AllSettings;
const migrate = (settings: object) =>
  migrateLidarrScanSchedule(saved(settings)) as unknown as {
    jobs: Record<string, { schedule: string }>;
    migrations: string[];
  };

const NAME = '0009_migrate_lidarr_scan_schedule';

describe('migration 0009: the lidarr-scan schedule', () => {
  it('moves the previous default to every 30 minutes and records its name', () => {
    const out = migrate({
      jobs: { 'lidarr-scan': { schedule: '0 0 5 * * *' } },
      migrations: ['0008_migrate_blacklist_to_blocklist'],
    });

    assert.strictEqual(out.jobs['lidarr-scan'].schedule, '0 */30 * * * *');
    assert.deepStrictEqual(out.migrations, [
      '0008_migrate_blacklist_to_blocklist',
      NAME,
    ]);
  });

  it('keeps any other schedule, and touches no other job', () => {
    const out = migrate({
      jobs: {
        'lidarr-scan': { schedule: '0 0 7 * * *' },
        'availability-sync': { schedule: '0 0 5 * * *' },
      },
      migrations: [],
    });

    assert.strictEqual(out.jobs['lidarr-scan'].schedule, '0 0 7 * * *');
    assert.strictEqual(out.jobs['availability-sync'].schedule, '0 0 5 * * *');
    assert.deepStrictEqual(out.migrations, [NAME]);
  });

  it('leaves a missing schedule to the default, and creates the list of migrations', () => {
    const out = migrate({ jobs: {} });

    assert.deepStrictEqual(out.jobs, {});
    assert.deepStrictEqual(out.migrations, [NAME]);
    assert.deepStrictEqual(migrate({}).migrations, [NAME]);
  });

  it('returns the settings unchanged where its name is recorded', () => {
    const settings = {
      jobs: { 'lidarr-scan': { schedule: '0 0 5 * * *' } },
      migrations: [NAME],
    };
    const out = migrate(structuredClone(settings));

    assert.deepStrictEqual(out, settings);
  });
});

describe('migration 0009 on load of the settings file', () => {
  let configDirectory: string;
  let SettingsClass: typeof Settings;
  let previous: string | undefined;
  const before0009 = [
    '0007_migrate_arr_tags',
    '0008_migrate_blacklist_to_blocklist',
  ];

  before(async () => {
    previous = process.env.CONFIG_DIRECTORY;
    configDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'seerr-settings-0009-')
    );
    process.env.CONFIG_DIRECTORY = configDirectory;
    SettingsClass = (await import('@server/lib/settings')).default;
  });

  after(async () => {
    if (previous === undefined) {
      delete process.env.CONFIG_DIRECTORY;
    } else {
      process.env.CONFIG_DIRECTORY = previous;
    }
    await fs.rm(configDirectory, { recursive: true, force: true });
  });

  it('moves the old default once: the old value set again later is kept', async () => {
    await new SettingsClass().load();
    const file = path.join(configDirectory, 'settings.json');
    const onDisk = JSON.parse(await fs.readFile(file, 'utf-8'));
    onDisk.jobs['lidarr-scan'] = { schedule: '0 0 5 * * *' };
    onDisk.migrations = before0009;
    await fs.writeFile(file, JSON.stringify(onDisk));

    const first = await new SettingsClass().load();
    assert.strictEqual(first.jobs['lidarr-scan'].schedule, '0 */30 * * * *');
    assert.ok(first.migrations.includes(NAME));

    // an administrator sets the old value again; a later load keeps it
    const saved = JSON.parse(await fs.readFile(file, 'utf-8'));
    saved.jobs['lidarr-scan'] = { schedule: '0 0 5 * * *' };
    await fs.writeFile(file, JSON.stringify(saved));

    const second = await new SettingsClass().load();
    assert.strictEqual(second.jobs['lidarr-scan'].schedule, '0 0 5 * * *');
  });
});
