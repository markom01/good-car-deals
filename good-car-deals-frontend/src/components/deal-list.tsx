'use client';

import { useCallback, useMemo } from 'react';
import {
  List,
  useDynamicRowHeight,
  type RowComponentProps,
} from 'react-window';
import type { Listing } from '@good-car-deals/shared';
import { useDeals } from '@/hooks/use-deals';
import { useColumns } from '@/hooks/use-columns';
import { chunk } from '@/lib/chunk';
import { DealCard } from './deal-card';
import {
  Card,
  CardHeader,
  CardContent,
  CardFooter,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Empty,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from '@/components/ui/empty';
import { Button } from '@/components/ui/button';

/** Vertical gap between rows, in px; also the row's bottom padding. */
const ROW_GAP = 24;
/** Fallback row height before the first row is measured. */
const ROW_ESTIMATE = 420;

type DealRowProps = {
  rows: Listing[][];
  columns: number;
};

/**
 * One virtualized row: a CSS grid holding the same cards the old static grid
 * rendered. Rendered outside the component so react-window does not remount
 * it on every parent render.
 */
function DealRow({
  index,
  style,
  rows,
  columns,
}: RowComponentProps<DealRowProps>) {
  return (
    <div
      style={{
        ...style,
        display: 'grid',
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        columnGap: ROW_GAP,
        paddingBottom: ROW_GAP,
      }}
    >
      {rows[index].map((deal) => (
        <div key={deal.id} className="flex justify-center">
          <DealCard deal={deal} />
        </div>
      ))}
    </div>
  );
}

export function DealList() {
  const { data: deals, isLoading, isError, error, refetch } = useDeals();
  const columns = useColumns();

  const rows = useMemo(() => chunk(deals ?? [], columns), [deals, columns]);
  const rowProps = useMemo(() => ({ rows, columns }), [rows, columns]);

  // Row heights vary: some cards carry a plate-origin row and a generation
  // benchmark row. ResizeObserver keeps the scroll extent accurate.
  const rowHeight = useDynamicRowHeight({
    defaultRowHeight: ROW_ESTIMATE + ROW_GAP,
    key: columns,
  });

  const rowKey = useCallback(
    (index: number, data: DealRowProps) => data.rows[index][0]?.id ?? index,
    [],
  );

  // Loading state — show only on initial load (not background refetches)
  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 auto-rows-fr">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <CardTitle>
                <Skeleton className="h-4 w-3/4" />
              </CardTitle>
              <CardDescription>
                <Skeleton className="h-3 w-1/2" />
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-1/3" />
            </CardContent>
            <CardFooter>
              <Skeleton className="h-10 w-full" />
            </CardFooter>
          </Card>
        ))}
      </div>
    );
  }

  // Error state
  if (isError) {
    return (
      <Empty>
        <EmptyTitle>Something went wrong</EmptyTitle>
        <EmptyDescription>
          {error?.message ??
            'Failed to load deals. The API may be starting up.'}
        </EmptyDescription>
        <EmptyContent>
          <Button onClick={() => refetch()}>Try Again</Button>
        </EmptyContent>
      </Empty>
    );
  }

  // Empty state
  if (deals && deals.length === 0) {
    return (
      <Empty>
        <EmptyTitle>No deals found</EmptyTitle>
        <EmptyDescription>
          No good deals found right now. Check back after the next weekly
          update.
        </EmptyDescription>
      </Empty>
    );
  }

  // Row-virtualized grid: the page keeps scrolling normally (window scroller),
  // only the rows near the viewport are mounted.
  return (
    <List
      rowComponent={DealRow}
      rowProps={rowProps}
      rowCount={rows.length}
      rowHeight={rowHeight}
      rowKey={rowKey}
      scrollElement="window"
      overscanCount={3}
      defaultHeight={900}
    />
  );
}
