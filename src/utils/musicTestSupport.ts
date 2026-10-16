// Support for the tests of the music cards, pages and images: it lets the
// repo's node:test runner (which has no component renderer and compiles with
// the server's TypeScript project) load and render the client's components to
// static markup. Not a test file itself.
import path from 'node:path';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import type * as TsNode from 'ts-node';
import type * as TsconfigPaths from 'tsconfig-paths';

let prepared = false;

// Compile the client's .tsx without the server project's type check (which
// cannot resolve '@app/*'), resolve '@app/*', and load images as empty modules.
// Types of the client are checked by `pnpm typecheck`.
const prepare = () => {
  if (prepared) {
    return;
  }
  prepared = true;

  const root = path.join(__dirname, '../..');
  /* eslint-disable @typescript-eslint/no-require-imports */
  const tsNode = require('ts-node') as typeof TsNode;
  const paths = require('tsconfig-paths') as typeof TsconfigPaths;
  /* eslint-enable @typescript-eslint/no-require-imports */

  // the instance the runner registered type-checks; step it aside
  (process as unknown as Record<symbol, { enabled: (e: boolean) => void }>)[
    Symbol.for('ts-node.register.instance')
  ]?.enabled(false);
  tsNode.register({
    transpileOnly: true,
    files: false,
    project: path.join(root, 'server/tsconfig.json'),
  });
  paths.register({
    baseUrl: path.join(root, 'src'),
    paths: { '@app/*': ['*'] },
  });

  for (const extension of ['.svg', '.css']) {
    require.extensions[extension] = (module) => {
      module.exports = { default: 'svg', __esModule: true };
    };
  }
};

// Load a client module (by its path under src/) after the preparation above.
export const loadClient = <T = { default: ComponentType<never> }>(
  modulePath: string
): T => {
  prepare();

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(path.join(__dirname, '..', modulePath)) as T;
};

// Render an element as the client does: with react-intl (English messages) and
// the router a page reads its query from.
export const renderClient = async (
  element: (RouterContext: unknown) => React.ReactElement,
  query: Record<string, string> = {}
): Promise<string> => {
  prepare();

  const messages = (await import('../i18n/locale/en.json')).default;
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { RouterContext } =
    require('next/dist/shared/lib/router-context.shared-runtime') as {
      RouterContext: React.Context<unknown>;
    };
  /* eslint-enable @typescript-eslint/no-require-imports */

  return renderToStaticMarkup(
    createElement(
      IntlProvider,
      { locale: 'en', messages },
      createElement(
        RouterContext.Provider,
        { value: { query, pathname: '/', asPath: '/', push: () => {} } },
        element(RouterContext)
      )
    )
  );
};
