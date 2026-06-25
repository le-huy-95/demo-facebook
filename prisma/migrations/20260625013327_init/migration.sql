-- CreateTable
CREATE TABLE "facebook_credentials" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organization_id" TEXT NOT NULL DEFAULT 'default-org',
    "friendly_name" TEXT NOT NULL,
    "fb_user_id" TEXT,
    "fb_user_name" TEXT,
    "user_access_token" TEXT,
    "user_token_expires_at" DATETIME,
    "user_token_status" TEXT NOT NULL DEFAULT 'VALID',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "facebook_pages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "credential_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "name" TEXT,
    "category" TEXT,
    "page_access_token" TEXT,
    "tasks" TEXT NOT NULL DEFAULT '[]',
    "webhook_subscribed" BOOLEAN NOT NULL DEFAULT false,
    "webhook_subscribed_at" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "facebook_pages_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "facebook_credentials" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organization_id" TEXT,
    "page_id" TEXT,
    "direction" TEXT,
    "sender_id" TEXT,
    "recipient_id" TEXT,
    "message_id" TEXT,
    "msg_type" TEXT,
    "content" TEXT,
    "raw_payload" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "facebook_credentials_organization_id_idx" ON "facebook_credentials"("organization_id");

-- CreateIndex
CREATE INDEX "facebook_pages_credential_id_idx" ON "facebook_pages"("credential_id");

-- CreateIndex
CREATE UNIQUE INDEX "facebook_pages_organization_id_page_id_key" ON "facebook_pages"("organization_id", "page_id");

-- CreateIndex
CREATE INDEX "webhook_events_page_id_idx" ON "webhook_events"("page_id");
