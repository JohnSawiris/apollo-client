import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useSyncExternalStore } from 'use-sync-external-store';
import { equal } from '@wry/equality';
import { OperationVariables } from '../../core';
import { getApolloContext } from '../context';
//import { ApolloError } from '../../errors';
import {
  ApolloQueryResult,
  //NetworkStatus,
  ObservableQuery,
  DocumentNode,
  TypedDocumentNode,
  WatchQueryOptions,
} from '../../core';
import {
  QueryHookOptions,
  QueryResult,
} from '../types/types';

import { DocumentType, verifyDocumentType } from '../parser';
import { useApolloClient } from './useApolloClient';

export function useQuery<
  TData = any,
  TVariables = OperationVariables,
>(
  query: DocumentNode | TypedDocumentNode<TData, TVariables>,
  options?: QueryHookOptions<TData, TVariables>,
): QueryResult<TData> {
  const context = useContext(getApolloContext());
  const client = useApolloClient(options?.client);
  verifyDocumentType(query, DocumentType.Query);
  const ref = useRef({
    client,
    query,
    options,
    watchQueryOptions: createWatchQueryOptions(query, options),
  });

  const [obsQuery, setObsQuery] = useState(() => {
    const watchQueryOptions = createWatchQueryOptions(query, options);
    // See if there is an existing observable that was used to fetch the same
    // data and if so, use it instead since it will contain the proper queryId
    // to fetch the result set. This is used during SSR.
    let obsQuery: ObservableQuery<TData, TVariables> | null = null;
    if (context.renderPromises) {
      obsQuery = context.renderPromises.getSSRObservable(watchQueryOptions);
    }

    if (!obsQuery) {
      // Is it safe (StrictMode/memory-wise) to call client.watchQuery here?
      obsQuery = client.watchQuery(watchQueryOptions);
      if (context.renderPromises) {
        context.renderPromises.registerSSRObservable(
          obsQuery,
          watchQueryOptions,
        );
      }
    }

    if (
      context.renderPromises &&
      options?.ssr !== false &&
      !options?.skip &&
      obsQuery.getCurrentResult().loading
    ) {
      // TODO: This is a legacy API which could probably be cleaned up
      context.renderPromises.addQueryPromise(
        {
          // The only options which seem to actually be used by the
          // RenderPromises class are query and variables.
          getOptions: () => createWatchQueryOptions(query, options),
          fetchData: () => new Promise<void>((resolve) => {
            const sub = obsQuery!.subscribe({
              next(result) {
                if (!result.loading) {
                  resolve()
                  sub.unsubscribe();
                }
              },
              error() {
                resolve();
                sub.unsubscribe();
              },
              complete() {
                resolve();
              },
            });
          }),
        },
        // This callback never seemed to do anything
        () => null,
      );
    }

    return obsQuery;
  });

  const [subscribe, getSnapshot] = useMemo(() => {
    let previousResult: ApolloQueryResult<TData> | undefined;

    const subscribe = (handleStoreChange: () => void) => {
      const subscription = obsQuery.subscribe(
        handleStoreChange,
        handleStoreChange,
      );

      return () => {
        subscription.unsubscribe();
      };
    };

    const getSnapshot = () => {
      const result = obsQuery.getCurrentResult();
      if (
        !(
          previousResult &&
          previousResult.loading === result.loading &&
          previousResult.networkStatus === result.networkStatus &&
          equal(previousResult.data, result.data)
        )
      ) {
        previousResult = result;
      }

      return previousResult;
    };

    return [subscribe, getSnapshot];
  }, [obsQuery]);

  // An effect to recreate the obsQuery whenever the client or query changes.
  // This effect is also responsible for checking and updating the obsQuery
  // options whenever they change.
  useEffect(() => {
    const watchQueryOptions = createWatchQueryOptions(query, options);
    //let nextResult: ApolloQueryResult<TData> | undefined;
    if (ref.current.client !== client || !equal(ref.current.query, query)) {
      const obsQuery = client.watchQuery(watchQueryOptions);
      setObsQuery(obsQuery);
    } else if (!equal(ref.current.watchQueryOptions, watchQueryOptions)) {
      obsQuery.setOptions(watchQueryOptions).catch(() => {});
    }

    Object.assign(ref.current, { client, query, options });
  }, [obsQuery, client, query, options]);

  const result = useSyncExternalStore(subscribe, getSnapshot);
  const obsQueryMethods = useMemo(() => ({
    refetch: obsQuery.refetch.bind(obsQuery),
    fetchMore: obsQuery.fetchMore.bind(obsQuery),
    updateQuery: obsQuery.updateQuery.bind(obsQuery),
    startPolling: obsQuery.startPolling.bind(obsQuery),
    stopPolling: obsQuery.stopPolling.bind(obsQuery),
    subscribeToMore: obsQuery.subscribeToMore.bind(obsQuery),
  }), [obsQuery]);

  return {
    ...obsQueryMethods,
    variables: obsQuery.variables,
    client,
    called: true,
    ...result,
  };
}

function createWatchQueryOptions<TData, TVariables>(
  query: DocumentNode | TypedDocumentNode<TData, TVariables>,
  options: QueryHookOptions<TData, TVariables> = {},
): WatchQueryOptions<TVariables, TData> {
  // TODO: For some reason, we pass context, which is the React Apollo Context,
  // into observable queries, and test for that.
  // removing hook specific options
  const {
    skip,
    ssr,
    onCompleted,
    onError,
    displayName,
    ...watchQueryOptions
  } = options;

  if (skip) {
    watchQueryOptions.fetchPolicy = 'standby';
  } else if (
    watchQueryOptions.context?.renderPromises &&
    (
      watchQueryOptions.fetchPolicy === 'network-only' ||
      watchQueryOptions.fetchPolicy === 'cache-and-network'
    )
  ) {
    // this behavior was added to react-apollo without explanation in this PR
    // https://github.com/apollographql/react-apollo/pull/1579
    watchQueryOptions.fetchPolicy = 'cache-first';
  } else if (!watchQueryOptions.fetchPolicy) {
    // cache-first is the default policy, but we explicitly assign it here so
    // the cache policies computed based on options can be cleared
    watchQueryOptions.fetchPolicy = 'cache-first';
  }

  return { query, ...watchQueryOptions };
}
