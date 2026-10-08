-- AlterTable
ALTER TABLE `document_counter` MODIFY `kind` ENUM('GOODS_RECEIPT', 'STOCK_TRANSFER', 'STOCK_COUNT', 'STOCK_ADJUSTMENT', 'TILL_SESSION', 'REPAYMENT') NOT NULL;

-- AlterTable
ALTER TABLE `sale` ADD COLUMN `creditAmount` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `customerId` CHAR(36) NULL,
    ADD COLUMN `customerName` VARCHAR(120) NULL,
    ADD COLUMN `customerPhone` VARCHAR(30) NULL;

-- CreateTable
CREATE TABLE `customer` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `phone` VARCHAR(30) NOT NULL,
    `address` VARCHAR(200) NULL,
    `city` VARCHAR(60) NULL,
    `state` VARCHAR(60) NULL,
    `creditLimit` DECIMAL(14, 2) NULL,
    `balance` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `deactivatedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `customer_businessId_name_idx`(`businessId`, `name`),
    UNIQUE INDEX `customer_businessId_phone_key`(`businessId`, `phone`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_account_entry` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `customerId` CHAR(36) NOT NULL,
    `type` ENUM('CREDIT_SALE', 'REPAYMENT', 'SALE_CANCELLED') NOT NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `balanceAfter` DECIMAL(14, 2) NOT NULL,
    `saleId` CHAR(36) NULL,
    `repaymentId` CHAR(36) NULL,
    `documentNumber` VARCHAR(30) NOT NULL,
    `note` VARCHAR(300) NULL,
    `createdByUserId` VARCHAR(191) NULL,
    `createdByName` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `customer_account_entry_repaymentId_key`(`repaymentId`),
    INDEX `customer_account_entry_customerId_createdAt_idx`(`customerId`, `createdAt`),
    INDEX `customer_account_entry_saleId_idx`(`saleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `credit_limit_change` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `customerId` CHAR(36) NOT NULL,
    `oldLimit` DECIMAL(14, 2) NULL,
    `newLimit` DECIMAL(14, 2) NULL,
    `changedByUserId` VARCHAR(191) NULL,
    `changedByName` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `credit_limit_change_customerId_createdAt_idx`(`customerId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `repayment` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `requestId` CHAR(36) NOT NULL,
    `number` INTEGER NOT NULL,
    `customerId` CHAR(36) NOT NULL,
    `customerName` VARCHAR(120) NOT NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `methodId` CHAR(36) NOT NULL,
    `methodName` VARCHAR(60) NOT NULL,
    `kind` ENUM('CASH', 'TRANSFER', 'POS') NOT NULL,
    `reference` VARCHAR(60) NULL,
    `tillSessionId` CHAR(36) NULL,
    `note` VARCHAR(300) NULL,
    `receivedByUserId` VARCHAR(191) NULL,
    `receivedByName` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `repayment_customerId_createdAt_idx`(`customerId`, `createdAt`),
    INDEX `repayment_tillSessionId_idx`(`tillSessionId`),
    INDEX `repayment_businessId_createdAt_idx`(`businessId`, `createdAt`),
    UNIQUE INDEX `repayment_businessId_requestId_key`(`businessId`, `requestId`),
    UNIQUE INDEX `repayment_businessId_number_key`(`businessId`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `repayment_allocation` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `repaymentId` CHAR(36) NOT NULL,
    `saleId` CHAR(36) NOT NULL,
    `amount` DECIMAL(14, 2) NOT NULL,

    INDEX `repayment_allocation_saleId_idx`(`saleId`),
    UNIQUE INDEX `repayment_allocation_repaymentId_saleId_key`(`repaymentId`, `saleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `sale_customerId_createdAt_idx` ON `sale`(`customerId`, `createdAt`);

-- AddForeignKey
ALTER TABLE `sale` ADD CONSTRAINT `sale_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customer`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `customer` ADD CONSTRAINT `customer_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `customer_account_entry` ADD CONSTRAINT `customer_account_entry_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `customer_account_entry` ADD CONSTRAINT `customer_account_entry_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customer`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `customer_account_entry` ADD CONSTRAINT `customer_account_entry_saleId_fkey` FOREIGN KEY (`saleId`) REFERENCES `sale`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `customer_account_entry` ADD CONSTRAINT `customer_account_entry_repaymentId_fkey` FOREIGN KEY (`repaymentId`) REFERENCES `repayment`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `credit_limit_change` ADD CONSTRAINT `credit_limit_change_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `credit_limit_change` ADD CONSTRAINT `credit_limit_change_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customer`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `repayment` ADD CONSTRAINT `repayment_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `repayment` ADD CONSTRAINT `repayment_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customer`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `repayment` ADD CONSTRAINT `repayment_methodId_fkey` FOREIGN KEY (`methodId`) REFERENCES `payment_method`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `repayment` ADD CONSTRAINT `repayment_tillSessionId_fkey` FOREIGN KEY (`tillSessionId`) REFERENCES `till_session`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `repayment_allocation` ADD CONSTRAINT `repayment_allocation_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `repayment_allocation` ADD CONSTRAINT `repayment_allocation_repaymentId_fkey` FOREIGN KEY (`repaymentId`) REFERENCES `repayment`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `repayment_allocation` ADD CONSTRAINT `repayment_allocation_saleId_fkey` FOREIGN KEY (`saleId`) REFERENCES `sale`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Customers and credit (added by hand). MariaDB 10.6 compatible.
-- ---------------------------------------------------------------------------

-- A customer never owes less than nothing (no advance deposits), and a phone number is digits.
ALTER TABLE `customer`
  ADD CONSTRAINT `customer_amounts_check`
  CHECK (`balance` >= 0 AND (`creditLimit` IS NULL OR `creditLimit` >= 0) AND `phone` REGEXP '^[+]?[0-9]{7,15}$');

-- Credit on a sale is part of its total, and always belongs to a customer.
ALTER TABLE `sale`
  ADD CONSTRAINT `sale_credit_check`
  CHECK (`creditAmount` >= 0 AND `creditAmount` <= `total` AND (`creditAmount` = 0 OR `customerId` IS NOT NULL));

ALTER TABLE `customer_account_entry`
  ADD CONSTRAINT `customer_account_entry_amounts_check`
  CHECK (`amount` <> 0 AND `balanceAfter` >= 0);

-- A repayment is a positive amount, and cash always goes into a till session.
ALTER TABLE `repayment`
  ADD CONSTRAINT `repayment_amounts_check`
  CHECK (`amount` > 0 AND `number` >= 1 AND (`kind` <> 'CASH' OR `tillSessionId` IS NOT NULL));

ALTER TABLE `repayment_allocation`
  ADD CONSTRAINT `repayment_allocation_amount_check`
  CHECK (`amount` > 0);

-- A customer is never deleted.
CREATE TRIGGER `customer_no_delete` BEFORE DELETE ON `customer`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'customer rows cannot be deleted.';

-- The history of a debt is add-only.
CREATE TRIGGER `customer_account_entry_no_update` BEFORE UPDATE ON `customer_account_entry`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'customer_account_entry is add-only: rows cannot be changed.';
CREATE TRIGGER `customer_account_entry_no_delete` BEFORE DELETE ON `customer_account_entry`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'customer_account_entry is add-only: rows cannot be deleted.';
CREATE TRIGGER `credit_limit_change_no_update` BEFORE UPDATE ON `credit_limit_change`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'credit_limit_change is add-only: rows cannot be changed.';
CREATE TRIGGER `credit_limit_change_no_delete` BEFORE DELETE ON `credit_limit_change`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'credit_limit_change is add-only: rows cannot be deleted.';
CREATE TRIGGER `repayment_no_update` BEFORE UPDATE ON `repayment`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'repayment is add-only: rows cannot be changed.';
CREATE TRIGGER `repayment_no_delete` BEFORE DELETE ON `repayment`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'repayment is add-only: rows cannot be deleted.';
CREATE TRIGGER `repayment_allocation_no_update` BEFORE UPDATE ON `repayment_allocation`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'repayment_allocation is add-only: rows cannot be changed.';
CREATE TRIGGER `repayment_allocation_no_delete` BEFORE DELETE ON `repayment_allocation`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'repayment_allocation is add-only: rows cannot be deleted.';
