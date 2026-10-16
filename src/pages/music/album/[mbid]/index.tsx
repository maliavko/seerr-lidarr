import type { MusicAlbumDetails as MusicAlbumDetailsType } from '@app/components/AlbumDetails';
import AlbumDetails from '@app/components/AlbumDetails';
import { getHostAndPort } from '@app/utils/urlHelper';
import axios from 'axios';
import type { GetServerSideProps, NextPage } from 'next';

interface MusicAlbumPageProps {
  album?: MusicAlbumDetailsType;
  statusCode?: number;
}

const MusicAlbumPage: NextPage<MusicAlbumPageProps> = ({
  album,
  statusCode,
}) => {
  return <AlbumDetails album={album} statusCode={statusCode} />;
};

export const getServerSideProps: GetServerSideProps<
  MusicAlbumPageProps
> = async (ctx) => {
  try {
    const response = await axios.get<MusicAlbumDetailsType>(
      `http://${getHostAndPort()}/api/v1/music/album/${ctx.query.mbid}`,
      {
        headers: ctx.req?.headers?.cookie
          ? { cookie: ctx.req.headers.cookie }
          : undefined,
      }
    );

    return {
      props: {
        album: response.data,
      },
    };
  } catch (e) {
    // an unknown id, or a source that fails: the page says so
    return {
      props: {
        statusCode: axios.isAxiosError(e) ? (e.response?.status ?? 500) : 500,
      },
    };
  }
};

export default MusicAlbumPage;
