-- CreateTable
CREATE TABLE `VCTemplate` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `templateName` VARCHAR(100) NOT NULL,
    `vcUid` VARCHAR(255) NULL,
    `description` TEXT NULL,
    `cardImageUrl` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Person` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `personalId` VARCHAR(255) NOT NULL,
    `nationalIdHash` VARCHAR(255) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `county` VARCHAR(50) NULL,
    `district` VARCHAR(50) NULL,
    `address` VARCHAR(500) NULL,
    `phoneNumber` VARCHAR(20) NULL,
    `emergencyContactPhone` VARCHAR(20) NULL,
    `dateOfBirth` DATE NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Person_personalId_key`(`personalId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PersonEligibility` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `personId` BIGINT NOT NULL,
    `templateId` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PersonEligibility_personId_templateId_key`(`personId`, `templateId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `IssuedVC` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `systemUuid` VARCHAR(255) NOT NULL,
    `cid` VARCHAR(255) NULL,
    `issuedData` JSON NOT NULL,
    `status` ENUM('issuing', 'issued', 'expired', 'revoked') NOT NULL,
    `issuedAt` DATETIME(3) NULL,
    `expiredAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `personId` BIGINT NOT NULL,
    `templateId` INTEGER NOT NULL,

    UNIQUE INDEX `IssuedVC_systemUuid_key`(`systemUuid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `IssuanceLog` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `transactionId` VARCHAR(255) NOT NULL,
    `status` ENUM('initiated', 'user_claimed', 'expired') NOT NULL,
    `expiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `issuedVcId` BIGINT NOT NULL,

    UNIQUE INDEX `IssuanceLog_transactionId_key`(`transactionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `VerificationLog` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `transactionId` VARCHAR(255) NOT NULL,
    `verifyResult` BOOLEAN NULL,
    `resultDescription` VARCHAR(255) NULL,
    `returnedData` JSON NULL,
    `verifierInfo` VARCHAR(255) NULL,
    `verificationReason` VARCHAR(255) NULL,
    `notes` VARCHAR(500) NULL,
    `status` ENUM('initiated', 'success', 'failed', 'expired', 'error_missing_uuid') NOT NULL,
    `expiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `verifiedPersonId` BIGINT NULL,

    UNIQUE INDEX `VerificationLog_transactionId_key`(`transactionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PersonEligibility` ADD CONSTRAINT `PersonEligibility_personId_fkey` FOREIGN KEY (`personId`) REFERENCES `Person`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PersonEligibility` ADD CONSTRAINT `PersonEligibility_templateId_fkey` FOREIGN KEY (`templateId`) REFERENCES `VCTemplate`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `IssuedVC` ADD CONSTRAINT `IssuedVC_personId_fkey` FOREIGN KEY (`personId`) REFERENCES `Person`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `IssuedVC` ADD CONSTRAINT `IssuedVC_templateId_fkey` FOREIGN KEY (`templateId`) REFERENCES `VCTemplate`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `IssuanceLog` ADD CONSTRAINT `IssuanceLog_issuedVcId_fkey` FOREIGN KEY (`issuedVcId`) REFERENCES `IssuedVC`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `VerificationLog` ADD CONSTRAINT `VerificationLog_verifiedPersonId_fkey` FOREIGN KEY (`verifiedPersonId`) REFERENCES `Person`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
