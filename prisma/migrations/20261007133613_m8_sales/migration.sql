-- AlterTable
ALTER TABLE `business` ADD COLUMN `taxNumber` VARCHAR(40) NULL;

-- AlterTable
ALTER TABLE `stock_movement` MODIFY `type` ENUM('RECEIPT', 'RECEIPT_CORRECTION', 'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUSTMENT', 'SALE') NOT NULL;

-- AlterTable
ALTER TABLE `terminal` ADD COLUMN `nextReceiptNumber` INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE `sale` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `requestId` CHAR(36) NOT NULL,
    `terminalId` CHAR(36) NOT NULL,
    `terminalCode` VARCHAR(6) NOT NULL,
    `sequence` INTEGER NOT NULL,
    `receiptNumber` VARCHAR(20) NOT NULL,
    `total` DECIMAL(14, 2) NOT NULL,
    `taxRatePercent` DECIMAL(5, 2) NOT NULL,
    `taxTotal` DECIMAL(14, 2) NOT NULL,
    `costTotal` DECIMAL(16, 2) NOT NULL,
    `cashierUserId` VARCHAR(191) NULL,
    `cashierName` VARCHAR(191) NOT NULL,
    `deviceTime` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `sale_businessId_createdAt_idx`(`businessId`, `createdAt`),
    INDEX `sale_businessId_cashierUserId_createdAt_idx`(`businessId`, `cashierUserId`, `createdAt`),
    UNIQUE INDEX `sale_businessId_requestId_key`(`businessId`, `requestId`),
    UNIQUE INDEX `sale_terminalId_sequence_key`(`terminalId`, `sequence`),
    UNIQUE INDEX `sale_businessId_receiptNumber_key`(`businessId`, `receiptNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sale_line` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `saleId` CHAR(36) NOT NULL,
    `lineNumber` INTEGER NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `productUnitId` CHAR(36) NOT NULL,
    `productName` VARCHAR(120) NOT NULL,
    `unitName` VARCHAR(40) NOT NULL,
    `unitFactor` DECIMAL(12, 3) NOT NULL,
    `quantity` DECIMAL(16, 3) NOT NULL,
    `baseQuantity` DECIMAL(16, 3) NOT NULL,
    `unitPrice` DECIMAL(14, 2) NOT NULL,
    `lineTotal` DECIMAL(14, 2) NOT NULL,
    `taxable` BOOLEAN NOT NULL,
    `taxRatePercent` DECIMAL(5, 2) NOT NULL,
    `taxAmount` DECIMAL(14, 2) NOT NULL,
    `baseUnitCost` DECIMAL(16, 4) NOT NULL,
    `lineCost` DECIMAL(16, 2) NOT NULL,
    `locationId` CHAR(36) NOT NULL,
    `locationName` VARCHAR(60) NOT NULL,

    INDEX `sale_line_productId_idx`(`productId`),
    UNIQUE INDEX `sale_line_saleId_lineNumber_key`(`saleId`, `lineNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `saleId` CHAR(36) NOT NULL,
    `method` ENUM('CASH') NOT NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `tendered` DECIMAL(14, 2) NULL,
    `changeGiven` DECIMAL(14, 2) NULL,
    `receivedByUserId` VARCHAR(191) NULL,
    `receivedByName` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `payment_saleId_idx`(`saleId`),
    INDEX `payment_businessId_createdAt_idx`(`businessId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sale_receipt_print` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `saleId` CHAR(36) NOT NULL,
    `printedByUserId` VARCHAR(191) NULL,
    `printedByName` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `sale_receipt_print_saleId_idx`(`saleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `sale` ADD CONSTRAINT `sale_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `sale` ADD CONSTRAINT `sale_terminalId_fkey` FOREIGN KEY (`terminalId`) REFERENCES `terminal`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `sale_line` ADD CONSTRAINT `sale_line_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `sale_line` ADD CONSTRAINT `sale_line_saleId_fkey` FOREIGN KEY (`saleId`) REFERENCES `sale`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `sale_line` ADD CONSTRAINT `sale_line_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `product`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `sale_line` ADD CONSTRAINT `sale_line_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `location`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payment` ADD CONSTRAINT `payment_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payment` ADD CONSTRAINT `payment_saleId_fkey` FOREIGN KEY (`saleId`) REFERENCES `sale`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `sale_receipt_print` ADD CONSTRAINT `sale_receipt_print_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `sale_receipt_print` ADD CONSTRAINT `sale_receipt_print_saleId_fkey` FOREIGN KEY (`saleId`) REFERENCES `sale`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Sales (added by hand). MariaDB 10.6 compatible.
-- ---------------------------------------------------------------------------

ALTER TABLE `sale`
  ADD CONSTRAINT `sale_amounts_check`
  CHECK (`total` >= 0 AND `taxTotal` >= 0 AND `taxTotal` <= `total` AND `costTotal` >= 0 AND `sequence` >= 1);

ALTER TABLE `sale_line`
  ADD CONSTRAINT `sale_line_amounts_check`
  CHECK (`quantity` > 0 AND `baseQuantity` > 0 AND `unitFactor` > 0 AND `unitPrice` >= 0 AND `lineTotal` >= 0
         AND `taxAmount` >= 0 AND `taxAmount` <= `lineTotal` AND `baseUnitCost` >= 0 AND `lineCost` >= 0);

-- A payment is a positive amount; cash change is exactly what was handed over minus what was owed.
ALTER TABLE `payment`
  ADD CONSTRAINT `payment_amounts_check`
  CHECK (`amount` > 0 AND (`tendered` IS NULL OR (`tendered` >= `amount` AND `changeGiven` = `tendered` - `amount`)));

-- Sales, their lines, payments and the record of receipt prints are add-only.
CREATE TRIGGER `sale_no_update` BEFORE UPDATE ON `sale`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sale is add-only: rows cannot be changed.';
CREATE TRIGGER `sale_no_delete` BEFORE DELETE ON `sale`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sale is add-only: rows cannot be deleted.';
CREATE TRIGGER `sale_line_no_update` BEFORE UPDATE ON `sale_line`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sale_line is add-only: rows cannot be changed.';
CREATE TRIGGER `sale_line_no_delete` BEFORE DELETE ON `sale_line`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sale_line is add-only: rows cannot be deleted.';
CREATE TRIGGER `payment_no_update` BEFORE UPDATE ON `payment`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'payment is add-only: rows cannot be changed.';
CREATE TRIGGER `payment_no_delete` BEFORE DELETE ON `payment`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'payment is add-only: rows cannot be deleted.';
CREATE TRIGGER `sale_receipt_print_no_update` BEFORE UPDATE ON `sale_receipt_print`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sale_receipt_print is add-only: rows cannot be changed.';
CREATE TRIGGER `sale_receipt_print_no_delete` BEFORE DELETE ON `sale_receipt_print`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sale_receipt_print is add-only: rows cannot be deleted.';
