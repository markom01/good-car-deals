-- AlterTable
ALTER TABLE "listings" ADD COLUMN     "deviation_pct" DOUBLE PRECISION,
ADD COLUMN     "engine_cc" INTEGER,
ADD COLUMN     "expected_price" DOUBLE PRECISION,
ADD COLUMN     "fuel_type" TEXT,
ADD COLUMN     "location" TEXT,
ADD COLUMN     "power_kw" INTEGER,
ADD COLUMN     "transmission" TEXT;
