import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"

export default function WheelRankPage() {
  return (
    <div className="min-h-screen bg-background">
      <main className="mx-auto max-w-5xl px-4 py-16 md:py-24">
        {/* 1. HERO SECTION — Split layout */}
        <div className="grid grid-cols-1 items-center gap-12 md:grid-cols-5">
          <div className="md:col-span-3">
            <img
              src="/wheelrank-logo.svg"
              alt="WheelRank"
              className="mb-6 size-16"
            />
            <Badge variant="secondary" className="mb-4">
              Raising Starts 2026
            </Badge>
            <h1 className="mb-4 text-4xl font-bold tracking-tight">
              WheelRank
            </h1>
            <p className="mb-4 text-xl text-muted-foreground">
              Used car deals, ranked.
            </p>
            <p className="mb-8 max-w-prose text-base text-muted-foreground">
              WheelRank analyzes used car listings and assigns every deal a Deal Score —
              an objective 0-100 rating based on market data. Stop guessing. Start ranking.
            </p>
            <Button variant="default" size="lg">
              Learn More
            </Button>
          </div>
          <div className="md:col-span-2">
            <div className="flex aspect-[4/3] items-center justify-center rounded-2xl border-2 border-dashed border-border bg-muted">
              <p className="text-sm text-muted-foreground">App screenshot</p>
            </div>
          </div>
        </div>

        {/* Separator between Hero and Stats */}
        <Separator className="my-16 md:my-24" />

        {/* 2. MARKET STATS SECTION */}
        <section className="mb-16 md:mb-24">
          <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
            {/* Stat 1: Save Time */}
            <div>
              <p className="mb-2 text-3xl font-bold text-primary">95%</p>
              <p className="mb-1 text-sm text-muted-foreground">
                of buyers research 14+ hours before purchase
              </p>
              <a
                href="https://www.coxautoinc.com/wp-content/uploads/2025/01/2024-Car-Buyer-Journey-Study-Research-Summary.pdf"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground underline"
              >
                Source: Cox Automotive 2024
              </a>
            </div>

            {/* Stat 2: Save Money */}
            <div>
              <p className="mb-2 text-3xl font-bold text-primary">21%</p>
              <p className="mb-1 text-sm text-muted-foreground">
                average overpay on cars with rolled back odometers
              </p>
              <a
                href="https://www.carvertical.com/blog/odometer-fraud-vs-car-value"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground underline"
              >
                Source: carVertical 2025
              </a>
            </div>

            {/* Stat 3: Market Context */}
            <div>
              <p className="mb-2 text-3xl font-bold text-primary">€67.9B</p>
              <p className="mb-1 text-sm text-muted-foreground">
                Europe used car market value (2026)
              </p>
              <a
                href="https://www.marketdataforecast.com/market-reports/europe-used-cars-market"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground underline"
              >
                Source: MarketDataForecast 2026
              </a>
            </div>
          </div>
        </section>

        {/* 3. PROBLEM SECTION */}
        <section className="mb-16 md:mb-24">
          <Card>
            <CardHeader>
              <Badge variant="secondary" className="mb-2 w-fit">
                Used Car Market
              </Badge>
              <CardTitle>The Problem</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground">
                Serbia&apos;s largest classifieds site lists ~75,000–80,000 used cars,
                yet no tool provides an objective assessment. Buyers navigate subjective ads,
                hidden defects, and no standardized way to compare deals.
              </p>
            </CardContent>
          </Card>
        </section>

        {/* 4. SOLUTION SECTION */}
        <section className="mb-16 md:mb-24">
          <Card>
            <CardHeader>
              <Badge variant="secondary" className="mb-2 w-fit">
                WheelRank
              </Badge>
              <CardTitle>The Deal Score</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-4 text-muted-foreground">
                WheelRank assigns every listing a Deal Score (0–100) using two methods:
                price-per-year ranking and model average comparison.
              </p>
              <ul className="flex flex-col gap-3 text-sm">
                <li className="flex items-center gap-2">
                  <span className="size-2 rounded-full bg-primary" />
                  <span>
                    <strong className="text-foreground">GOOD DEAL</strong>{" "}
                    <span className="text-muted-foreground">(top 20%) — Score 80–100</span>
                  </span>
                </li>
                <li className="flex items-center gap-2">
                  <span className="size-2 rounded-full bg-primary/60" />
                  <span>
                    <strong className="text-foreground">DECENT DEAL</strong>{" "}
                    <span className="text-muted-foreground">(20–50%) — Score 50–79</span>
                  </span>
                </li>
                <li className="flex items-center gap-2">
                  <span className="size-2 rounded-full bg-destructive" />
                  <span>
                    <strong className="text-foreground">OVERPRICED</strong>{" "}
                    <span className="text-muted-foreground">(bottom 50%) — Score 0–49</span>
                  </span>
                </li>
              </ul>
            </CardContent>
          </Card>
        </section>

        {/* 5. BENEFITS SECTION */}
        <section className="mb-16 md:mb-24">
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">⏱ Save Time</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Instant rankings instead of hours of browsing.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">💰 Save Money</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Data-driven deal scoring reduces overpaying risk.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">🧠 Peace of Mind</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Objective analysis, not gut feeling.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">📊 Transparency</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  See exactly why a deal is scored the way it is.
                </p>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* 6. CTA SECTION */}
        <section className="mb-16 md:mb-24">
          <Card>
            <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
              <h3 className="text-2xl font-bold">
                Part of Raising Starts 2026
              </h3>
              <p className="max-w-md text-muted-foreground">
                WheelRank is participating in the Raising Starts accelerator program
                by NTP Belgrade, supported by the Swiss Government.
              </p>
              <Button variant="default" size="lg">
                Learn More
              </Button>
            </CardContent>
          </Card>
        </section>

        {/* Separator before Footer */}
        <Separator className="mb-8" />

        {/* 7. FOOTER */}
        <footer>
          <p className="text-sm text-muted-foreground">
            &copy; 2026 WheelRank
          </p>
        </footer>
      </main>
    </div>
  )
}
