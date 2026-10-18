import type { LidarrHistoryEvent } from '@server/api/servarr/lidarr';

// A track file Lidarr holds of an album: its id, when Lidarr gained it (ISO
// 8601) and the tracks (Lidarr's ids) that hold it.
export interface HeldFile {
  id: number;
  dateAdded: string;
  trackIds: number[];
}

const IMPORTED = 'trackFileImported';
const DELETED = 'trackFileDeleted';
// a delete for these reasons replaces a file, it never loses one
const REPLACED = new Set(['Upgrade', 'ManualOverride']);

// the events Seerr replays, by date, then id
function replayed(
  events: LidarrHistoryEvent[]
): { event: LidarrHistoryEvent; at: number }[] {
  return events
    .map((event) => ({ event, at: Date.parse(event.date) }))
    .filter(
      ({ event, at }) =>
        !Number.isNaN(at) &&
        (event.eventType === IMPORTED || event.eventType === DELETED)
    )
    .sort((a, b) => a.at - b.at || a.event.id - b.event.id);
}

const hasTrack = (
  event: LidarrHistoryEvent
): event is LidarrHistoryEvent & {
  trackId: number;
} => event.trackId !== undefined && event.trackId !== null;

// When an album came into the library (F2-D-561), in milliseconds, or null
// where no held file has a date. The history is replayed by date, then id,
// keeping the tracks held and whether a replacement is pending: an import of
// a track the album has now (albumTrackIds, its tracks as Lidarr gives them
// now; an import naming no track counts as one track of its own, not one the
// album has) first removes from the tracks held every track the album no
// longer has (where Lidarr replaces an album's tracks - a refresh of a
// release, a release switch - it removes their files writing no history),
// then is a coming-in where no track is held and no replacement is pending,
// then holds its track and ends a pending replacement. A delete removes its
// track; for reason Upgrade or ManualOverride (a file Lidarr removes as it
// replaces it, recorded before the imports of the same call, the new file
// possibly of another track) it also leaves a replacement pending until the
// next import or a delete of another reason. Each held file's mark is its own
// import record - the import whose data.fileId is its id, else the latest
// import of one of its tracks dated no earlier than its dateAdded - else its
// dateAdded. The album's time is the latest coming-in dated no later than the
// earliest mark, else its earliest held file's dateAdded (F2-R-92's fallback,
// as F2-SD-11 keeps it). No window on time is assumed.
export function albumCameInAt(
  events: LidarrHistoryEvent[],
  heldFiles: HeldFile[],
  albumTrackIds: number[]
): number | null {
  const files = heldFiles
    .map((file) => ({ ...file, added: Date.parse(file.dateAdded) }))
    .filter((file) => !Number.isNaN(file.added));

  if (files.length === 0) {
    return null;
  }

  const current = new Set(albumTrackIds);
  const ordered = replayed(events);
  const held = new Set<string>();
  const comingIns: number[] = [];
  let pending = false;

  for (const { event, at } of ordered) {
    const key = hasTrack(event) ? `t${event.trackId}` : `e${event.id}`;

    if (event.eventType === IMPORTED) {
      if (hasTrack(event) && current.has(event.trackId)) {
        for (const heldKey of [...held]) {
          if (
            !heldKey.startsWith('t') ||
            !current.has(Number(heldKey.slice(1)))
          ) {
            held.delete(heldKey);
          }
        }
      }

      if (held.size === 0 && !pending) {
        comingIns.push(at);
      }

      held.add(key);
      pending = false;
    } else {
      held.delete(key);
      pending = REPLACED.has(event.data?.reason ?? '');
    }
  }

  let earliestMark = Infinity;
  let earliestAdded = Infinity;

  for (const file of files) {
    let mark = file.added;
    // the file's own import record, else the latest import of one of its
    // tracks (ordered ascending: the last one met is the latest)
    let own = -Infinity;
    let latestImport = -Infinity;

    for (const { event, at } of ordered) {
      if (event.eventType !== IMPORTED) {
        continue;
      }

      if (
        event.data?.fileId !== undefined &&
        event.data.fileId !== null &&
        String(event.data.fileId) === String(file.id)
      ) {
        own = at;
      }

      if (hasTrack(event) && file.trackIds.includes(event.trackId)) {
        latestImport = at;
      }
    }

    if (own !== -Infinity) {
      mark = own;
    } else if (latestImport >= file.added) {
      mark = latestImport;
    }

    earliestMark = Math.min(earliestMark, mark);
    earliestAdded = Math.min(earliestAdded, file.added);
  }

  const qualifying = comingIns.filter((at) => at <= earliestMark);

  return qualifying.length > 0 ? Math.max(...qualifying) : earliestAdded;
}
