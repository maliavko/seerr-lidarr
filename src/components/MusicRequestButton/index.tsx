import ButtonWithDropdown from '@app/components/Common/ButtonWithDropdown';
import MusicRequestModal from '@app/components/RequestModal/MusicRequestModal';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import {
  CheckIcon,
  InformationCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/solid';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type Media from '@server/entity/Media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import axios from 'axios';
import { useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import { mutate } from 'swr';

const messages = defineMessages('components.MusicRequestButton', {
  viewrequest: 'View Request',
  approverequest: 'Approve Request',
  declinerequest: 'Decline Request',
});

interface MusicRequestButtonProps {
  kind: 'album' | 'artist';
  // the MusicBrainz id
  mbid: string;
  title: string;
  // the item's mediaInfo: its status is the server's computed one (D-362)
  media?: Media;
  onUpdate: () => void;
}

// Whether the request action is offered for an item (D-362): an album where
// its status is UNKNOWN, an artist where its status is not AVAILABLE and none
// of its own requests stands (pending, approved or failed).
export const isRequestOffered = (
  kind: 'album' | 'artist',
  media?: Media
): boolean => {
  const status = media?.status ?? MediaStatus.UNKNOWN;

  if (kind === 'album') {
    return status === MediaStatus.UNKNOWN;
  }

  return (
    status !== MediaStatus.AVAILABLE &&
    !(media?.requests ?? []).some(
      (request) =>
        request.status === MediaRequestStatus.PENDING ||
        request.status === MediaRequestStatus.APPROVED ||
        request.status === MediaRequestStatus.FAILED
    )
  );
};

// Request, view, approve and decline of an album's or an artist's request, as
// RequestButton does them for a movie, with no 4K, season, server or profile.
const MusicRequestButton = ({
  kind,
  mbid,
  title,
  media,
  onUpdate,
}: MusicRequestButtonProps) => {
  const intl = useIntl();
  const { user, hasPermission } = useUser();
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [editRequest, setEditRequest] = useState(false);

  const activeRequests = (media?.requests ?? []).filter(
    (request) => request.status === MediaRequestStatus.PENDING
  );

  // The current user's pending request, or the first pending one
  const activeRequest = useMemo(
    () =>
      activeRequests && activeRequests.length > 0
        ? (activeRequests.find(
            (request) => request.requestedBy.id === user?.id
          ) ?? activeRequests[0])
        : undefined,
    [activeRequests, user]
  );

  const modifyRequest = async (
    request: MediaRequest,
    type: 'approve' | 'decline'
  ) => {
    const response = await axios.post(`/api/v1/request/${request.id}/${type}`);

    if (response) {
      onUpdate();
      mutate('/api/v1/request/count');
    }
  };

  const buttons: {
    id: string;
    text: string;
    action: () => void;
    svg: React.ReactNode;
  }[] = [];

  if (activeRequest) {
    if (
      activeRequest.requestedBy.id === user?.id ||
      (activeRequests?.length === 1 &&
        hasPermission(Permission.MANAGE_REQUESTS))
    ) {
      buttons.push({
        id: 'active-request',
        text: intl.formatMessage(messages.viewrequest),
        action: () => {
          setEditRequest(true);
          setShowRequestModal(true);
        },
        svg: <InformationCircleIcon />,
      });
    }

    if (hasPermission(Permission.MANAGE_REQUESTS)) {
      buttons.push(
        {
          id: 'approve-request',
          text: intl.formatMessage(messages.approverequest),
          action: () => {
            modifyRequest(activeRequest, 'approve');
          },
          svg: <CheckIcon />,
        },
        {
          id: 'decline-request',
          text: intl.formatMessage(messages.declinerequest),
          action: () => {
            modifyRequest(activeRequest, 'decline');
          },
          svg: <XMarkIcon />,
        }
      );
    }
  }

  if (
    isRequestOffered(kind, media) &&
    hasPermission([Permission.REQUEST, Permission.REQUEST_MUSIC], {
      type: 'or',
    })
  ) {
    buttons.push({
      id: 'request',
      text: intl.formatMessage(globalMessages.request),
      action: () => {
        setEditRequest(false);
        setShowRequestModal(true);
      },
      svg: <ArrowDownTrayIcon />,
    });
  }

  const [buttonOne, ...others] = buttons;

  if (!buttonOne) {
    return null;
  }

  return (
    <>
      <MusicRequestModal
        show={showRequestModal}
        kind={kind}
        mbid={mbid}
        title={title}
        editRequest={editRequest ? activeRequest : undefined}
        onComplete={() => {
          onUpdate();
          setShowRequestModal(false);
        }}
        onCancel={() => setShowRequestModal(false)}
      />
      <div data-testid="music-request-button" className="flex">
        <ButtonWithDropdown
          text={
            <>
              {buttonOne.svg}
              <span>{buttonOne.text}</span>
            </>
          }
          onClick={buttonOne.action}
          className="ml-2"
        >
          {others.length > 0
            ? others.map((button) => (
                <ButtonWithDropdown.Item
                  onClick={button.action}
                  key={`request-option-${button.id}`}
                >
                  {button.svg}
                  <span>{button.text}</span>
                </ButtonWithDropdown.Item>
              ))
            : null}
        </ButtonWithDropdown>
      </div>
    </>
  );
};

export default MusicRequestButton;
