import { scheduledJobs, startJobs } from '@server/job/schedule';
import { getSettings } from '@server/lib/settings';
import schedule from 'node-schedule';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

// The Lidarr Scan is listed by the schedule beside the Radarr and Sonarr scans,
// of the same kind, with its default schedule an hour after the Radarr scan's
// (D-381).
describe('the lidarr-scan job', () => {
  before(() => {
    startJobs();
  });

  after(async () => {
    await schedule.gracefulShutdown();
    scheduledJobs.length = 0;
  });

  it('is listed with its id, name, type and the interval kind of the Radarr scan', () => {
    const job = scheduledJobs.find((j) => j.id === 'lidarr-scan');
    const radarr = scheduledJobs.find((j) => j.id === 'radarr-scan');

    assert.ok(job);
    assert.ok(radarr);
    assert.strictEqual(job.name, 'Lidarr Scan');
    assert.strictEqual(job.type, 'process');
    assert.strictEqual(job.interval, radarr.interval);
    assert.strictEqual(
      job.cronSchedule,
      getSettings().jobs['lidarr-scan'].schedule
    );
    assert.strictEqual(typeof job.running, 'function');
    assert.strictEqual(job.running!(), false);
    assert.strictEqual(typeof job.cancelFn, 'function');
    assert.ok(job.job.nextInvocation());
  });

  it('has a default schedule of settings.jobs an hour after the Radarr scan, of its kind', () => {
    const { jobs } = getSettings();

    assert.strictEqual(jobs['radarr-scan'].schedule, '0 0 4 * * *');
    assert.strictEqual(jobs['lidarr-scan'].schedule, '0 0 5 * * *');
  });
});
