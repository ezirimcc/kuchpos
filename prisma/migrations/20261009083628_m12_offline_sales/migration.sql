-- AlterTable
ALTER TABLE `sale` ADD COLUMN `offline` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `sentByName` VARCHAR(191) NULL,
    ADD COLUMN `sentByUserId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `sale_line` ADD COLUMN `stockShort` DECIMAL(16, 3) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `terminal` ADD COLUMN `nextOfflineNumber` INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE `offline_exception` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `saleId` CHAR(36) NOT NULL,
    `kind` ENUM('STOCK_SHORT', 'PRICE_DIFFERENT', 'OUT_OF_USE', 'TIME', 'ACCOUNT', 'RECEIPT_NUMBER') NOT NULL,
    `summary` VARCHAR(500) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `offline_exception_businessId_createdAt_idx`(`businessId`, `createdAt`),
    INDEX `offline_exception_saleId_idx`(`saleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `offline_exception_review` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `exceptionId` CHAR(36) NOT NULL,
    `note` VARCHAR(300) NULL,
    `reviewedByUserId` VARCHAR(191) NULL,
    `reviewedByName` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `offline_exception_review_exceptionId_key`(`exceptionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `offline_exception` ADD CONSTRAINT `offline_exception_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `offline_exception` ADD CONSTRAINT `offline_exception_saleId_fkey` FOREIGN KEY (`saleId`) REFERENCES `sale`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `offline_exception_review` ADD CONSTRAINT `offline_exception_review_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `offline_exception_review` ADD CONSTRAINT `offline_exception_review_exceptionId_fkey` FOREIGN KEY (`exceptionId`) REFERENCES `offline_exception`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------
-- Sales made offline (added by hand). MariaDB 10.6 compatible.
-- ---------------------------------------------------------------------------

-- What could not be taken out of stock is never negative and never more than the line.
ALTER TABLE `sale_line`
  ADD CONSTRAINT `sale_line_stock_short_check`
  CHECK (`stockShort` >= 0 AND `stockShort` <= `baseQuantity`);

-- Only an offline sale names who sent it.
ALTER TABLE `sale`
  ADD CONSTRAINT `sale_offline_check`
  CHECK (`offline` = 1 OR (`sentByUserId` IS NULL AND `sentByName` IS NULL));

ALTER TABLE `terminal`
  ADD CONSTRAINT `terminal_offline_number_check`
  CHECK (`nextOfflineNumber` >= 1);

-- Offline exceptions, and the notes that they were looked at, are add-only.
CREATE TRIGGER `offline_exception_no_update` BEFORE UPDATE ON `offline_exception`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'offline_exception is add-only: rows cannot be changed.';
CREATE TRIGGER `offline_exception_no_delete` BEFORE DELETE ON `offline_exception`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'offline_exception is add-only: rows cannot be deleted.';
CREATE TRIGGER `offline_exception_review_no_update` BEFORE UPDATE ON `offline_exception_review`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'offline_exception_review is add-only: rows cannot be changed.';
CREATE TRIGGER `offline_exception_review_no_delete` BEFORE DELETE ON `offline_exception_review`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'offline_exception_review is add-only: rows cannot be deleted.';
