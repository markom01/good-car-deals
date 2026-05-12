-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "listings" (
    "id" BIGSERIAL NOT NULL,
    "listing_url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "price" TEXT NOT NULL,
    "price_numeric" INTEGER,
    "price_note" TEXT,
    "year" INTEGER,
    "age" INTEGER,
    "mileage_km" INTEGER,
    "model" TEXT,
    "deal_type" TEXT,
    "deal_score" DOUBLE PRECISION,
    "price_per_year" DOUBLE PRECISION,
    "scraped_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "listings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "listings_listing_url_key" ON "listings"("listing_url");
