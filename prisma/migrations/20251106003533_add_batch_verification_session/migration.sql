-- AlterTable
ALTER TABLE `VerificationLog` ADD COLUMN `batchVerificationSessionId` BIGINT NULL;

-- CreateTable
CREATE TABLE `BatchVerificationSession` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `uuid` VARCHAR(255) NOT NULL,
    `verifierInfo` VARCHAR(255) NULL,
    `verifierBranch` VARCHAR(255) NULL,
    `verificationReason` VARCHAR(255) NULL,
    `notes` VARCHAR(500) NULL,
    `status` ENUM('active', 'closed', 'expired') NOT NULL,
    `expiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `BatchVerificationSession_uuid_key`(`uuid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `VerificationLog_batchVerificationSessionId_idx` ON `VerificationLog`(`batchVerificationSessionId`);

-- AddForeignKey
ALTER TABLE `VerificationLog` ADD CONSTRAINT `VerificationLog_batchVerificationSessionId_fkey` FOREIGN KEY (`batchVerificationSessionId`) REFERENCES `BatchVerificationSession`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
