import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import StatusBadgeMini from '@app/components/Common/StatusBadgeMini';
import MusicRequestModal from '@app/components/RequestModal/MusicRequestModal';
import { useIsTouch } from '@app/hooks/useIsTouch';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { releaseYear, shownStatus } from '@app/utils/musicHelpers';
import { Transition } from '@headlessui/react';
import { ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import { MediaStatus } from '@server/constants/media';
import Link from 'next/link';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.MusicCard', {
  artist: 'Artist',
  album: 'Album',
});

export interface MusicCardProps {
  // the MusicBrainz id
  id: string;
  image?: string;
  title: string;
  // an album card's artist, where known
  artistName?: string;
  releaseDate?: string;
  status?: MediaStatus;
  canExpand?: boolean;
}

interface BaseMusicCardProps extends MusicCardProps {
  kind: 'artist' | 'album';
}

// The shape of TitleCard, for an artist or an album: marked Artist or Album,
// its image or a placeholder, its status where known, linking to its page.
export const MusicCard = ({
  kind,
  id,
  image,
  title,
  artistName,
  releaseDate,
  status,
  canExpand = false,
}: BaseMusicCardProps) => {
  const isTouch = useIsTouch();
  const intl = useIntl();
  const { hasPermission } = useUser();
  const [showDetail, setShowDetail] = useState(false);
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [currentStatus, setCurrentStatus] = useState(status);

  useEffect(() => {
    setCurrentStatus(status);
  }, [status]);

  const requestComplete = useCallback((newStatus: MediaStatus) => {
    setCurrentStatus(newStatus);
    setShowRequestModal(false);
  }, []);

  const closeModal = useCallback(() => setShowRequestModal(false), []);

  // An album's card offers the request, as a movie's card does, where its
  // status is unknown and its user may request music (D-362, R-10).
  const showRequestButton =
    kind === 'album' &&
    hasPermission([Permission.REQUEST, Permission.REQUEST_MUSIC], {
      type: 'or',
    }) &&
    (!currentStatus || currentStatus === MediaStatus.UNKNOWN);

  const year = releaseYear(releaseDate);

  return (
    <div
      className={canExpand ? 'w-full' : 'w-36 sm:w-36 md:w-44'}
      data-testid={`${kind}-card`}
    >
      {kind === 'album' && (
        <MusicRequestModal
          show={showRequestModal}
          kind="album"
          mbid={id}
          title={title}
          onComplete={requestComplete}
          onUpdating={setIsUpdating}
          onCancel={closeModal}
        />
      )}
      <div
        className={`relative transform-gpu cursor-default overflow-hidden rounded-xl bg-gray-800 bg-cover outline-none ring-1 transition duration-300 ${
          showDetail
            ? 'scale-105 shadow-lg ring-gray-500'
            : 'scale-100 shadow ring-gray-700'
        }`}
        style={{
          paddingBottom: '150%',
        }}
        onMouseEnter={() => {
          if (!isTouch) {
            setShowDetail(true);
          }
        }}
        onMouseLeave={() => setShowDetail(false)}
        onClick={() => setShowDetail(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            setShowDetail(true);
          }
        }}
        role="link"
        tabIndex={0}
      >
        <div className="absolute inset-0 h-full w-full overflow-hidden">
          <CachedImage
            type="music"
            className="absolute inset-0 h-full w-full"
            alt=""
            src={image ?? ''}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            fill
          />
          <div className="absolute left-0 right-0 flex items-center justify-between p-2">
            <div className="pointer-events-none z-40 self-start rounded-full border border-pink-500 bg-pink-600/80 shadow-md">
              <div
                className="flex h-4 items-center px-2 py-2 text-center text-xs font-medium uppercase tracking-wider text-white sm:h-5"
                data-testid="music-card-kind"
              >
                {intl.formatMessage(
                  kind === 'artist' ? messages.artist : messages.album
                )}
              </div>
            </div>
            {shownStatus(currentStatus) !== undefined && (
              <div className="flex flex-col items-center gap-1">
                <div className="pointer-events-none z-40 flex">
                  <StatusBadgeMini
                    status={currentStatus as MediaStatus}
                    shrink
                  />
                </div>
              </div>
            )}
          </div>
          <Transition
            as={Fragment}
            show={!image || showDetail || showRequestModal}
            enter="transition-opacity"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="transition-opacity"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="absolute inset-0 overflow-hidden rounded-xl">
              <Link
                href={`/music/${kind}/${id}`}
                className="absolute inset-0 h-full w-full cursor-pointer overflow-hidden text-left"
                style={{
                  background:
                    'linear-gradient(180deg, rgba(45, 55, 72, 0.4) 0%, rgba(45, 55, 72, 0.9) 100%)',
                }}
              >
                <div className="flex h-full w-full items-end">
                  <div
                    className={`px-2 text-white ${
                      showRequestButton ? 'pb-11' : 'pb-2'
                    }`}
                  >
                    {year && <div className="text-sm font-medium">{year}</div>}
                    <h1
                      className="whitespace-normal text-xl font-bold leading-tight"
                      style={{
                        WebkitLineClamp: 3,
                        display: '-webkit-box',
                        overflow: 'hidden',
                        WebkitBoxOrient: 'vertical',
                        wordBreak: 'break-word',
                      }}
                      data-testid="music-card-title"
                    >
                      {title}
                    </h1>
                    {artistName && (
                      <div
                        className="whitespace-normal text-sm"
                        style={{
                          WebkitLineClamp: 2,
                          display: '-webkit-box',
                          overflow: 'hidden',
                          WebkitBoxOrient: 'vertical',
                          wordBreak: 'break-word',
                        }}
                        data-testid="music-card-artist"
                      >
                        {artistName}
                      </div>
                    )}
                  </div>
                </div>
              </Link>

              {showRequestButton && (
                <div className="absolute bottom-0 left-0 right-0 flex justify-between px-2 py-2">
                  <Button
                    buttonType="primary"
                    buttonSize="sm"
                    disabled={isUpdating}
                    onClick={(e) => {
                      e.preventDefault();
                      setShowRequestModal(true);
                    }}
                    className="h-7 w-full"
                    data-testid="music-card-request"
                  >
                    <ArrowDownTrayIcon />
                    <span>{intl.formatMessage(globalMessages.request)}</span>
                  </Button>
                </div>
              )}
            </div>
          </Transition>
        </div>
      </div>
    </div>
  );
};

export default MusicCard;
