-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_webhook_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organization_id" TEXT,
    "page_id" TEXT,
    "event_type" TEXT NOT NULL DEFAULT 'MESSENGER',
    "direction" TEXT,
    "sender_id" TEXT,
    "sender_name" TEXT,
    "recipient_id" TEXT,
    "message_id" TEXT,
    "post_id" TEXT,
    "comment_id" TEXT,
    "msg_type" TEXT,
    "content" TEXT,
    "raw_payload" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_webhook_events" ("content", "created_at", "direction", "id", "message_id", "msg_type", "organization_id", "page_id", "raw_payload", "recipient_id", "sender_id") SELECT "content", "created_at", "direction", "id", "message_id", "msg_type", "organization_id", "page_id", "raw_payload", "recipient_id", "sender_id" FROM "webhook_events";
DROP TABLE "webhook_events";
ALTER TABLE "new_webhook_events" RENAME TO "webhook_events";
CREATE INDEX "webhook_events_page_id_idx" ON "webhook_events"("page_id");
CREATE INDEX "webhook_events_event_type_idx" ON "webhook_events"("event_type");
CREATE INDEX "webhook_events_created_at_idx" ON "webhook_events"("created_at");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
