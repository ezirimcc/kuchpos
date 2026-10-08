-- AlterTable
ALTER TABLE `stock_movement` MODIFY `type` ENUM('RECEIPT', 'RECEIPT_CORRECTION', 'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUSTMENT', 'SALE', 'SALE_CANCELLATION') NOT NULL;

-- CreateTable
CREATE TABLE `sale_cancellation` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `saleId` CHAR(36) NOT NULL,
    `note` VARCHAR(300) NOT NULL,
    `cancelledByUserId` VARCHAR(191) NULL,
    `cancelledByName` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `sale_cancellation_saleId_key`(`saleId`),
    INDEX `sale_cancellation_businessId_createdAt_idx`(`businessId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `refund` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `saleId` CHAR(36) NOT NULL,
    `cancellationId` CHAR(36) NOT NULL,
    `paymentId` CHAR(36) NOT NULL,
    `methodId` CHAR(36) NOT NULL,
    `methodName` VARCHAR(60) NOT NULL,
    `kind` ENUM('CASH', 'TRANSFER', 'POS') NOT NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `tillSessionId` CHAR(36) NULL,
    `refundedByUserId` VARCHAR(191) NULL,
    `refundedByName` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `refund_paymentId_key`(`paymentId`),
    INDEX `refund_saleId_idx`(`saleId`),
    INDEX `refund_tillSessionId_idx`(`tillSessionId`),
    INDEX `refund_businessId_createdAt_idx`(`businessId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `sale_cancellation` ADD CONSTRAINT `sale_cancellation_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `sale_cancellation` ADD CONSTRAINT `sale_cancellation_saleId_fkey` FOREIGN KEY (`saleId`) REFERENCES `sale`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `refund` ADD CONSTRAINT `refund_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `refund` ADD CONSTRAINT `refund_saleId_fkey` FOREIGN KEY (`saleId`) REFERENCES `sale`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `refund` ADD CONSTRAINT `refund_cancellationId_fkey` FOREIGN KEY (`cancellationId`) REFERENCES `sale_cancellation`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `refund` ADD CONSTRAINT `refund_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `payment`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `refund` ADD CONSTRAINT `refund_methodId_fkey` FOREIGN KEY (`methodId`) REFERENCES `payment_method`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `refund` ADD CONSTRAINT `refund_tillSessionId_fkey` FOREIGN KEY (`tillSessionId`) REFERENCES `till_session`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Cancelling a sale (added by hand). MariaDB 10.6 compatible.
-- ---------------------------------------------------------------------------

-- A cancellation must say why.
ALTER TABLE `sale_cancellation`
  ADD CONSTRAINT `sale_cancellation_note_check`
  CHECK (CHAR_LENGTH(TRIM(`note`)) > 0);

-- A refund is a positive amount, and cash always comes out of a till session.
ALTER TABLE `refund`
  ADD CONSTRAINT `refund_amounts_check`
  CHECK (`amount` > 0 AND (`kind` <> 'CASH' OR `tillSessionId` IS NOT NULL));

-- Cancellations and refunds are add-only.
CREATE TRIGGER `sale_cancellation_no_update` BEFORE UPDATE ON `sale_cancellation`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sale_cancellation is add-only: rows cannot be changed.';
CREATE TRIGGER `sale_cancellation_no_delete` BEFORE DELETE ON `sale_cancellation`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sale_cancellation is add-only: rows cannot be deleted.';
CREATE TRIGGER `refund_no_update` BEFORE UPDATE ON `refund`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'refund is add-only: rows cannot be changed.';
CREATE TRIGGER `refund_no_delete` BEFORE DELETE ON `refund`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'refund is add-only: rows cannot be deleted.';
