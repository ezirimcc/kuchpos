-- AlterTable
ALTER TABLE `business` ADD COLUMN `autoPrintReceipts` BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE `till_cash_request` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `requestId` CHAR(36) NOT NULL,
    `tillSessionId` CHAR(36) NOT NULL,
    `direction` ENUM('IN', 'OUT') NOT NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `note` VARCHAR(300) NOT NULL,
    `requestedByUserId` VARCHAR(191) NULL,
    `requestedByName` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `till_cash_request_tillSessionId_idx`(`tillSessionId`),
    UNIQUE INDEX `till_cash_request_businessId_requestId_key`(`businessId`, `requestId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `till_cash_decision` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `cashRequestId` CHAR(36) NOT NULL,
    `outcome` ENUM('APPROVED', 'REFUSED', 'WITHDRAWN') NOT NULL,
    `note` VARCHAR(300) NULL,
    `decidedByUserId` VARCHAR(191) NULL,
    `decidedByName` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `till_cash_decision_cashRequestId_key`(`cashRequestId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `till_cash_request` ADD CONSTRAINT `till_cash_request_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `till_cash_request` ADD CONSTRAINT `till_cash_request_tillSessionId_fkey` FOREIGN KEY (`tillSessionId`) REFERENCES `till_session`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `till_cash_decision` ADD CONSTRAINT `till_cash_decision_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `till_cash_decision` ADD CONSTRAINT `till_cash_decision_cashRequestId_fkey` FOREIGN KEY (`cashRequestId`) REFERENCES `till_cash_request`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------
-- Cash in and cash out of an open till (added by hand). MariaDB 10.6 compatible.
-- ---------------------------------------------------------------------------

ALTER TABLE `till_cash_request`
  ADD CONSTRAINT `till_cash_request_check`
  CHECK (`amount` > 0 AND CHAR_LENGTH(TRIM(`note`)) > 0);

-- Requests and their answers are add-only.
CREATE TRIGGER `till_cash_request_no_update` BEFORE UPDATE ON `till_cash_request`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'till_cash_request is add-only: rows cannot be changed.';
CREATE TRIGGER `till_cash_request_no_delete` BEFORE DELETE ON `till_cash_request`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'till_cash_request is add-only: rows cannot be deleted.';
CREATE TRIGGER `till_cash_decision_no_update` BEFORE UPDATE ON `till_cash_decision`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'till_cash_decision is add-only: rows cannot be changed.';
CREATE TRIGGER `till_cash_decision_no_delete` BEFORE DELETE ON `till_cash_decision`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'till_cash_decision is add-only: rows cannot be deleted.';
