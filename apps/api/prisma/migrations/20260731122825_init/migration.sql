-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "keycloakSub" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "department" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_keycloakSub_key" ON "users"("keycloakSub");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
