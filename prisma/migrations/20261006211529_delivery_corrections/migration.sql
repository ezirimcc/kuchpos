-- AlterTable
ALTER TABLE `goods_receipt` ADD COLUMN `version` INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE `stock_movement` MODIFY `type` ENUM('RECEIPT', 'RECEIPT_CORRECTION') NOT NULL;

-- CreateTable
CREATE TABLE `goods_receipt_version` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `receiptId` CHAR(36) NOT NULL,
    `version` INTEGER NOT NULL,
    `requestId` CHAR(36) NULL,
    `reason` VARCHAR(300) NULL,
    `supplierId` CHAR(36) NOT NULL,
    `supplierName` VARCHAR(120) NOT NULL,
    `locationId` CHAR(36) NOT NULL,
    `locationName` VARCHAR(60) NOT NULL,
    `receivedOn` DATE NOT NULL,
    `invoiceNumber` VARCHAR(60) NULL,
    `note` VARCHAR(300) NULL,
    `totalCost` DECIMAL(16, 2) NOT NULL,
    `createdByUserId` VARCHAR(191) NULL,
    `createdByName` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `goods_receipt_version_receiptId_version_key`(`receiptId`, `version`),
    UNIQUE INDEX `goods_receipt_version_businessId_requestId_key`(`businessId`, `requestId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `goods_receipt_version_line` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `versionId` CHAR(36) NOT NULL,
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

    UNIQUE INDEX `goods_receipt_version_line_versionId_lineNumber_key`(`versionId`, `lineNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `goods_receipt_change` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `receiptId` CHAR(36) NOT NULL,
    `versionId` CHAR(36) NOT NULL,
    `position` INTEGER NOT NULL,
    `lineNumber` INTEGER NULL,
    `productName` VARCHAR(120) NULL,
    `field` VARCHAR(40) NOT NULL,
    `label` VARCHAR(60) NOT NULL,
    `oldValue` VARCHAR(400) NULL,
    `newValue` VARCHAR(400) NULL,

    INDEX `goods_receipt_change_receiptId_idx`(`receiptId`),
    INDEX `goods_receipt_change_versionId_position_idx`(`versionId`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `goods_receipt_version` ADD CONSTRAINT `goods_receipt_version_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `goods_receipt_version` ADD CONSTRAINT `goods_receipt_version_receiptId_fkey` FOREIGN KEY (`receiptId`) REFERENCES `goods_receipt`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `goods_receipt_version_line` ADD CONSTRAINT `goods_receipt_version_line_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `goods_receipt_version_line` ADD CONSTRAINT `goods_receipt_version_line_versionId_fkey` FOREIGN KEY (`versionId`) REFERENCES `goods_receipt_version`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `goods_receipt_change` ADD CONSTRAINT `goods_receipt_change_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `goods_receipt_change` ADD CONSTRAINT `goods_receipt_change_receiptId_fkey` FOREIGN KEY (`receiptId`) REFERENCES `goods_receipt`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `goods_receipt_change` ADD CONSTRAINT `goods_receipt_change_versionId_fkey` FOREIGN KEY (`versionId`) REFERENCES `goods_receipt_version`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Delivery corrections (added by hand). MariaDB 10.6 compatible.
-- ---------------------------------------------------------------------------

-- The delivery and its lines now hold the CURRENT state and are changed by corrections,
-- so their blanket "no update" protection is replaced. Deliveries still can never be deleted.
DROP TRIGGER `goods_receipt_no_update`;
DROP TRIGGER `goods_receipt_line_no_update`;
DROP TRIGGER `goods_receipt_line_no_delete`;

-- A delivery may only be updated as a correction: its identity stays the same and its
-- version goes up by exactly one. Anything else is refused by the database.
CREATE TRIGGER `goods_receipt_guard_update` BEFORE UPDATE ON `goods_receipt`
  FOR EACH ROW
  IF NEW.`id` <> OLD.`id`
     OR NEW.`businessId` <> OLD.`businessId`
     OR NEW.`number` <> OLD.`number`
     OR NEW.`requestId` <> OLD.`requestId`
     OR NEW.`createdAt` <> OLD.`createdAt`
     OR NEW.`createdByName` <> OLD.`createdByName`
     OR NEW.`version` <> OLD.`version` + 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'goods_receipt can only be changed by a correction that raises its version by one.';
  END IF;

ALTER TABLE `goods_receipt_version`
  ADD CONSTRAINT `goods_receipt_version_reason_check`
  CHECK (`version` >= 1 AND (`version` = 1 OR (`reason` IS NOT NULL AND CHAR_LENGTH(TRIM(`reason`)) > 0)));

-- Snapshots and change records are add-only: rows can never be changed or removed.
CREATE TRIGGER `goods_receipt_version_no_update` BEFORE UPDATE ON `goods_receipt_version`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'goods_receipt_version is add-only: rows cannot be changed.';
CREATE TRIGGER `goods_receipt_version_no_delete` BEFORE DELETE ON `goods_receipt_version`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'goods_receipt_version is add-only: rows cannot be deleted.';
CREATE TRIGGER `goods_receipt_version_line_no_update` BEFORE UPDATE ON `goods_receipt_version_line`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'goods_receipt_version_line is add-only: rows cannot be changed.';
CREATE TRIGGER `goods_receipt_version_line_no_delete` BEFORE DELETE ON `goods_receipt_version_line`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'goods_receipt_version_line is add-only: rows cannot be deleted.';
CREATE TRIGGER `goods_receipt_change_no_update` BEFORE UPDATE ON `goods_receipt_change`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'goods_receipt_change is add-only: rows cannot be changed.';
CREATE TRIGGER `goods_receipt_change_no_delete` BEFORE DELETE ON `goods_receipt_change`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'goods_receipt_change is add-only: rows cannot be deleted.';

-- Deliveries saved before this change get their version-1 snapshot now, so the original
-- of every delivery is on record from here on.
INSERT INTO `goods_receipt_version`
  (`id`, `businessId`, `receiptId`, `version`, `supplierId`, `supplierName`, `locationId`, `locationName`,
   `receivedOn`, `invoiceNumber`, `note`, `totalCost`, `createdByUserId`, `createdByName`, `createdAt`)
  SELECT UUID(), r.`businessId`, r.`id`, 1, r.`supplierId`, r.`supplierName`, r.`locationId`, r.`locationName`,
         r.`receivedOn`, r.`invoiceNumber`, r.`note`, r.`totalCost`, r.`createdByUserId`, r.`createdByName`, r.`createdAt`
  FROM `goods_receipt` r;

INSERT INTO `goods_receipt_version_line`
  (`id`, `businessId`, `versionId`, `lineNumber`, `productId`, `productUnitId`, `productName`, `unitName`,
   `unitFactor`, `quantity`, `baseQuantity`, `unitCost`, `lineCost`, `batchNumber`, `expiryDate`)
  SELECT UUID(), l.`businessId`, v.`id`, l.`lineNumber`, l.`productId`, l.`productUnitId`, l.`productName`, l.`unitName`,
         l.`unitFactor`, l.`quantity`, l.`baseQuantity`, l.`unitCost`, l.`lineCost`, l.`batchNumber`, l.`expiryDate`
  FROM `goods_receipt_line` l
  JOIN `goods_receipt_version` v ON v.`receiptId` = l.`receiptId` AND v.`version` = 1;
