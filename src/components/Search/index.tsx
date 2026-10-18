import Button from '@app/components/Common/Button';
import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import SearchTypePills from '@app/components/Search/SearchTypePills';
import useDiscover from '@app/hooks/useDiscover';
import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import { recordKeptSearchType, tabStorage } from '@app/utils/searchKeptType';
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
  loadFailed: 'The search results could not be loaded.',
  retry: 'Retry',
});

const Search = () => {
  const intl = useIntl();
  const router = useRouter();
  const { currentSettings } = useSettings();
  const type = readSearchType(router.query.type, currentSettings.kindsShown);

  const { titles, fetchMore, searchState, retry } = useDiscover<
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
    // the type chosen for this tab, before the address is pushed (F2-D-341)
    recordKeptSearchType(tabStorage(), selected);
    router.push({
      pathname: router.pathname,
      query: searchTypeQuery(router.query, selected),
    });
  };

  // what the page shows is the pure helper's answer from the list of the query
  // and type in the address alone (F2-D-341 (a)); useDiscover always gives it
  // with endByPageCount
  const state = searchState!;

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
        isEmpty={state.kind === 'noResults'}
        isLoading={state.loading}
        isReachingEnd={state.reachingEnd}
        onScrollBottom={fetchMore}
      />
      {state.kind === 'failed' && (
        <div
          className="mt-8 flex flex-col items-center gap-4 text-center text-gray-300"
          data-testid="search-load-failed"
          role="alert"
        >
          <p className="text-lg">{intl.formatMessage(messages.loadFailed)}</p>
          <Button
            buttonType="primary"
            data-testid="search-retry"
            onClick={() => retry?.()}
          >
            {intl.formatMessage(messages.retry)}
          </Button>
        </div>
      )}
    </>
  );
};

export default Search;
