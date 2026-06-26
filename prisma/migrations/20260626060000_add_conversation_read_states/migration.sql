CREATE TABLE "conversation_read_states" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organization_id" TEXT NOT NULL,
  "page_id" TEXT NOT NULL,
  "thread_id" TEXT NOT NULL,
  "last_read_at" DATETIME NOT NULL,
  "updated_at" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "conversation_read_states_organization_id_page_id_thread_id_key"
ON "conversation_read_states"("organization_id", "page_id", "thread_id");

CREATE INDEX "conversation_read_states_page_id_idx"
ON "conversation_read_states"("page_id");
