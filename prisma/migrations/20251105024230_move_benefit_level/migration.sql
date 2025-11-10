/*
  Warnings:

  - You are about to drop the column `benefitLevel` on the `Person` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE `IssuedVC` ADD COLUMN `benefitLevel` VARCHAR(100) NULL;

-- AlterTable
ALTER TABLE `Person` DROP COLUMN `benefitLevel`;
