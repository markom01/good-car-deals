import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import type { Listing } from '@good-car-deals/shared';
import { estimateSerbiaImportCostsEur } from '@good-car-deals/shared';

function formatNumber(n: number | null): string {
  if (n === null || n === undefined) return 'N/A';
  return Math.round(n).toLocaleString('en-US');
}

export function DealCard({ deal }: { deal: Listing }) {
  const specs = [
    deal.fuelType,
    deal.engineCc != null ? `${deal.engineCc} cm³` : null,
    deal.powerKw != null ? `${deal.powerKw} kW` : null,
    deal.transmission,
  ]
    .filter(Boolean)
    .join(' · ');

  const est =
    deal.plateOrigin === 'foreign' && deal.priceNumeric != null
      ? estimateSerbiaImportCostsEur(deal.priceNumeric)
      : null;

  return (
    <Card className="min-w-[320px] max-w-md w-full">
      <CardHeader>
        <CardTitle className="line-clamp-2">{deal.title}</CardTitle>
        <CardDescription>
          {deal.model ?? 'N/A'} &middot; {deal.year ?? 'N/A'} &middot;{' '}
          {formatNumber(deal.mileageKm)} km
          {specs && <> &middot; {specs}</>}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex items-baseline justify-between">
          <span className="text-muted-foreground text-sm">Price</span>
          <span className="text-2xl font-bold tabular-nums tracking-tight">
            {deal.priceNumeric != null
              ? formatNumber(deal.priceNumeric)
              : deal.price}
          </span>
        </div>

        {deal.plateOrigin === 'foreign' && (
          <div className="flex items-center gap-2">
            <Badge variant="secondary">Foreign plates</Badge>
            <span className="text-muted-foreground text-xs">
              import duty and registration not included
            </span>
          </div>
        )}
        {deal.plateOrigin === 'foreign' && deal.priceNumeric != null && (
          <div className="flex items-baseline justify-between text-xs text-muted-foreground">
            <span>+ import &amp; registration (est.)</span>
            <span className="tabular-nums">
              +€{formatNumber(est!.totalAddedEur)} ≈ €{' '}
              {formatNumber(est!.totalRealisticEur)} total
            </span>
          </div>
        )}

        {deal.deviationPct != null && deal.expectedPrice != null && (
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Badge
                variant={
                  deal.deviationPct > 0
                    ? 'default'
                    : deal.deviationPct < 0
                      ? 'destructive'
                      : 'ghost'
                }
              >
                {deal.deviationPct > 0 ? '+' : ''}
                {Math.round(deal.deviationPct)}%
              </Badge>
              <span className="text-muted-foreground text-xs">
                {deal.deviationPct > 0
                  ? 'below typical asking price'
                  : deal.deviationPct < 0
                    ? 'above typical asking price'
                    : 'at typical asking price'}
              </span>
            </div>
            <p className="text-muted-foreground text-xs">
              {deal.expectedPriceSampleSize != null
                ? `€${formatNumber(deal.expectedPrice)} · based on ${deal.expectedPriceSampleSize} similar ads`
                : `€${formatNumber(deal.expectedPrice)}`}
            </p>
          </div>
        )}

        <Separator />

        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <span className="text-muted-foreground">Deal Score</span>
          <span className="text-right font-mono tabular-nums">
            {deal.dealScore != null
              ? Math.round(deal.dealScore).toLocaleString('en-US')
              : 'N/A'}
          </span>
        </div>
      </CardContent>

      {deal.listingUrl && (
        <CardFooter>
          <Button className="w-full" asChild>
            <a href={deal.listingUrl} target="_blank" rel="noopener noreferrer">
              View Listing &rarr;
            </a>
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
