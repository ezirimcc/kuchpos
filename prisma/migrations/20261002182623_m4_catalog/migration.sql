-- AlterTable
ALTER TABLE `business` ADD COLUMN `receiptFooter` VARCHAR(500) NULL,
    ADD COLUMN `receiptHeader` VARCHAR(500) NULL,
    ADD COLUMN `taxRatePercent` DECIMAL(5, 2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `location` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `kind` ENUM('SHELF', 'STOREROOM') NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `location_businessId_name_key`(`businessId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `terminal` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `code` VARCHAR(6) NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `paperWidth` ENUM('MM58', 'MM80') NOT NULL DEFAULT 'MM80',
    `deactivatedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `terminal_businessId_code_key`(`businessId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `product` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `code` VARCHAR(40) NULL,
    `barcode` VARCHAR(64) NULL,
    `allowsFraction` BOOLEAN NOT NULL,
    `taxable` BOOLEAN NOT NULL DEFAULT true,
    `deactivatedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `product_businessId_name_key`(`businessId`, `name`),
    UNIQUE INDEX `product_businessId_code_key`(`businessId`, `code`),
    UNIQUE INDEX `product_businessId_barcode_key`(`businessId`, `barcode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `product_unit` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `name` VARCHAR(40) NOT NULL,
    `factor` DECIMAL(12, 3) NOT NULL,
    `isBase` BOOLEAN NOT NULL DEFAULT false,
    `forSale` BOOLEAN NOT NULL DEFAULT true,
    `forPurchase` BOOLEAN NOT NULL DEFAULT true,
    `price` DECIMAL(14, 2) NULL,
    `activeName` VARCHAR(40) NULL,
    `retiredAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `product_unit_businessId_idx`(`businessId`),
    UNIQUE INDEX `product_unit_productId_activeName_key`(`productId`, `activeName`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `price_change` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `productUnitId` CHAR(36) NOT NULL,
    `unitName` VARCHAR(40) NOT NULL,
    `oldPrice` DECIMAL(14, 2) NULL,
    `newPrice` DECIMAL(14, 2) NULL,
    `changedByUserId` VARCHAR(191) NULL,
    `changedByName` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `price_change_productId_createdAt_idx`(`productId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tax_rate_change` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `oldRatePercent` DECIMAL(5, 2) NOT NULL,
    `newRatePercent` DECIMAL(5, 2) NOT NULL,
    `changedByUserId` VARCHAR(191) NULL,
    `changedByName` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `tax_rate_change_businessId_createdAt_idx`(`businessId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `location` ADD CONSTRAINT `location_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `terminal` ADD CONSTRAINT `terminal_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `product` ADD CONSTRAINT `product_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `product_unit` ADD CONSTRAINT `product_unit_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `product_unit` ADD CONSTRAINT `product_unit_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `product`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `price_change` ADD CONSTRAINT `price_change_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `price_change` ADD CONSTRAINT `price_change_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `product`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `price_change` ADD CONSTRAINT `price_change_productUnitId_fkey` FOREIGN KEY (`productUnitId`) REFERENCES `product_unit`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `price_change` ADD CONSTRAINT `price_change_changedByUserId_fkey` FOREIGN KEY (`changedByUserId`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `tax_rate_change` ADD CONSTRAINT `tax_rate_change_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `tax_rate_change` ADD CONSTRAINT `tax_rate_change_changedByUserId_fkey` FOREIGN KEY (`changedByUserId`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Rules the database itself enforces (added by hand). MariaDB 10.6 compatible.
-- ---------------------------------------------------------------------------

ALTER TABLE `business`
  ADD CONSTRAINT `business_tax_rate_percent_check`
  CHECK (`taxRatePercent` BETWEEN 0 AND 100);

ALTER TABLE `terminal`
  ADD CONSTRAINT `terminal_code_format_check`
  CHECK (`code` REGEXP BINARY '^[A-Z0-9]{1,6}$');

-- A conversion is always more than zero; the base unit is exactly 1.
ALTER TABLE `product_unit`
  ADD CONSTRAINT `product_unit_factor_check`
  CHECK (`factor` > 0 AND (`isBase` = 0 OR `factor` = 1));

-- A price is never negative, and a unit that is for sale must have one.
ALTER TABLE `product_unit`
  ADD CONSTRAINT `product_unit_price_check`
  CHECK ((`price` IS NULL OR `price` >= 0) AND (`forSale` = 0 OR `price` IS NOT NULL));

-- Price and tax-rate history are add-only: rows can never be changed or removed.
CREATE TRIGGER `price_change_no_update` BEFORE UPDATE ON `price_change`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'price_change is add-only: rows cannot be changed.';
CREATE TRIGGER `price_change_no_delete` BEFORE DELETE ON `price_change`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'price_change is add-only: rows cannot be deleted.';
CREATE TRIGGER `tax_rate_change_no_update` BEFORE UPDATE ON `tax_rate_change`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tax_rate_change is add-only: rows cannot be changed.';
CREATE TRIGGER `tax_rate_change_no_delete` BEFORE DELETE ON `tax_rate_change`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tax_rate_change is add-only: rows cannot be deleted.';

-- Businesses that already exist get the same starting setup a new business gets:
-- a Shelf, a Storeroom and one checkout terminal.
INSERT INTO `location` (`id`, `businessId`, `name`, `kind`, `updatedAt`)
  SELECT UUID(), `id`, 'Shelf', 'SHELF', UTC_TIMESTAMP(3) FROM `business`;
INSERT INTO `location` (`id`, `businessId`, `name`, `kind`, `updatedAt`)
  SELECT UUID(), `id`, 'Storeroom', 'STOREROOM', UTC_TIMESTAMP(3) FROM `business`;
INSERT INTO `terminal` (`id`, `businessId`, `code`, `name`, `updatedAt`)
  SELECT UUID(), `id`, 'T1', 'Checkout 1', UTC_TIMESTAMP(3) FROM `business`;
