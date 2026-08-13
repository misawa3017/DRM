CREATE TYPE "ShareAccessLevel" AS ENUM ('view', 'edit');

CREATE TABLE "document_shares" (
  "id" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "recipientId" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  "accessLevel" "ShareAccessLevel" NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "maskRules" JSONB,
  "maskedObjectKey" TEXT,
  "sourceVersionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "document_shares_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "document_shares_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "document_shares_recipientId_expiresAt_idx" ON "document_shares"("recipientId", "expiresAt");
CREATE INDEX "document_shares_documentId_idx" ON "document_shares"("documentId");

ALTER TYPE "AuditAction" ADD VALUE 'document_share_create';
ALTER TYPE "AuditAction" ADD VALUE 'document_share_update';
ALTER TYPE "AuditAction" ADD VALUE 'document_share_revoke';
ALTER TYPE "AuditAction" ADD VALUE 'document_share_access';
