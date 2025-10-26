-- AlterTable
ALTER TABLE `VpResult` ADD COLUMN `vcCredentialCid` VARCHAR(128) NULL;

-- AddForeignKey
ALTER TABLE `VpResult` ADD CONSTRAINT `VpResult_vcCredentialCid_fkey` FOREIGN KEY (`vcCredentialCid`) REFERENCES `VcCredential`(`cid`) ON DELETE SET NULL ON UPDATE CASCADE;
