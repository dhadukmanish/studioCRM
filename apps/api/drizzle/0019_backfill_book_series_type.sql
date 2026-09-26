-- Backfill books.series_type (added by 0018 with DEFAULT 'WITH_GST') from the bills each book has
-- actually issued. A book whose bills are ALL Without GST becomes a Without GST series; every other
-- book — no bills yet, only With GST bills, or a mix — keeps the With GST default. Nothing else is
-- touched: no counter, no bill, no tax mode, no number. Idempotent: re-running changes nothing.
UPDATE "books" b
SET "series_type" = 'WITHOUT_GST'
WHERE b."series_type" = 'WITH_GST'
  AND EXISTS (SELECT 1 FROM "bills" x WHERE x."book_id" = b."id" AND x."tenant_id" = b."tenant_id")
  AND NOT EXISTS (
    SELECT 1 FROM "bills" x WHERE x."book_id" = b."id" AND x."tenant_id" = b."tenant_id" AND x."tax_mode" <> 'WITHOUT_GST'
  );
