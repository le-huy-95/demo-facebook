-- CreateTable
CREATE TABLE "customer_profiles" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "page_id" TEXT NOT NULL,
    "sender_id" TEXT NOT NULL,
    "sender_name" TEXT,
    "picture_url" TEXT,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "customer_profiles_page_id_idx" ON "customer_profiles"("page_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_profiles_page_id_sender_id_key" ON "customer_profiles"("page_id", "sender_id");
