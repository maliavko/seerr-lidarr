import AlbumTable from '@app/components/ArtistDetails/AlbumTable';
import CachedImage from '@app/components/Common/CachedImage';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import SimilarArtistsSlider from '@app/components/Discover/SimilarArtistsSlider';
import AlbumCard from '@app/components/MusicCard/AlbumCard';
import MusicRequestButton from '@app/components/MusicRequestButton';
import StatusBadge from '@app/components/StatusBadge';
import ErrorPage from '@app/pages/_error';
import type { AlbumView } from '@app/utils/albumTable';
import { readAlbumView, saveAlbumView } from '@app/utils/albumTable';
import defineMessages from '@app/utils/defineMessages';
import { shownStatus } from '@app/utils/musicHelpers';
import { Squares2X2Icon, TableCellsIcon } from '@heroicons/react/24/outline';
import type Media from '@server/entity/Media';
import axios from 'axios';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.ArtistDetails', {
  overview: 'Overview',
  albums: 'Albums',
  cardView: 'Show as cards',
  tableView: 'Show as table',
});

export interface MusicAlbumListItem {
  id: string;
  title: string;
  releaseDate?: string;
  albumType?: string;
  secondaryTypes?: string[];
  trackCount?: number;
  coverUrl?: string;
  mediaInfo?: Media;
}

export interface MusicArtistDetails {
  id: string;
  name: string;
  overview?: string;
  imageUrl?: string;
  backdropUrl?: string;
  artistType?: string;
  disambiguation?: string;
  genres: string[];
  inLidarr: boolean;
  albums: MusicAlbumListItem[];
  mediaInfo?: Media;
}

interface ArtistDetailsProps {
  artist?: MusicArtistDetails;
  // the status of the answer the page could not get, if any
  statusCode?: number;
}

const ArtistDetails = ({ artist, statusCode }: ArtistDetailsProps) => {
  const router = useRouter();
  const intl = useIntl();
  const [albumView, setAlbumView] = useState<AlbumView>('cards');

  // the viewer's last choice, read once in the browser (never on the server)
  useEffect(() => setAlbumView(readAlbumView()), []);

  const chooseAlbumView = (view: AlbumView) => {
    setAlbumView(view);
    saveAlbumView(view);
  };

  const { data, error, mutate } = useSWR<MusicArtistDetails>(
    `/api/v1/music/artist/${router.query.mbid}`,
    { fallbackData: artist }
  );

  if (!data && !error && !statusCode) {
    return <LoadingSpinner />;
  }

  if (!data) {
    const code =
      statusCode ?? (axios.isAxiosError(error) ? error.response?.status : 500);
    return <ErrorPage statusCode={code === 404 ? 404 : 500} />;
  }

  const attributes = [data.artistType, ...data.genres].filter(
    (attribute): attribute is string => !!attribute
  );

  return (
    <div
      className="media-page"
      style={{
        height: 493,
      }}
    >
      {data.backdropUrl && (
        <div className="media-page-bg-image">
          <CachedImage
            type="music"
            alt=""
            src={data.backdropUrl}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            fill
            priority
          />
          <div
            className="absolute inset-0"
            style={{
              backgroundImage:
                'linear-gradient(180deg, rgba(17, 24, 39, 0.47) 0%, rgba(17, 24, 39, 1) 100%)',
            }}
          />
        </div>
      )}
      <PageTitle title={data.name} />
      <div className="media-header">
        <div className="media-poster">
          <CachedImage
            type="music"
            src={data.imageUrl ?? ''}
            alt=""
            sizes="100vw"
            style={{ width: '100%', height: 'auto' }}
            width={600}
            height={900}
            priority
          />
        </div>
        <div className="media-title">
          <div className="media-status" data-testid="music-status">
            {shownStatus(data.mediaInfo?.status) !== undefined && (
              <StatusBadge status={data.mediaInfo?.status} title={data.name} />
            )}
          </div>
          <h1 data-testid="media-title">{data.name}</h1>
          {attributes.length > 0 && (
            <span className="media-attributes">
              {attributes.map((attribute, index) => (
                <span key={`${attribute}-${index}`}>{attribute}</span>
              ))}
            </span>
          )}
        </div>
        <div className="media-actions">
          <MusicRequestButton
            kind="artist"
            mbid={data.id}
            title={data.name}
            media={data.mediaInfo}
            onUpdate={() => mutate()}
          />
        </div>
      </div>
      {data.overview && (
        <div className="media-overview">
          <div className="media-overview-left">
            <h2>{intl.formatMessage(messages.overview)}</h2>
            <p data-testid="artist-overview">{data.overview}</p>
          </div>
        </div>
      )}
      {data.albums.length > 0 && (
        <>
          <div className="slider-header">
            <div className="slider-title">
              <span>{intl.formatMessage(messages.albums)}</span>
            </div>
            <div className="ml-auto flex items-center gap-1 pl-4" role="group">
              {(
                [
                  ['cards', Squares2X2Icon, messages.cardView],
                  ['table', TableCellsIcon, messages.tableView],
                ] as const
              ).map(([view, Icon, label]) => (
                <button
                  key={view}
                  type="button"
                  title={intl.formatMessage(label)}
                  aria-label={intl.formatMessage(label)}
                  aria-pressed={albumView === view}
                  data-testid={`artist-albums-view-${view}`}
                  onClick={() => chooseAlbumView(view)}
                  className={`rounded-md p-1.5 transition ${
                    albumView === view
                      ? 'bg-indigo-600 text-white'
                      : 'text-gray-400 hover:bg-gray-700 hover:text-white'
                  }`}
                >
                  <Icon className="h-5 w-5" />
                </button>
              ))}
            </div>
          </div>
          {albumView === 'table' ? (
            <AlbumTable albums={data.albums} onUpdate={() => mutate()} />
          ) : (
            <ul className="cards-vertical" data-testid="artist-albums">
              {data.albums.map((album) => (
                <li key={album.id}>
                  <AlbumCard
                    id={album.id}
                    title={album.title}
                    releaseDate={album.releaseDate}
                    image={album.coverUrl}
                    status={shownStatus(album.mediaInfo?.status)}
                    canExpand
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <SimilarArtistsSlider mbid={data.id} />
    </div>
  );
};

export default ArtistDetails;
