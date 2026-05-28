'use client';

import { useDeals } from '@/hooks/use-deals';
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

export function DealList() {
  const { data: deals, isLoading, isError, error, refetch } = useDeals();

  // Loading state — show only on initial load (not background refetches)
  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 auto-rows-fr">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <CardTitle><Skeleton className="h-4 w-3/4" /></CardTitle>
              <CardDescription><Skeleton className="h-3 w-1/2" /></CardDescription>
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
          {error?.message ?? 'Failed to load deals. The API may be starting up.'}
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
          No good deals found right now. Check back after the next weekly update.
        </EmptyDescription>
      </Empty>
    );
  }

  // Normal render
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 auto-rows-fr">
      {(deals ?? []).map((deal) => (
        <div key={deal.id} className="flex justify-center">
          <DealCard deal={deal} />
        </div>
      ))}
    </div>
  );
}
