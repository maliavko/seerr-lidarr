import Spinner from '@app/assets/spinner.svg';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import MusicRequestEditModal from '@app/components/RequestModal/MusicRequestEditModal';
import StatusBadge from '@app/components/StatusBadge';
import useMusicRequestMedia, {
  useRefreshRequestLists,
} from '@app/hooks/useMusicRequestMedia';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { canEditMusicRequest } from '@app/utils/musicRequests';
import {
  ArrowPathIcon,
  CheckIcon,
  PencilIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/solid';
import { MediaRequestStatus } from '@server/constants/media';
import type { RequestResultsResponse } from '@server/interfaces/api/requestInterfaces';
import axios from 'axios';
import Link from 'next/link';
import { useState } from 'react';
import { useInView } from 'react-intersection-observer';
import { FormattedRelativeTime, useIntl } from 'react-intl';

const messages = defineMessages('components.RequestList.MusicRequestItem', {
  failedretry: 'Something went wrong while retrying the request.',
  failedmodify: 'Something went wrong while modifying the request.',
  requested: 'Requested',
  requesteddate: 'Requested',
  modified: 'Modified',
  modifieduserdate: '{date} by {user}',
  editrequest: 'Edit Request',
  deleterequest: 'Delete Request',
  cancelRequest: 'Cancel Request',
  unknowntitle: 'Unknown Title',
  musicalbum: 'Album',
  musicartist: 'Artist',
});

interface MusicRequestItemProps {
  request: RequestResultsResponse['results'][number];
  revalidateList: () => void;
}

// A music request's row in the requests lists (R-12): the album's cover or the
// artist's image (a placeholder where there is none), the album's title and
// artist or the artist's name, its kind, the requester, the date, the request's
// status and its media's status, and by whom it was handled; the actions a
// movie request's row offers the same user, and the edit of its requester
// (D-311). The metadata comes from the music routes, never TMDB (D-9); where
// they fail the row shows what the request has (R-14).
const MusicRequestItem = ({
  request,
  revalidateList,
}: MusicRequestItemProps) => {
  const { ref, inView } = useInView({ triggerOnce: true });
  const { addToast } = useToasts();
  const intl = useIntl();
  const { user, hasPermission } = useUser();
  const refreshLists = useRefreshRequestLists();
  const music = useMusicRequestMedia(request, inView);
  const [showEditModal, setShowEditModal] = useState(false);
  const [isRetrying, setRetrying] = useState(false);
  const [updatingType, setUpdatingType] = useState<
    'approve' | 'decline' | null
  >(null);

  const canManage = hasPermission(Permission.MANAGE_REQUESTS);
  const title = music.title ?? intl.formatMessage(messages.unknowntitle);
  // while the music route is being read the title is a bar, not a guess

  const modifyRequest = async (type: 'approve' | 'decline') => {
    setUpdatingType(type);
    try {
      await axios.post(`/api/v1/request/${request.id}/${type}`);
      revalidateList();
      refreshLists();
    } catch {
      addToast(intl.formatMessage(messages.failedmodify), {
        autoDismiss: true,
        appearance: 'error',
      });
    } finally {
      setUpdatingType(null);
    }
  };

  const deleteRequest = async () => {
    await axios.delete(`/api/v1/request/${request.id}`);
    revalidateList();
    refreshLists();
  };

  const retryRequest = async () => {
    setRetrying(true);

    try {
      await axios.post(`/api/v1/request/${request.id}/retry`);
      revalidateList();
      refreshLists();
    } catch {
      addToast(intl.formatMessage(messages.failedretry), {
        autoDismiss: true,
        appearance: 'error',
      });
    } finally {
      setRetrying(false);
    }
  };

  const canEdit = canEditMusicRequest({
    status: request.status,
    requesterId: request.requestedBy.id,
    userId: user?.id,
    canManageRequests: canManage,
    canRequestAdvanced: hasPermission(Permission.REQUEST_ADVANCED),
  });

  const relativeTime = (date: Date | string) => (
    <FormattedRelativeTime
      value={Math.floor((new Date(date).getTime() - Date.now()) / 1000)}
      updateIntervalInSeconds={1}
      numeric="auto"
    />
  );

  const userLink = (handler: {
    id: number;
    avatar: string;
    displayName: string;
  }) => (
    <Link
      href={`/users/${handler.id}`}
      className="group flex items-center truncate"
    >
      <span className="avatar-sm ml-1.5">
        <CachedImage
          type="avatar"
          src={handler.avatar}
          alt=""
          className="avatar-sm object-cover"
          width={20}
          height={20}
        />
      </span>
      <span className="truncate text-sm font-semibold group-hover:text-white group-hover:underline">
        {handler.displayName}
      </span>
    </Link>
  );

  const titleLink = music.href ?? '#';

  return (
    <>
      {music.kind && (
        <MusicRequestEditModal
          show={showEditModal}
          request={request}
          kind={music.kind}
          title={music.title}
          onCancel={() => setShowEditModal(false)}
          onComplete={() => {
            revalidateList();
            refreshLists();
            setShowEditModal(false);
          }}
        />
      )}
      <div
        ref={ref}
        className="relative flex w-full flex-col justify-between overflow-hidden rounded-xl bg-gray-800 py-2 text-gray-400 shadow-md ring-1 ring-gray-700 xl:h-28 xl:flex-row"
        data-testid="music-request-item"
      >
        <div className="relative flex w-full flex-col justify-between overflow-hidden sm:flex-row">
          <div className="relative z-10 flex w-full items-center overflow-hidden pl-4 pr-4 sm:pr-0 xl:w-7/12 2xl:w-2/3">
            <Link
              href={titleLink}
              className="relative h-auto w-12 flex-shrink-0 scale-100 transform-gpu overflow-hidden rounded-md transition duration-300 hover:scale-105"
            >
              <CachedImage
                type="music"
                src={music.image ?? ''}
                alt=""
                sizes="100vw"
                style={{ width: '100%', height: 'auto', objectFit: 'cover' }}
                width={600}
                height={900}
              />
            </Link>
            <div className="flex flex-col justify-center overflow-hidden pl-2 xl:pl-4">
              <div
                className="pt-0.5 text-xs font-medium text-white sm:pt-1"
                data-testid="music-request-kind"
              >
                {intl.formatMessage(
                  music.kind === 'artist'
                    ? messages.musicartist
                    : messages.musicalbum
                )}
              </div>
              <Link
                href={titleLink}
                className="mr-2 min-w-0 truncate text-lg font-bold text-white hover:underline xl:text-xl"
                data-testid="music-request-title"
              >
                {music.loading ? (
                  <span className="inline-block h-5 w-40 animate-pulse rounded bg-gray-700" />
                ) : (
                  title
                )}
              </Link>
              {music.artist && (
                <Link
                  href={`/music/artist/${music.artist.id}`}
                  className="mr-2 min-w-0 truncate text-sm hover:text-white hover:underline"
                  data-testid="music-request-artist"
                >
                  {music.artist.name}
                </Link>
              )}
            </div>
          </div>
          <div className="z-10 ml-4 mt-4 flex w-full flex-col justify-center gap-1 overflow-hidden pr-4 text-sm sm:ml-2 sm:mt-0 xl:flex-1 xl:pr-0">
            <div className="card-field">
              <span className="card-field-name">
                {intl.formatMessage(globalMessages.status)}
              </span>
              {request.status === MediaRequestStatus.DECLINED ? (
                <Badge badgeType="danger">
                  {intl.formatMessage(globalMessages.declined)}
                </Badge>
              ) : request.status === MediaRequestStatus.FAILED ? (
                <Badge badgeType="danger" href={music.href}>
                  {intl.formatMessage(globalMessages.failed)}
                </Badge>
              ) : (
                <StatusBadge status={request.media.status} title={title} />
              )}
            </div>
            <div className="card-field">
              {hasPermission(
                [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
                { type: 'or' }
              ) ? (
                <>
                  <span className="card-field-name">
                    {intl.formatMessage(messages.requested)}
                  </span>
                  <span className="flex truncate text-sm text-gray-300">
                    {intl.formatMessage(messages.modifieduserdate, {
                      date: relativeTime(request.createdAt),
                      user: userLink(request.requestedBy),
                    })}
                  </span>
                </>
              ) : (
                <>
                  <span className="card-field-name">
                    {intl.formatMessage(messages.requesteddate)}
                  </span>
                  <span className="flex truncate text-sm text-gray-300">
                    {relativeTime(request.createdAt)}
                  </span>
                </>
              )}
            </div>
            {request.modifiedBy && (
              <div className="card-field">
                <span className="card-field-name">
                  {intl.formatMessage(messages.modified)}
                </span>
                <span className="flex truncate text-sm text-gray-300">
                  {intl.formatMessage(messages.modifieduserdate, {
                    date: relativeTime(request.updatedAt),
                    user: userLink(request.modifiedBy),
                  })}
                </span>
              </div>
            )}
          </div>
        </div>
        <div className="z-10 mt-4 flex w-full flex-col justify-center space-y-2 pl-4 pr-4 xl:mt-0 xl:w-96 xl:items-end xl:pl-0">
          {request.status === MediaRequestStatus.FAILED && canManage && (
            <Button
              className="w-full"
              buttonType="primary"
              disabled={isRetrying}
              onClick={() => retryRequest()}
            >
              <ArrowPathIcon
                className={isRetrying ? 'animate-spin' : ''}
                style={{ animationDirection: 'reverse' }}
              />
              <span>
                {intl.formatMessage(
                  isRetrying ? globalMessages.retrying : globalMessages.retry
                )}
              </span>
            </Button>
          )}
          {request.status !== MediaRequestStatus.PENDING && canManage && (
            <ConfirmButton
              onClick={() => deleteRequest()}
              confirmText={intl.formatMessage(globalMessages.areyousure)}
              className="w-full"
            >
              <TrashIcon />
              <span>{intl.formatMessage(messages.deleterequest)}</span>
            </ConfirmButton>
          )}
          {request.status === MediaRequestStatus.PENDING && canManage && (
            <div className="flex w-full flex-row space-x-2">
              <span className="w-full">
                <Button
                  className="w-full"
                  buttonType="success"
                  onClick={() => modifyRequest('approve')}
                  disabled={updatingType !== null}
                >
                  {updatingType === 'approve' ? <Spinner /> : <CheckIcon />}
                  <span>{intl.formatMessage(globalMessages.approve)}</span>
                </Button>
              </span>
              <span className="w-full">
                <Button
                  className="w-full"
                  buttonType="danger"
                  onClick={() => modifyRequest('decline')}
                  disabled={updatingType !== null}
                >
                  {updatingType === 'decline' ? <Spinner /> : <XMarkIcon />}
                  <span>{intl.formatMessage(globalMessages.decline)}</span>
                </Button>
              </span>
            </div>
          )}
          {canEdit && music.kind && (
            <span className="w-full">
              <Button
                className="w-full"
                buttonType="primary"
                onClick={() => setShowEditModal(true)}
                disabled={updatingType !== null}
              >
                <PencilIcon />
                <span>{intl.formatMessage(messages.editrequest)}</span>
              </Button>
            </span>
          )}
          {request.status === MediaRequestStatus.PENDING &&
            !canManage &&
            request.requestedBy.id === user?.id && (
              <ConfirmButton
                onClick={() => deleteRequest()}
                confirmText={intl.formatMessage(globalMessages.areyousure)}
                className="w-full"
              >
                <XMarkIcon />
                <span>{intl.formatMessage(messages.cancelRequest)}</span>
              </ConfirmButton>
            )}
        </div>
      </div>
    </>
  );
};

export default MusicRequestItem;
