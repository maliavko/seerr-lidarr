import type { AllSettings } from '@server/lib/settings';

const PREVIOUS_DEFAULT = '0 0 5 * * *';
const NEW_DEFAULT = '0 */30 * * * *';

// A saved lidarr-scan schedule that is still the previous default moves to the
// new default, once; any other schedule is kept (F2-D-42).
const migrateLidarrScanSchedule = (settings: AllSettings): AllSettings => {
  if (
    Array.isArray(settings.migrations) &&
    settings.migrations.includes('0009_migrate_lidarr_scan_schedule')
  ) {
    return settings;
  }

  if (settings.jobs?.['lidarr-scan']?.schedule === PREVIOUS_DEFAULT) {
    settings.jobs['lidarr-scan'].schedule = NEW_DEFAULT;
  }

  if (!Array.isArray(settings.migrations)) {
    settings.migrations = [];
  }
  settings.migrations.push('0009_migrate_lidarr_scan_schedule');

  return settings;
};

export default migrateLidarrScanSchedule;
