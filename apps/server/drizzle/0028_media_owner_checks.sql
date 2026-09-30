-- A2.12b security review: guards for component-owned media (0027).
--
-- A component id is a storage key segment (components/<id>/…). Until
-- A2.12b the create route accepted a client-chosen id, so a legacy row may
-- hold one with a slash that reaches into another component's keys. New rows
-- are restricted to the nanoid alphabet; NOT VALID leaves existing rows to
-- the storage code, which refuses such ids (media/mediaOwner.ts).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'components_id_storage_safe') THEN
    ALTER TABLE "components"
      ADD CONSTRAINT "components_id_storage_safe" CHECK ("id" ~ '^[A-Za-z0-9_-]{1,64}$') NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
-- A media row has at most one owner: a deck, a component master, or a
-- folder (fonts).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'media_assets_one_owner') THEN
    ALTER TABLE "media_assets"
      ADD CONSTRAINT "media_assets_one_owner" CHECK (num_nonnulls("deck_id", "component_id", "folder_id") <= 1);
  END IF;
END $$;
