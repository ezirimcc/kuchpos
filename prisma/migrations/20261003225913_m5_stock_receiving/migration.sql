-- AlterTable
ALTER TABLE `business` ADD COLUMN `expiringSoonMonths` INTEGER NOT NULL DEFAULT 3,
    ADD COLUMN `nextGoodsReceiptNumber` INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE `product` ADD COLUMN `averageCost` DECIMAL(16, 4) NOT NULL DEFAULT 0,
    ADD COLUMN `tracksBatch` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `tracksExpiry` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `supplier` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `phone` VARCHAR(40) NULL,
    `note` VARCHAR(300) NULL,
    `deactivatedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `supplier_businessId_name_key`(`businessId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_balance` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `locationId` CHAR(36) NOT NULL,
    `quantity` DECIMAL(16, 3) NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `stock_balance_businessId_idx`(`businessId`),
    UNIQUE INDEX `stock_balance_productId_locationId_key`(`productId`, `locationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_movement` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `locationId` CHAR(36) NOT NULL,
    `type` ENUM('RECEIPT') NOT NULL,
    `quantityDelta` DECIMAL(16, 3) NOT NULL,
    `unitName` VARCHAR(40) NOT NULL,
    `unitFactor` DECIMAL(12, 3) NOT NULL,
    `unitQuantity` DECIMAL(16, 3) NOT NULL,
    `documentType` VARCHAR(30) NOT NULL,
    `documentId` CHAR(36) NOT NULL,
    `documentNumber` VARCHAR(30) NOT NULL,
    `userId` VARCHAR(191) NULL,
    `userName` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `stock_movement_productId_createdAt_idx`(`productId`, `createdAt`),
    INDEX `stock_movement_businessId_createdAt_idx`(`businessId`, `createdAt`),
    INDEX `stock_movement_documentId_idx`(`documentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `goods_receipt` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `requestId` CHAR(36) NOT NULL,
    `number` INTEGER NOT NULL,
    `supplierId` CHAR(36) NOT NULL,
    `supplierName` VARCHAR(120) NOT NULL,
    `locationId` CHAR(36) NOT NULL,
    `locationName` VARCHAR(60) NOT NULL,
    `receivedOn` DATE NOT NULL,
    `backdated` BOOLEAN NOT NULL DEFAULT false,
    `backdateNote` VARCHAR(300) NULL,
    `invoiceNumber` VARCHAR(60) NULL,
    `note` VARCHAR(300) NULL,
    `totalCost` DECIMAL(16, 2) NOT NULL,
    `createdByUserId` VARCHAR(191) NULL,
    `createdByName` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `goods_receipt_businessId_receivedOn_idx`(`businessId`, `receivedOn`),
    UNIQUE INDEX `goods_receipt_businessId_requestId_key`(`businessId`, `requestId`),
    UNIQUE INDEX `goods_receipt_businessId_number_key`(`businessId`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `goods_receipt_line` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `receiptId` CHAR(36) NOT NULL,
    `lineNumber` INTEGER NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `productUnitId` CHAR(36) NOT NULL,
    `productName` VARCHAR(120) NOT NULL,
    `unitName` VARCHAR(40) NOT NULL,
    `unitFactor` DECIMAL(12, 3) NOT NULL,
    `quantity` DECIMAL(16, 3) NOT NULL,
    `baseQuantity` DECIMAL(16, 3) NOT NULL,
    `unitCost` DECIMAL(14, 2) NOT NULL,
    `lineCost` DECIMAL(16, 2) NOT NULL,
    `batchNumber` VARCHAR(60) NULL,
    `expiryDate` DATE NULL,

    INDEX `goods_receipt_line_businessId_expiryDate_idx`(`businessId`, `expiryDate`),
    INDEX `goods_receipt_line_productId_idx`(`productId`),
    UNIQUE INDEX `goods_receipt_line_receiptId_lineNumber_key`(`receiptId`, `lineNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `supplier` ADD CONSTRAINT `supplier_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_balance` ADD CONSTRAINT `stock_balance_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_balance` ADD CONSTRAINT `stock_balance_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `product`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_balance` ADD CONSTRAINT `stock_balance_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `location`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_movement` ADD CONSTRAINT `stock_movement_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_movement` ADD CONSTRAINT `stock_movement_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `product`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_movement` ADD CONSTRAINT `stock_movement_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `location`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `goods_receipt` ADD CONSTRAINT `goods_receipt_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `goods_receipt` ADD CONSTRAINT `goods_receipt_supplierId_fkey` FOREIGN KEY (`supplierId`) REFERENCES `supplier`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `goods_receipt` ADD CONSTRAINT `goods_receipt_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `location`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `goods_receipt_line` ADD CONSTRAINT `goods_receipt_line_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `goods_receipt_line` ADD CONSTRAINT `goods_receipt_line_receiptId_fkey` FOREIGN KEY (`receiptId`) REFERENCES `goods_receipt`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `goods_receipt_line` ADD CONSTRAINT `goods_receipt_line_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `product`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `goods_receipt_line` ADD CONSTRAINT `goods_receipt_line_productUnitId_fkey` FOREIGN KEY (`productUnitId`) REFERENCES `product_unit`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Rules the database itself enforces (added by hand). MariaDB 10.6 compatible.
-- ---------------------------------------------------------------------------

ALTER TABLE `business`
  ADD CONSTRAINT `business_expiring_soon_months_check`
  CHECK (`expiringSoonMonths` BETWEEN 1 AND 36);

ALTER TABLE `product`
  ADD CONSTRAINT `product_average_cost_check`
  CHECK (`averageCost` >= 0);

-- Stock can never go below zero.
ALTER TABLE `stock_balance`
  ADD CONSTRAINT `stock_balance_not_negative_check`
  CHECK (`quantity` >= 0);

ALTER TABLE `stock_movement`
  ADD CONSTRAINT `stock_movement_not_zero_check`
  CHECK (`quantityDelta` <> 0 AND `unitFactor` > 0);

-- A backdated delivery must say why.
ALTER TABLE `goods_receipt`
  ADD CONSTRAINT `goods_receipt_backdate_note_check`
  CHECK (`backdated` = 0 OR (`backdateNote` IS NOT NULL AND CHAR_LENGTH(TRIM(`backdateNote`)) > 0));

ALTER TABLE `goods_receipt_line`
  ADD CONSTRAINT `goods_receipt_line_amounts_check`
  CHECK (`quantity` > 0 AND `baseQuantity` > 0 AND `unitFactor` > 0 AND `unitCost` >= 0 AND `lineCost` >= 0);

-- Stock movements and delivery documents are add-only: rows can never be changed or removed.
CREATE TRIGGER `stock_movement_no_update` BEFORE UPDATE ON `stock_movement`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_movement is add-only: rows cannot be changed.';
CREATE TRIGGER `stock_movement_no_delete` BEFORE DELETE ON `stock_movement`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'stock_movement is add-only: rows cannot be deleted.';
CREATE TRIGGER `goods_receipt_no_update` BEFORE UPDATE ON `goods_receipt`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'goods_receipt is add-only: rows cannot be changed.';
CREATE TRIGGER `goods_receipt_no_delete` BEFORE DELETE ON `goods_receipt`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'goods_receipt is add-only: rows cannot be deleted.';
CREATE TRIGGER `goods_receipt_line_no_update` BEFORE UPDATE ON `goods_receipt_line`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'goods_receipt_line is add-only: rows cannot be changed.';
CREATE TRIGGER `goods_receipt_line_no_delete` BEFORE DELETE ON `goods_receipt_line`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'goods_receipt_line is add-only: rows cannot be deleted.';
