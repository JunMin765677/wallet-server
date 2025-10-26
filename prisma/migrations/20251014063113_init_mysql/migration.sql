-- CreateTable
CREATE TABLE `VcTransaction` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `transactionId` VARCHAR(64) NOT NULL,
    `vcUid` VARCHAR(128) NOT NULL,
    `mode` ENUM('DATA', 'NODATA') NOT NULL,
    `requestPayload` JSON NOT NULL,
    `responsePayload` JSON NULL,
    `status` ENUM('CREATED', 'EXPIRED', 'ERROR') NOT NULL DEFAULT 'CREATED',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `VcTransaction_transactionId_key`(`transactionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `VcCredential` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `cid` VARCHAR(128) NOT NULL,
    `transactionId` VARCHAR(64) NOT NULL,
    `rawJwt` LONGTEXT NOT NULL,
    `status` ENUM('ISSUED', 'REVOKED') NOT NULL DEFAULT 'ISSUED',
    `issuedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `revokedAt` DATETIME(3) NULL,

    UNIQUE INDEX `VcCredential_cid_key`(`cid`),
    UNIQUE INDEX `VcCredential_transactionId_key`(`transactionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `VpRequest` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `transactionId` VARCHAR(64) NOT NULL,
    `ref` VARCHAR(128) NOT NULL,
    `status` ENUM('CREATED', 'COMPLETED', 'TIMEOUT') NOT NULL DEFAULT 'CREATED',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `VpRequest_transactionId_key`(`transactionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `VpResult` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `transactionId` VARCHAR(64) NOT NULL,
    `verifyResult` BOOLEAN NOT NULL,
    `claims` JSON NOT NULL,
    `raw` JSON NOT NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `VpResult_transactionId_key`(`transactionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `VcCredential` ADD CONSTRAINT `VcCredential_transactionId_fkey` FOREIGN KEY (`transactionId`) REFERENCES `VcTransaction`(`transactionId`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `VpResult` ADD CONSTRAINT `VpResult_transactionId_fkey` FOREIGN KEY (`transactionId`) REFERENCES `VpRequest`(`transactionId`) ON DELETE CASCADE ON UPDATE CASCADE;
