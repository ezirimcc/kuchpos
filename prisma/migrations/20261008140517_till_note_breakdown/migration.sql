-- AlterTable
ALTER TABLE `till_session` ADD COLUMN `floatBreakdown` VARCHAR(300) NULL;

-- AlterTable
ALTER TABLE `till_session_close` ADD COLUMN `breakdown` VARCHAR(300) NULL;

-- AlterTable
ALTER TABLE `till_session_recount` ADD COLUMN `breakdown` VARCHAR(300) NULL;
