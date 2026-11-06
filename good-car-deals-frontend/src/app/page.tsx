import { Suspense } from 'react';
import { DealList, DealListSkeleton } from '@/components';
import { fetchServerDeals } from '@/lib/fetch-deals';

// ISR: re-render the page (and refetch /deals) at most once per 60s,
// serving stale-while-revalidate in between so the backend isn't hit on
// every request. Page 1 of 50 deals stays well under Next.js's 2MB
// data-cache limit.
export const revalidate = 60;

export default async function HomePage() {
  const dealsPage = await fetchServerDeals({ page: 1 });

  return (
    <main className="container mx-auto max-w-7xl px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Good Car Deals</h1>
      <Suspense fallback={<DealListSkeleton />}>
        <DealList page={dealsPage} />
      </Suspense>
    </main>
  );
}
