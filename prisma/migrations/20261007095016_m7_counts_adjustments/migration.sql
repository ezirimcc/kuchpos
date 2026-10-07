-- AlterTable
ALTER TABLE `business` ADD COLUMN `nextStockAdjustmentNumber` INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN `nextStockCountNumber` INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE `stock_movement` MODIFY `type` ENUM('RECEIPT', 'RECEIPT_CORRECTION', 'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUSTMENT') NOT NULL;

-- CreateTable
CREATE TABLE `stock_count` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `requestId` CHAR(36) NOT NULL,
    `number` INTEGER NOT NULL,
    `locationId` CHAR(36) NOT NULL,
    `locationName` VARCHAR(60) NOT NULL,
    `categoryName` VARCHAR(60) NULL,
    `note` VARCHAR(300) NULL,
    `createdByUserId` VARCHAR(191) NULL,
    `createdByName` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `stock_count_businessId_createdAt_idx`(`businessId`, `createdAt`),
    UNIQUE INDEX `stock_count_businessId_requestId_key`(`businessId`, `requestId`),
    UNIQUE INDEX `stock_count_businessId_number_key`(`businessId`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_count_line` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `countId` CHAR(36) NOT NULL,
    `lineNumber` INTEGER NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `productName` VARCHAR(120) NOT NULL,
    `baseUnitId` CHAR(36) NOT NULL,
    `baseUnitName` VARCHAR(40) NOT NULL,
    `enteredAs` VARCHAR(200) NOT NULL,
    `countedQuantity` DECIMAL(16, 3) NOT NULL,
    `expectedQuantity` DECIMAL(16, 3) NOT NULL,
    `difference` DECIMAL(16, 3) NOT NULL,

    INDEX `stock_count_line_productId_idx`(`productId`),
    UNIQUE INDEX `stock_count_line_countId_lineNumber_key`(`countId`, `lineNumber`),
    UNIQUE INDEX `stock_count_line_countId_productId_key`(`countId`, `productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_adjustment` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `requestId` CHAR(36) NOT NULL,
    `number` INTEGER NOT NULL,
    `locationId` CHAR(36) NOT NULL,
    `locationName` VARCHAR(60) NOT NULL,
    `countId` CHAR(36) NULL,
    `note` VARCHAR(300) NULL,
    `createdByUserId` VARCHAR(191) NULL,
    `createdByName` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `stock_adjustment_countId_key`(`countId`),
    INDEX `stock_adjustment_businessId_createdAt_idx`(`businessId`, `createdAt`),
    UNIQUE INDEX `stock_adjustment_businessId_requestId_key`(`businessId`, `requestId`),
    UNIQUE INDEX `stock_adjustment_businessId_number_key`(`businessId`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_adjustment_line` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `adjustmentId` CHAR(36) NOT NULL,
    `lineNumber` INTEGER NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `productUnitId` CHAR(36) NOT NULL,
    `productName` VARCHAR(120) NOT NULL,
    `unitName` VARCHAR(40) NOT NULL,
    `unitFactor` DECIMAL(12, 3) NOT NULL,
    `quantity` DECIMAL(16, 3) NOT NULL,
    `baseQuantity` DECIMAL(16, 3) NOT NULL,
    `reason` ENUM('DAMAGED', 'EXPIRED', 'MISSING', 'COUNT_ERROR', 'FOUND', 'SAMPLE_GIFT', 'DATA_ENTRY_ERROR', 'OTHER') NOT NULL,

    INDEX `stock_adjustment_line_productId_idx`(`productId`),
    UNIQUE INDEX `stock_adjustment_line_adjustmentId_lineNumber_key`(`adjustmentId`, `lineNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_adjustment_decision` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `adjustmentId` CHAR(36) NOT NULL,
    `outcome` ENUM('APPLIED', 'REJECTED') NOT NULL,
    `note` VARCHAR(300) NULL,
    `decidedByUserId` VARCHAR(191) NULL,
    `decidedByName` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `stock_adjustment_decision_adjustmentId_key`(`adjustmentId`),
    INDEX `stock_adjustment_decision_businessId_outcome_idx`(`businessId`, `outcome`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `stock_count` ADD CONSTRAINT `stock_count_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_count` ADD CONSTRAINT `stock_count_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `location`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_count_line` ADD CONSTRAINT `stock_count_line_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_count_line` ADD CONSTRAINT `stock_count_line_countId_fkey` FOREIGN KEY (`countId`) REFERENCES `stock_count`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_count_line` ADD CONSTRAINT `stock_count_line_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `product`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_adjustment` ADD CONSTRAINT `stock_adjustment_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_adjustment` ADD CONSTRAINT `stock_adjustment_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `location`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_adjustment` ADD CONSTRAINT `stock_adjustment_countId_fkey` FOREIGN KEY (`countId`) REFERENCES `stock_count`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_adjustment_line` ADD CONSTRAINT `stock_adjustment_line_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_adjustment_line` ADD CONSTRAINT `stock_adjustment_line_adjustmentId_fkey` FOREIGN KEY (`adjustmentId`) REFERENCES `stock_adjustment`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_adjustment_line` ADD CONSTRAINT `stock_adjustment_line_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `product`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_adjustment_decision` ADD CONSTRAINT `stock_adjustment_decision_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_adjustment_decision` ADD CONSTRAINT `stock_adjustment_decision_adjustmentId_fkey` FOREIGN KEY (`adjustmentId`) REFERENCES `stock_adjustment`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Stock counts and adjustments (added by hand). MariaDB 10.6 compatible.
-- ---------------------------------------------------------------------------

ALTER TABLE `stock_count_line`
  ADD CONSTRAINT `stock_count_line_amounts_check`
  CHECK (`countedQuantity` >= 0 AND `expectedQuantity` >= 0 AND `difference` = `countedQuantity` - `expectedQuantity`);

ALTER TABLE `stock_adjustment_line`
  ADD CONSTRAINT `stock_adjustment_line_amounts_check`
  CHECK (`quantity` <> 0 AND `baseQuantity` <> 0 AND `unitFactor` > 0 AND (`quantity` > 0) = (`baseQuantity` > 0));

-- A rejection must say why.
ALTER TABLE `stock_adjustment_decision`
  ADD CONSTRAINT `stock_adjustment_decision_note_check`
  CHECK (`outcome` <> 'REJECTED' OR (`note` IS NOT NULL AND CHAR_LENGTH(TRIM(`note`)) > 0));

-- Counts, adjustments and decisions are add-only: rows can never be changed or removed.
CREATE TRIGGER `stock_count_no_update` BEFORE UPDATE ON `stock_count`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_count is add-only: rows cannot be changed.';
CREATE TRIGGER `stock_count_no_delete` BEFORE DELETE ON `stock_count`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_count is add-only: rows cannot be deleted.';
CREATE TRIGGER `stock_count_line_no_update` BEFORE UPDATE ON `stock_count_line`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_count_line is add-only: rows cannot be changed.';
CREATE TRIGGER `stock_count_line_no_delete` BEFORE DELETE ON `stock_count_line`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_count_line is add-only: rows cannot be deleted.';
CREATE TRIGGER `stock_adjustment_no_update` BEFORE UPDATE ON `stock_adjustment`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_adjustment is add-only: rows cannot be changed.';
CREATE TRIGGER `stock_adjustment_no_delete` BEFORE DELETE ON `stock_adjustment`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_adjustment is add-only: rows cannot be deleted.';
CREATE TRIGGER `stock_adjustment_line_no_update` BEFORE UPDATE ON `stock_adjustment_line`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_adjustment_line is add-only: rows cannot be changed.';
CREATE TRIGGER `stock_adjustment_line_no_delete` BEFORE DELETE ON `stock_adjustment_line`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_adjustment_line is add-only: rows cannot be deleted.';
CREATE TRIGGER `stock_adjustment_decision_no_update` BEFORE UPDATE ON `stock_adjustment_decision`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_adjustment_decision is add-only: rows cannot be changed.';
CREATE TRIGGER `stock_adjustment_decision_no_delete` BEFORE DELETE ON `stock_adjustment_decision`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_adjustment_decision is add-only: rows cannot be deleted.';
