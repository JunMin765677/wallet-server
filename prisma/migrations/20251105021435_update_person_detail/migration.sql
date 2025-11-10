/*
  Warnings:

  - You are about to drop the column `nationalIdHash` on the `Person` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE `Person` DROP COLUMN `nationalIdHash`,
    ADD COLUMN `benefitLevel` VARCHAR(100) NULL,
    ADD COLUMN `eligibilityEndDate` DATE NULL,
    ADD COLUMN `eligibilityStartDate` DATE NULL,
    ADD COLUMN `emergencyContactName` VARCHAR(255) NULL,
    ADD COLUMN `emergencyContactRelationship` VARCHAR(100) NULL,
    ADD COLUMN `familyAnnualIncome` BIGINT NULL,
    ADD COLUMN `familyMovableAssets` BIGINT NULL,
    ADD COLUMN `familyRealEstateAssets` BIGINT NULL,
    ADD COLUMN `nationalId` VARCHAR(255) NULL,
    ADD COLUMN `personalAnnualIncome` BIGINT NULL,
    ADD COLUMN `personalMovableAssets` BIGINT NULL,
    ADD COLUMN `personalRealEstateAssets` BIGINT NULL,
    ADD COLUMN `reviewerName` VARCHAR(255) NULL,
    ADD COLUMN `reviewerPhone` VARCHAR(50) NULL,
    ADD COLUMN `reviewingAuthority` VARCHAR(255) NULL;

-- AlterTable
ALTER TABLE `VerificationLog` ADD COLUMN `verifierBranch` VARCHAR(255) NULL;
