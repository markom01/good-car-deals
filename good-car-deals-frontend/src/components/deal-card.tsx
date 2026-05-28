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

function formatNumber(n: number | null): string {
  if (n === null || n === undefined) return 'N/A';
  return Math.round(n).toLocaleString('en-US');
}

export function DealCard({ deal }: { deal: Listing }) {
  return (
    <Card className="min-w-[320px] max-w-md w-full">
      <CardHeader>
        <CardTitle className="line-clamp-2">{deal.title}</CardTitle>
        <CardDescription>
          {deal.model ?? 'N/A'} &middot; {deal.year ?? 'N/A'} &middot; {formatNumber(deal.mileageKm)} km
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex items-baseline justify-between">
          <span className="text-muted-foreground text-sm">Price</span>
          <span className="text-2xl font-bold tabular-nums tracking-tight">
            {deal.priceNumeric != null ? formatNumber(deal.priceNumeric) : deal.price}
          </span>
        </div>

        {deal.priceToModelAvgPct !== null && deal.modelAvgPriceNumeric !== null && (
          <div className="flex items-center gap-2">
            <Badge
              variant={
                deal.priceToModelAvgPct < 0
                  ? 'default'
                  : deal.priceToModelAvgPct > 0
                    ? 'destructive'
                    : 'ghost'
              }
            >
              {deal.priceToModelAvgPct > 0 ? '+' : ''}{Math.round(deal.priceToModelAvgPct)}%
            </Badge>
            <span className="text-muted-foreground text-xs">
              compared to model average of €{formatNumber(deal.modelAvgPriceNumeric)}
            </span>
          </div>
        )}

        <Separator />

        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <span className="text-muted-foreground">Deal Score</span>
          <span className="text-right font-mono tabular-nums">{deal.dealScore != null ? Math.round(deal.dealScore).toLocaleString('en-US') : 'N/A'}</span>
          <span className="text-muted-foreground">Price/Year</span>
          <span className="text-right font-mono tabular-nums">{formatNumber(deal.pricePerYear)}</span>
        </div>
      </CardContent>

      <CardFooter>
        <Button className="w-full" asChild>
          <a href={deal.listingUrl} target="_blank" rel="noopener noreferrer">
            View Listing &rarr;
          </a>
        </Button>
      </CardFooter>
    </Card>
  );
}
