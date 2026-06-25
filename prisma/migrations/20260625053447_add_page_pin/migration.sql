-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_facebook_pages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "credential_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "name" TEXT,
    "category" TEXT,
    "picture_url" TEXT,
    "page_access_token" TEXT,
    "tasks" TEXT NOT NULL DEFAULT '[]',
    "webhook_subscribed" BOOLEAN NOT NULL DEFAULT false,
    "webhook_subscribed_at" DATETIME,
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "pinned_at" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "facebook_pages_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "facebook_credentials" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_facebook_pages" ("category", "created_at", "credential_id", "id", "name", "organization_id", "page_access_token", "page_id", "picture_url", "status", "tasks", "updated_at", "webhook_subscribed", "webhook_subscribed_at") SELECT "category", "created_at", "credential_id", "id", "name", "organization_id", "page_access_token", "page_id", "picture_url", "status", "tasks", "updated_at", "webhook_subscribed", "webhook_subscribed_at" FROM "facebook_pages";
DROP TABLE "facebook_pages";
ALTER TABLE "new_facebook_pages" RENAME TO "facebook_pages";
CREATE INDEX "facebook_pages_credential_id_idx" ON "facebook_pages"("credential_id");
CREATE UNIQUE INDEX "facebook_pages_organization_id_page_id_key" ON "facebook_pages"("organization_id", "page_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
