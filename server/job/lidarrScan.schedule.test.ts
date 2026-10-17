import { scheduledJobs, startJobs } from '@server/job/schedule';
import { lidarrScanner } from '@server/lib/scanners/lidarr';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import schedule from 'node-schedule';
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it, mock } from 'node:test';

// The Lidarr Scan is listed by the schedule beside the Radarr and Sonarr scans,
// of the same kind, with its default schedule every 30 minutes (D-381, F2-D-42).
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

  it('has a default schedule of settings.jobs of every 30 minutes, of its kind', () => {
    const { jobs } = getSettings();

    assert.strictEqual(jobs['radarr-scan'].schedule, '0 0 4 * * *');
    assert.strictEqual(jobs['lidarr-scan'].schedule, '0 */30 * * * *');
  });
});

// F2-D-41: the callback the schedule and Run Now both call starts nothing, and
// logs, where a Lidarr scan runs.
describe('a start of the lidarr-scan job', () => {
  before(() => {
    startJobs();
  });

  after(async () => {
    await schedule.gracefulShutdown();
    scheduledJobs.length = 0;
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it('starts nothing and logs while a scan runs', () => {
    const job = scheduledJobs.find((j) => j.id === 'lidarr-scan')!;
    mock.method(lidarrScanner, 'status', () => ({
      running: true,
      progress: 0,
      total: 0,
    }));
    const run = mock.method(lidarrScanner, 'run', async () => undefined);
    const info = mock.method(logger, 'info', () => logger);

    job.job.invoke();

    assert.strictEqual(run.mock.callCount(), 0);
    assert.strictEqual(info.mock.callCount(), 1);
    assert.match(String(info.mock.calls[0].arguments[0]), /already running/);
  });

  it('runs the scan where none runs, as before', () => {
    const job = scheduledJobs.find((j) => j.id === 'lidarr-scan')!;
    mock.method(lidarrScanner, 'status', () => ({
      running: false,
      progress: 0,
      total: 0,
    }));
    const run = mock.method(lidarrScanner, 'run', async () => undefined);

    job.job.invoke();

    assert.strictEqual(run.mock.callCount(), 1);
  });
});
