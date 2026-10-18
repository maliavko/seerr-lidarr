import CachedImage from '@app/components/Common/CachedImage';
import MusicRequestButton from '@app/components/MusicRequestButton';
import StatusBadge from '@app/components/StatusBadge';
import type { AlbumSort, AlbumSortKey } from '@app/utils/albumTable';
import {
  DEFAULT_ALBUM_SORT,
  albumTypeLabel,
  albumYear,
  nextAlbumSort,
  sortAlbums,
} from '@app/utils/albumTable';
import defineMessages from '@app/utils/defineMessages';
import { shownStatus } from '@app/utils/musicHelpers';
import { ChevronDownIcon, ChevronUpIcon } from '@heroicons/react/20/solid';
import { MusicalNoteIcon } from '@heroicons/react/24/outline';
import type Media from '@server/entity/Media';
import Link from 'next/link';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.ArtistDetails.AlbumTable', {
  title: 'Title',
  year: 'Year',
  type: 'Type',
  tracks: 'Tracks',
  status: 'Status',
});

export interface AlbumTableItem {
  id: string;
  title: string;
  releaseDate?: string;
  albumType?: string;
  secondaryTypes?: string[];
  trackCount?: number;
  coverUrl?: string;
  mediaInfo?: Media;
}

interface AlbumTableProps {
  albums: AlbumTableItem[];
  // the page's data is read again after a request is made or changed
  onUpdate: () => void;
}

const AlbumTable = ({ albums, onUpdate }: AlbumTableProps) => {
  const intl = useIntl();
  const [sort, setSort] = useState<AlbumSort>(DEFAULT_ALBUM_SORT);

  const header = (key: AlbumSortKey, label: string, className = '') => (
    <th
      className={`px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-300 ${className}`}
      aria-sort={
        sort.key === key
          ? sort.direction === 'asc'
            ? 'ascending'
            : 'descending'
          : undefined
      }
    >
      <button
        type="button"
        className="inline-flex items-center gap-1 uppercase hover:text-white"
        onClick={() => setSort(nextAlbumSort(sort, key))}
      >
        {label}
        {sort.key === key &&
          (sort.direction === 'asc' ? (
            <ChevronUpIcon className="h-4 w-4" />
          ) : (
            <ChevronDownIcon className="h-4 w-4" />
          ))}
      </button>
    </th>
  );

  return (
    <div className="overflow-x-auto rounded-lg ring-1 ring-gray-700">
      <table
        className="min-w-full divide-y divide-gray-700"
        data-testid="artist-albums-table"
      >
        <thead className="bg-gray-800">
          <tr>
            <th className="w-14 px-3 py-3" />
            {header('title', intl.formatMessage(messages.title))}
            {header('year', intl.formatMessage(messages.year), 'w-20')}
            {header(
              'type',
              intl.formatMessage(messages.type),
              'hidden sm:table-cell'
            )}
            {header(
              'tracks',
              intl.formatMessage(messages.tracks),
              'w-24 hidden sm:table-cell'
            )}
            <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-300">
              {intl.formatMessage(messages.status)}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-700 bg-gray-900">
          {sortAlbums(albums, sort).map((album) => {
            const status = shownStatus(album.mediaInfo?.status);

            return (
              <tr key={album.id} className="group hover:bg-gray-800">
                <td className="px-3 py-2">
                  <Link href={`/music/album/${album.id}`}>
                    <div className="relative h-10 w-10 overflow-hidden rounded bg-gray-700">
                      {album.coverUrl ? (
                        <CachedImage
                          type="music"
                          src={album.coverUrl}
                          alt=""
                          fill
                          style={{ objectFit: 'cover' }}
                        />
                      ) : (
                        <MusicalNoteIcon className="m-2 h-6 w-6 text-gray-400" />
                      )}
                    </div>
                  </Link>
                </td>
                <td className="px-3 py-2 text-sm font-medium text-white">
                  <Link
                    href={`/music/album/${album.id}`}
                    className="hover:underline"
                  >
                    {album.title}
                  </Link>
                </td>
                <td className="px-3 py-2 text-sm text-gray-300">
                  {albumYear(album)}
                </td>
                <td className="hidden px-3 py-2 text-sm text-gray-300 sm:table-cell">
                  {albumTypeLabel(album) || '—'}
                </td>
                <td className="hidden px-3 py-2 text-sm text-gray-300 sm:table-cell">
                  {album.trackCount ?? '—'}
                </td>
                <td className="px-3 py-2 text-sm">
                  {/* the status and the request action share one column,
                      aligned right: an available album shows its badge, one
                      not requested its Request button, a requested one both */}
                  <div className="flex items-center justify-end gap-2">
                    {status !== undefined && (
                      <StatusBadge status={status} title={album.title} />
                    )}
                    {/* the request action shows on hovering the row (and on
                        keyboard focus); on a phone, which has no hover, always */}
                    <div className="transition-opacity sm:opacity-0 sm:focus-within:opacity-100 sm:group-hover:opacity-100">
                      <MusicRequestButton
                        kind="album"
                        mbid={album.id}
                        title={album.title}
                        media={album.mediaInfo}
                        onUpdate={onUpdate}
                      />
                    </div>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export default AlbumTable;
