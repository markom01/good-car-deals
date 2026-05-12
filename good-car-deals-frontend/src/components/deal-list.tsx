'use client';

import { useDeals } from '@/hooks/use-deals';
import { DealCard } from './deal-card';

export function DealList() {
  const { data: deals } = useDeals();
  
  if (!deals) return null;
  
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {deals.map((deal) => (
        <DealCard key={deal.id} deal={deal} />
      ))}
    </div>
  );
}