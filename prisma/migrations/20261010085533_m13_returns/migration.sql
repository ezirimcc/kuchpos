-- AlterTable
ALTER TABLE `approval` MODIFY `kind` ENUM('DISCOUNT', 'CREDIT_OVER_LIMIT', 'RETURN') NOT NULL;

-- AlterTable
ALTER TABLE `approval_request` MODIFY `kind` ENUM('DISCOUNT', 'CREDIT_OVER_LIMIT', 'RETURN') NOT NULL;

-- AlterTable
ALTER TABLE `business` ADD COLUMN `returnDays` INTEGER NOT NULL DEFAULT 7;

-- AlterTable
ALTER TABLE `customer_account_entry` MODIFY `type` ENUM('CREDIT_SALE', 'REPAYMENT', 'SALE_CANCELLED', 'SALE_RETURN') NOT NULL;

-- AlterTable
ALTER TABLE `document_counter` MODIFY `kind` ENUM('GOODS_RECEIPT', 'STOCK_TRANSFER', 'STOCK_COUNT', 'STOCK_ADJUSTMENT', 'TILL_SESSION', 'REPAYMENT', 'SALE_RETURN') NOT NULL;

-- AlterTable
ALTER TABLE `stock_movement` MODIFY `type` ENUM('RECEIPT', 'RECEIPT_CORRECTION', 'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUSTMENT', 'SALE', 'SALE_CANCELLATION', 'SALE_RETURN') NOT NULL;

-- CreateTable
CREATE TABLE `sale_return` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `requestId` CHAR(36) NOT NULL,
    `number` INTEGER NOT NULL,
    `saleId` CHAR(36) NOT NULL,
    `saleReceiptNumber` VARCHAR(20) NOT NULL,
    `customerId` CHAR(36) NULL,
    `customerName` VARCHAR(191) NULL,
    `reason` VARCHAR(300) NOT NULL,
    `refundTotal` DECIMAL(14, 2) NOT NULL,
    `debtReduced` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `refundPaid` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `refundMethodId` CHAR(36) NULL,
    `refundMethodName` VARCHAR(191) NULL,
    `refundKind` ENUM('CASH', 'TRANSFER', 'POS') NULL,
    `refundReference` VARCHAR(60) NULL,
    `tillSessionId` CHAR(36) NULL,
    `restockedCost` DECIMAL(16, 2) NOT NULL DEFAULT 0,
    `writtenOffCost` DECIMAL(16, 2) NOT NULL DEFAULT 0,
    `createdByUserId` VARCHAR(191) NULL,
    `createdByName` VARCHAR(191) NOT NULL,
    `approvedByUserId` VARCHAR(191) NULL,
    `approvedByName` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `sale_return_saleId_idx`(`saleId`),
    INDEX `sale_return_businessId_createdAt_idx`(`businessId`, `createdAt`),
    UNIQUE INDEX `sale_return_businessId_requestId_key`(`businessId`, `requestId`),
    UNIQUE INDEX `sale_return_businessId_number_key`(`businessId`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sale_return_line` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `returnId` CHAR(36) NOT NULL,
    `saleLineId` CHAR(36) NOT NULL,
    `lineNumber` INTEGER NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `productName` VARCHAR(191) NOT NULL,
    `unitName` VARCHAR(191) NOT NULL,
    `unitFactor` DECIMAL(12, 3) NOT NULL,
    `quantity` DECIMAL(16, 3) NOT NULL,
    `baseQuantity` DECIMAL(16, 3) NOT NULL,
    `refundAmount` DECIMAL(14, 2) NOT NULL,
    `taxAmount` DECIMAL(14, 2) NOT NULL,
    `lineCost` DECIMAL(16, 2) NOT NULL,
    `disposition` ENUM('SHELF', 'STOREROOM', 'WRITTEN_OFF') NOT NULL,
    `locationId` CHAR(36) NULL,
    `locationName` VARCHAR(191) NULL,

    INDEX `sale_return_line_saleLineId_idx`(`saleLineId`),
    UNIQUE INDEX `sale_return_line_returnId_lineNumber_key`(`returnId`, `lineNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `sale_return` ADD CONSTRAINT `sale_return_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `sale_return` ADD CONSTRAINT `sale_return_saleId_fkey` FOREIGN KEY (`saleId`) REFERENCES `sale`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `sale_return` ADD CONSTRAINT `sale_return_tillSessionId_fkey` FOREIGN KEY (`tillSessionId`) REFERENCES `till_session`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `sale_return_line` ADD CONSTRAINT `sale_return_line_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `sale_return_line` ADD CONSTRAINT `sale_return_line_returnId_fkey` FOREIGN KEY (`returnId`) REFERENCES `sale_return`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `sale_return_line` ADD CONSTRAINT `sale_return_line_saleLineId_fkey` FOREIGN KEY (`saleLineId`) REFERENCES `sale_line`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------
-- Returns (added by hand). MariaDB 10.6 compatible.
-- ---------------------------------------------------------------------------

-- A refund is what was taken off the debt plus what was handed back. Cash handed back comes
-- out of a named till; anything handed back names how.
ALTER TABLE `sale_return`
  ADD CONSTRAINT `sale_return_amounts_check`
  CHECK (`refundTotal` >= 0 AND `debtReduced` >= 0 AND `refundPaid` >= 0
         AND `debtReduced` + `refundPaid` = `refundTotal`
         AND CHAR_LENGTH(TRIM(`reason`)) > 0
         AND (`refundPaid` = 0 OR (`refundKind` IS NOT NULL AND `refundMethodName` IS NOT NULL))
         AND (`refundKind` IS NULL OR `refundKind` <> 'CASH' OR `refundPaid` = 0 OR `tillSessionId` IS NOT NULL));

-- Written-off goods go nowhere; goods put back name where.
ALTER TABLE `sale_return_line`
  ADD CONSTRAINT `sale_return_line_check`
  CHECK (`quantity` > 0 AND `baseQuantity` > 0 AND `refundAmount` >= 0 AND `taxAmount` >= 0 AND `lineCost` >= 0
         AND ((`disposition` = 'WRITTEN_OFF' AND `locationId` IS NULL) OR (`disposition` <> 'WRITTEN_OFF' AND `locationId` IS NOT NULL)));

ALTER TABLE `business`
  ADD CONSTRAINT `business_return_days_check`
  CHECK (`returnDays` >= 0 AND `returnDays` <= 3650);

-- Returns are add-only.
CREATE TRIGGER `sale_return_no_update` BEFORE UPDATE ON `sale_return`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sale_return is add-only: rows cannot be changed.';
CREATE TRIGGER `sale_return_no_delete` BEFORE DELETE ON `sale_return`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sale_return is add-only: rows cannot be deleted.';
CREATE TRIGGER `sale_return_line_no_update` BEFORE UPDATE ON `sale_return_line`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sale_return_line is add-only: rows cannot be changed.';
CREATE TRIGGER `sale_return_line_no_delete` BEFORE DELETE ON `sale_return_line`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sale_return_line is add-only: rows cannot be deleted.';
