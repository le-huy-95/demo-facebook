-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "facebook_credentials" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL DEFAULT 'default-org',
    "friendly_name" TEXT NOT NULL,
    "fb_user_id" TEXT,
    "fb_user_name" TEXT,
    "user_access_token" TEXT,
    "user_token_expires_at" TIMESTAMP(3),
    "user_token_status" TEXT NOT NULL DEFAULT 'VALID',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "facebook_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "facebook_pages" (
    "id" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "name" TEXT,
    "category" TEXT,
    "picture_url" TEXT,
    "page_access_token" TEXT,
    "tasks" TEXT NOT NULL DEFAULT '[]',
    "webhook_subscribed" BOOLEAN NOT NULL DEFAULT false,
    "webhook_subscribed_at" TIMESTAMP(3),
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "pinned_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "facebook_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
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
    "parent_comment_id" TEXT,
    "msg_type" TEXT,
    "content" TEXT,
    "raw_payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "delivery_status" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_profiles" (
    "id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "sender_id" TEXT NOT NULL,
    "sender_name" TEXT,
    "picture_url" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_read_states" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "last_read_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_read_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messenger_message_reactions" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "reactor_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messenger_message_reactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pinned_thread_messages" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "pinned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pinned_thread_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "facebook_credentials_organization_id_idx" ON "facebook_credentials"("organization_id");

-- CreateIndex
CREATE INDEX "facebook_pages_credential_id_idx" ON "facebook_pages"("credential_id");

-- CreateIndex
CREATE UNIQUE INDEX "facebook_pages_organization_id_page_id_key" ON "facebook_pages"("organization_id", "page_id");

-- CreateIndex
CREATE INDEX "webhook_events_page_id_idx" ON "webhook_events"("page_id");

-- CreateIndex
CREATE INDEX "webhook_events_event_type_idx" ON "webhook_events"("event_type");

-- CreateIndex
CREATE INDEX "webhook_events_created_at_idx" ON "webhook_events"("created_at");

-- CreateIndex
CREATE INDEX "webhook_events_status_idx" ON "webhook_events"("status");

-- CreateIndex
CREATE INDEX "customer_profiles_page_id_idx" ON "customer_profiles"("page_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_profiles_page_id_sender_id_key" ON "customer_profiles"("page_id", "sender_id");

-- CreateIndex
CREATE INDEX "conversation_read_states_page_id_idx" ON "conversation_read_states"("page_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_read_states_organization_id_page_id_thread_id_key" ON "conversation_read_states"("organization_id", "page_id", "thread_id");

-- CreateIndex
CREATE INDEX "messenger_message_reactions_page_id_thread_id_idx" ON "messenger_message_reactions"("page_id", "thread_id");

-- CreateIndex
CREATE UNIQUE INDEX "messenger_message_reactions_page_id_thread_id_message_id_re_key" ON "messenger_message_reactions"("page_id", "thread_id", "message_id", "reactor_id");

-- CreateIndex
CREATE INDEX "pinned_thread_messages_page_id_thread_id_idx" ON "pinned_thread_messages"("page_id", "thread_id");

-- CreateIndex
CREATE UNIQUE INDEX "pinned_thread_messages_page_id_thread_id_message_id_key" ON "pinned_thread_messages"("page_id", "thread_id", "message_id");

-- AddForeignKey
ALTER TABLE "facebook_pages" ADD CONSTRAINT "facebook_pages_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "facebook_credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;
