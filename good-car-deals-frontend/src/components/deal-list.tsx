'use client';

import { useDeals } from '@/hooks/use-deals';
import { DealCard } from './deal-card';

export function DealList() {
  const { data: deals } = useDeals();
  
  if (!deals) return null;
  
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 auto-rows-fr">
      {deals.map((deal) => (
        <div key={deal.id} className="flex justify-center">
          <DealCard deal={deal} />
        </div>
      ))}
    </div>
  );
}