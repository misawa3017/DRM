-- DropIndex
DROP INDEX "users_email_key";

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");
