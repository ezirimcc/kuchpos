-- AlterTable
ALTER TABLE `sale` ADD COLUMN `discountAmount` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `discountPercent` DECIMAL(5, 2) NULL,
    ADD COLUMN `discountReason` VARCHAR(300) NULL;

-- AlterTable
ALTER TABLE `sale_line` ADD COLUMN `discountAmount` DECIMAL(14, 2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `approval` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `kind` ENUM('DISCOUNT', 'CREDIT_OVER_LIMIT') NOT NULL,
    `method` ENUM('AT_SCREEN', 'OWN_SALE') NOT NULL,
    `saleRequestId` CHAR(36) NOT NULL,
    `fingerprint` CHAR(64) NOT NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `basis` DECIMAL(14, 2) NOT NULL,
    `reason` VARCHAR(300) NULL,
    `requestedByUserId` VARCHAR(191) NULL,
    `requestedByName` VARCHAR(191) NOT NULL,
    `approvedByUserId` VARCHAR(191) NULL,
    `approvedByName` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,

    INDEX `approval_businessId_createdAt_idx`(`businessId`, `createdAt`),
    INDEX `approval_businessId_saleRequestId_idx`(`businessId`, `saleRequestId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `approval_use` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `approvalId` CHAR(36) NOT NULL,
    `saleId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `approval_use_approvalId_key`(`approvalId`),
    INDEX `approval_use_saleId_idx`(`saleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `approval` ADD CONSTRAINT `approval_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `approval_use` ADD CONSTRAINT `approval_use_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `approval_use` ADD CONSTRAINT `approval_use_approvalId_fkey` FOREIGN KEY (`approvalId`) REFERENCES `approval`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `approval_use` ADD CONSTRAINT `approval_use_saleId_fkey` FOREIGN KEY (`saleId`) REFERENCES `sale`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Discounts and approvals (added by hand). MariaDB 10.6 compatible.
-- ---------------------------------------------------------------------------

-- A discount is never negative; a line's share is never more than the line.
ALTER TABLE `sale`
  ADD CONSTRAINT `sale_discount_check`
  CHECK (`discountAmount` >= 0 AND (`discountPercent` IS NULL OR (`discountPercent` > 0 AND `discountPercent` <= 100))
         AND (`discountAmount` = 0 OR (`discountReason` IS NOT NULL AND CHAR_LENGTH(TRIM(`discountReason`)) > 0)));

ALTER TABLE `sale_line`
  ADD CONSTRAINT `sale_line_discount_check`
  CHECK (`discountAmount` >= 0 AND `discountAmount` <= `lineTotal`);

ALTER TABLE `approval`
  ADD CONSTRAINT `approval_amounts_check`
  CHECK (`amount` > 0 AND `expiresAt` > `createdAt`);

-- Approvals, and the record of where each was used, are add-only.
CREATE TRIGGER `approval_no_update` BEFORE UPDATE ON `approval`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'approval is add-only: rows cannot be changed.';
CREATE TRIGGER `approval_no_delete` BEFORE DELETE ON `approval`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'approval is add-only: rows cannot be deleted.';
CREATE TRIGGER `approval_use_no_update` BEFORE UPDATE ON `approval_use`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'approval_use is add-only: rows cannot be changed.';
CREATE TRIGGER `approval_use_no_delete` BEFORE DELETE ON `approval_use`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'approval_use is add-only: rows cannot be deleted.';
