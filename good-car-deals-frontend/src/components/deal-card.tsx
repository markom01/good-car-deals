import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import type { Listing } from '@good-car-deals/shared';

function getBadgeVariant(dealType: string | null): 'default' | 'secondary' | 'destructive' | 'outline' | 'ghost' | 'link' {
  if (!dealType) return 'secondary';
  const lower = dealType.toLowerCase();
  if (lower.includes('great') || lower.includes('good deal') || lower.includes('decent')) return 'default';
  if (lower.includes('overpriced') || lower.includes('bad') || lower.includes('fair')) return 'destructive';
  return 'outline';
}

function formatNumber(n: number | null): string {
  if (n === null || n === undefined) return 'N/A';
  return n.toLocaleString('en-US');
}

export function DealCard({ deal }: { deal: Listing }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="line-clamp-2">{deal.title}</CardTitle>
        <CardDescription>
          {deal.model ?? 'N/A'} &middot; {deal.year ?? 'N/A'} &middot; {formatNumber(deal.mileageKm)} km
        </CardDescription>
      </CardHeader>

      <CardContent>
        <div className="flex items-baseline justify-between">
          <span className="text-muted-foreground text-sm">Price</span>
          <span className="text-2xl font-bold tabular-nums">{deal.priceNumeric != null ? formatNumber(deal.priceNumeric) : deal.price}</span>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-4 pt-4 border-t text-sm">
          <span className="text-muted-foreground">Deal Score</span>
          <span className="text-right font-mono tabular-nums">{deal.dealScore?.toFixed(2) ?? 'N/A'}</span>
          <span className="text-muted-foreground">Price/Year</span>
          <span className="text-right font-mono tabular-nums">{formatNumber(deal.pricePerYear)}</span>
        </div>
      </CardContent>

      <CardFooter className="flex items-center justify-between">
        <Badge variant={getBadgeVariant(deal.dealType)}>
          {deal.dealType ?? 'Unclassified'}
        </Badge>
        <Button variant="link" asChild>
          <a href={deal.listingUrl} target="_blank" rel="noopener noreferrer">
            View Listing &rarr;
          </a>
        </Button>
      </CardFooter>
    </Card>
  );
}