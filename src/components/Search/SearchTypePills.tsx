import defineMessages from '@app/utils/defineMessages';
import type { KindShown } from '@server/lib/kindsShown';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Search', {
  typeAll: 'All',
  typeMovies: 'Movies',
  typeSeries: 'Series',
  typeMusic: 'Music',
  typePeople: 'People',
  typeFilter: 'Filter results by type',
});

// All always; the others only while their kind is shown, in this order.
const pills = [
  { type: undefined, message: messages.typeAll },
  { type: 'movie', message: messages.typeMovies },
  { type: 'tv', message: messages.typeSeries },
  { type: 'music', message: messages.typeMusic },
  { type: 'person', message: messages.typePeople },
] as const;

interface SearchTypePillsProps {
  kindsShown: readonly KindShown[];
  selected?: KindShown;
  onSelect: (type?: KindShown) => void;
}

const SearchTypePills = ({
  kindsShown,
  selected,
  onSelect,
}: SearchTypePillsProps) => {
  const intl = useIntl();

  return (
    <div
      className="mb-5 flex flex-wrap gap-2"
      role="group"
      aria-label={intl.formatMessage(messages.typeFilter)}
      data-testid="search-type-pills"
    >
      {pills
        .filter((pill) => !pill.type || kindsShown.includes(pill.type))
        .map((pill) => {
          const active = pill.type === selected;

          return (
            <button
              key={pill.type ?? 'all'}
              type="button"
              aria-pressed={active}
              data-testid={`search-type-${pill.type ?? 'all'}`}
              className={`rounded-full px-4 py-1 text-sm font-medium transition duration-150 ease-in-out focus:outline-none focus:ring ${
                active
                  ? 'bg-indigo-500 text-white'
                  : 'bg-gray-700 text-gray-200 hover:bg-gray-600'
              }`}
              onClick={() => onSelect(pill.type)}
            >
              {intl.formatMessage(pill.message)}
            </button>
          );
        })}
    </div>
  );
};

export default SearchTypePills;
