-- CreateTable
CREATE TABLE `till_session_recount` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `sessionId` CHAR(36) NOT NULL,
    `expectedCash` DECIMAL(14, 2) NOT NULL,
    `countedCash` DECIMAL(14, 2) NOT NULL,
    `difference` DECIMAL(14, 2) NOT NULL,
    `note` VARCHAR(300) NOT NULL,
    `recountedByUserId` VARCHAR(191) NULL,
    `recountedByName` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `till_session_recount_sessionId_createdAt_idx`(`sessionId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `till_session_recount` ADD CONSTRAINT `till_session_recount_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `till_session_recount` ADD CONSTRAINT `till_session_recount_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `till_session`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Till recounts (added by hand). MariaDB 10.6 compatible.
-- ---------------------------------------------------------------------------

ALTER TABLE `till_session_recount`
  ADD CONSTRAINT `till_session_recount_amounts_check`
  CHECK (`countedCash` >= 0 AND `expectedCash` >= 0 AND `difference` = `countedCash` - `expectedCash`
         AND CHAR_LENGTH(TRIM(`note`)) > 0);

-- A recount is a record of its own and is add-only.
CREATE TRIGGER `till_session_recount_no_update` BEFORE UPDATE ON `till_session_recount`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'till_session_recount is add-only: rows cannot be changed.';
CREATE TRIGGER `till_session_recount_no_delete` BEFORE DELETE ON `till_session_recount`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'till_session_recount is add-only: rows cannot be deleted.';
