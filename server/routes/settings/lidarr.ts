import LidarrAPI from '@server/api/servarr/lidarr';
import { lidarrScanner } from '@server/lib/scanners/lidarr';
import type { LidarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { Router } from 'express';
import { pick } from 'lodash';

const lidarrRoutes = Router();

// a saved Lidarr server holds the fields of R-1 only
const LIDARR_FIELDS = [
  'name',
  'hostname',
  'port',
  'useSsl',
  'baseUrl',
  'apiKey',
  'activeProfileId',
  'activeProfileName',
  'activeMetadataProfileId',
  'activeMetadataProfileName',
  'activeDirectory',
  'isDefault',
  'externalUrl',
] as const;

lidarrRoutes.get('/', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.lidarr);
});

lidarrRoutes.post('/', async (req, res) => {
  const settings = getSettings();

  const newLidarr = pick(req.body, LIDARR_FIELDS) as LidarrSettings;
  const lastItem = settings.lidarr[settings.lidarr.length - 1];
  newLidarr.id = lastItem ? lastItem.id + 1 : 0;

  // If we are setting this as the default, clear any previous defaults first
  if (req.body.isDefault) {
    settings.lidarr.forEach((lidarrInstance) => {
      lidarrInstance.isDefault = false;
    });
  }

  settings.lidarr = [...settings.lidarr, newLidarr];
  await settings.save();

  // the scan runs in the background; the answer does not wait for it
  lidarrScanner.requestRun();

  return res.status(201).json(newLidarr);
});

lidarrRoutes.post('/test', async (req, res, next) => {
  try {
    const lidarr = new LidarrAPI({
      apiKey: req.body.apiKey,
      url: LidarrAPI.buildUrl(req.body, '/api/v1'),
    });

    const urlBase = await lidarr
      .getSystemStatus()
      .then((value) => value.urlBase);
    const profiles = await lidarr.getProfiles();
    const metadataProfiles = await lidarr.getMetadataProfiles();
    const folders = await lidarr.getRootFolders();

    return res.status(200).json({
      profiles,
      metadataProfiles,
      rootFolders: folders.map((folder) => ({
        id: folder.id,
        path: folder.path,
      })),
      urlBase,
    });
  } catch (e) {
    logger.error('Failed to test Lidarr', {
      label: 'Lidarr',
      message: e.message,
    });

    next({ status: 500, message: 'Failed to connect to Lidarr' });
  }
});

lidarrRoutes.put<{ id: string }>('/:id', async (req, res) => {
  const settings = getSettings();

  const lidarrIndex = settings.lidarr.findIndex(
    (r) => r.id === Number(req.params.id)
  );

  if (lidarrIndex === -1) {
    return res
      .status(404)
      .json({ status: '404', message: 'Settings instance not found' });
  }

  // If we are setting this as the default, clear any previous defaults first
  if (req.body.isDefault) {
    settings.lidarr.forEach((lidarrInstance) => {
      lidarrInstance.isDefault = false;
    });
  }

  settings.lidarr[lidarrIndex] = {
    ...pick(req.body, LIDARR_FIELDS),
    id: Number(req.params.id),
  } as LidarrSettings;
  await settings.save();

  // the scan runs in the background; the answer does not wait for it
  lidarrScanner.requestRun();

  return res.status(200).json(settings.lidarr[lidarrIndex]);
});

lidarrRoutes.delete<{ id: string }>('/:id', async (req, res) => {
  const settings = getSettings();

  const lidarrIndex = settings.lidarr.findIndex(
    (r) => r.id === Number(req.params.id)
  );

  if (lidarrIndex === -1) {
    return res
      .status(404)
      .json({ status: '404', message: 'Settings instance not found' });
  }

  const removed = settings.lidarr.splice(lidarrIndex, 1);
  await settings.save();

  return res.status(200).json(removed[0]);
});

export default lidarrRoutes;
