import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import SearchTypePills from '@app/components/Search/SearchTypePills';
import useDiscover from '@app/hooks/useDiscover';
import useSettings from '@app/hooks/useSettings';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import { readSearchType, searchTypeQuery } from '@app/utils/searchLoading';
import type { KindShown } from '@server/lib/kindsShown';
import type {
  AlbumResult,
  ArtistResult,
  MovieResult,
  PersonResult,
  TvResult,
} from '@server/models/Search';
import { useRouter } from 'next/router';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Search', {
  search: 'Search',
  searchresults: 'Search Results',
});

const Search = () => {
  const intl = useIntl();
  const router = useRouter();
  const { currentSettings } = useSettings();
  const type = readSearchType(router.query.type, currentSettings.kindsShown);

  const {
    isLoadingInitialData,
    isEmpty,
    isLoadingMore,
    isReachingEnd,
    titles,
    fetchMore,
    error,
  } = useDiscover<
    MovieResult | TvResult | PersonResult | ArtistResult | AlbumResult
  >(
    `/api/v1/search`,
    {
      query: router.query.query,
      ...(type ? { type } : {}),
    },
    {
      hideAvailable: false,
      hideBlocklisted: false,
      hideRequested: false,
      endByPageCount: true,
    }
  );

  const selectType = (selected?: KindShown) => {
    router.push({
      pathname: router.pathname,
      query: searchTypeQuery(router.query, selected),
    });
  };

  if (error) {
    return <ErrorPage statusCode={500} />;
  }

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.search)} />
      <div className="mb-5 mt-1">
        <Header>{intl.formatMessage(messages.searchresults)}</Header>
      </div>
      <SearchTypePills
        kindsShown={currentSettings.kindsShown}
        selected={type}
        onSelect={selectType}
      />
      <ListView
        items={titles}
        isEmpty={isEmpty}
        isLoading={
          isLoadingInitialData ||
          (isLoadingMore && (titles?.length ?? 0) > 0) ||
          (titles.length === 0 && !isReachingEnd)
        }
        isReachingEnd={isReachingEnd}
        onScrollBottom={fetchMore}
      />
    </>
  );
};

export default Search;
