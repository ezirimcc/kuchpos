-- AlterTable
ALTER TABLE `business` ADD COLUMN `nextStockTransferNumber` INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE `stock_movement` MODIFY `type` ENUM('RECEIPT', 'RECEIPT_CORRECTION', 'TRANSFER_OUT', 'TRANSFER_IN') NOT NULL;

-- CreateTable
CREATE TABLE `stock_transfer` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `requestId` CHAR(36) NOT NULL,
    `number` INTEGER NOT NULL,
    `fromLocationId` CHAR(36) NOT NULL,
    `fromLocationName` VARCHAR(60) NOT NULL,
    `toLocationId` CHAR(36) NOT NULL,
    `toLocationName` VARCHAR(60) NOT NULL,
    `note` VARCHAR(300) NULL,
    `createdByUserId` VARCHAR(191) NULL,
    `createdByName` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `stock_transfer_businessId_createdAt_idx`(`businessId`, `createdAt`),
    UNIQUE INDEX `stock_transfer_businessId_requestId_key`(`businessId`, `requestId`),
    UNIQUE INDEX `stock_transfer_businessId_number_key`(`businessId`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_transfer_line` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `transferId` CHAR(36) NOT NULL,
    `lineNumber` INTEGER NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `productUnitId` CHAR(36) NOT NULL,
    `productName` VARCHAR(120) NOT NULL,
    `unitName` VARCHAR(40) NOT NULL,
    `unitFactor` DECIMAL(12, 3) NOT NULL,
    `quantity` DECIMAL(16, 3) NOT NULL,
    `baseQuantity` DECIMAL(16, 3) NOT NULL,

    INDEX `stock_transfer_line_productId_idx`(`productId`),
    UNIQUE INDEX `stock_transfer_line_transferId_lineNumber_key`(`transferId`, `lineNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `stock_transfer` ADD CONSTRAINT `stock_transfer_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_transfer` ADD CONSTRAINT `stock_transfer_fromLocationId_fkey` FOREIGN KEY (`fromLocationId`) REFERENCES `location`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_transfer` ADD CONSTRAINT `stock_transfer_toLocationId_fkey` FOREIGN KEY (`toLocationId`) REFERENCES `location`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_transfer_line` ADD CONSTRAINT `stock_transfer_line_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_transfer_line` ADD CONSTRAINT `stock_transfer_line_transferId_fkey` FOREIGN KEY (`transferId`) REFERENCES `stock_transfer`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_transfer_line` ADD CONSTRAINT `stock_transfer_line_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `product`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Transfers (added by hand). MariaDB 10.6 compatible.
-- ---------------------------------------------------------------------------

-- A transfer goes from one location to a DIFFERENT one.
ALTER TABLE `stock_transfer`
  ADD CONSTRAINT `stock_transfer_two_locations_check`
  CHECK (`fromLocationId` <> `toLocationId`);

ALTER TABLE `stock_transfer_line`
  ADD CONSTRAINT `stock_transfer_line_amounts_check`
  CHECK (`quantity` > 0 AND `baseQuantity` > 0 AND `unitFactor` > 0);

-- Transfer documents are add-only: rows can never be changed or removed.
CREATE TRIGGER `stock_transfer_no_update` BEFORE UPDATE ON `stock_transfer`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_transfer is add-only: rows cannot be changed.';
CREATE TRIGGER `stock_transfer_no_delete` BEFORE DELETE ON `stock_transfer`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_transfer is add-only: rows cannot be deleted.';
CREATE TRIGGER `stock_transfer_line_no_update` BEFORE UPDATE ON `stock_transfer_line`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_transfer_line is add-only: rows cannot be changed.';
CREATE TRIGGER `stock_transfer_line_no_delete` BEFORE DELETE ON `stock_transfer_line`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_transfer_line is add-only: rows cannot be deleted.';
