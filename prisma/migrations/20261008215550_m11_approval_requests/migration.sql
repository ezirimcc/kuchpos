-- AlterTable
ALTER TABLE `approval` ADD COLUMN `requestId` CHAR(36) NULL,
    MODIFY `method` ENUM('AT_SCREEN', 'OWN_SALE', 'REMOTE') NOT NULL;

-- CreateTable
CREATE TABLE `approval_request` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `kind` ENUM('DISCOUNT', 'CREDIT_OVER_LIMIT') NOT NULL,
    `saleRequestId` CHAR(36) NOT NULL,
    `fingerprint` CHAR(64) NOT NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `basis` DECIMAL(14, 2) NOT NULL,
    `reason` VARCHAR(300) NULL,
    `details` TEXT NOT NULL,
    `requestedByUserId` VARCHAR(191) NULL,
    `requestedByName` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,

    INDEX `approval_request_businessId_createdAt_idx`(`businessId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `approval_request_decision` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `requestId` CHAR(36) NOT NULL,
    `outcome` ENUM('APPROVED', 'REFUSED', 'WITHDRAWN') NOT NULL,
    `note` VARCHAR(300) NULL,
    `decidedByUserId` VARCHAR(191) NULL,
    `decidedByName` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `approval_request_decision_requestId_key`(`requestId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `approval_requestId_key` ON `approval`(`requestId`);

-- AddForeignKey
ALTER TABLE `approval_request` ADD CONSTRAINT `approval_request_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `approval_request_decision` ADD CONSTRAINT `approval_request_decision_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `approval_request_decision` ADD CONSTRAINT `approval_request_decision_requestId_fkey` FOREIGN KEY (`requestId`) REFERENCES `approval_request`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `approval` ADD CONSTRAINT `approval_requestId_fkey` FOREIGN KEY (`requestId`) REFERENCES `approval_request`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------
-- Requests for approval sent to a manager's own computer (added by hand).
-- ---------------------------------------------------------------------------

ALTER TABLE `approval_request`
  ADD CONSTRAINT `approval_request_amounts_check`
  CHECK (`amount` > 0 AND `expiresAt` > `createdAt`);

-- Requests and their answers are add-only.
CREATE TRIGGER `approval_request_no_update` BEFORE UPDATE ON `approval_request`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'approval_request is add-only: rows cannot be changed.';
CREATE TRIGGER `approval_request_no_delete` BEFORE DELETE ON `approval_request`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'approval_request is add-only: rows cannot be deleted.';
CREATE TRIGGER `approval_request_decision_no_update` BEFORE UPDATE ON `approval_request_decision`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'approval_request_decision is add-only: rows cannot be changed.';
CREATE TRIGGER `approval_request_decision_no_delete` BEFORE DELETE ON `approval_request_decision`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'approval_request_decision is add-only: rows cannot be deleted.';
