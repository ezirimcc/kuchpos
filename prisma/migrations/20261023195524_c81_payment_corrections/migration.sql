-- CreateTable
CREATE TABLE `payment_correction` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `requestId` CHAR(36) NOT NULL,
    `paymentId` CHAR(36) NOT NULL,
    `saleId` CHAR(36) NOT NULL,
    `tillSessionId` CHAR(36) NOT NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `fromMethodId` CHAR(36) NOT NULL,
    `fromMethodName` VARCHAR(60) NOT NULL,
    `fromKind` ENUM('CASH', 'TRANSFER', 'POS') NOT NULL,
    `toMethodId` CHAR(36) NOT NULL,
    `toMethodName` VARCHAR(60) NOT NULL,
    `toKind` ENUM('CASH', 'TRANSFER', 'POS') NOT NULL,
    `toReference` VARCHAR(60) NULL,
    `reason` VARCHAR(300) NOT NULL,
    `correctedByUserId` VARCHAR(191) NULL,
    `correctedByName` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `payment_correction_requestId_key`(`requestId`),
    INDEX `payment_correction_paymentId_createdAt_idx`(`paymentId`, `createdAt`),
    INDEX `payment_correction_saleId_idx`(`saleId`),
    INDEX `payment_correction_tillSessionId_idx`(`tillSessionId`),
    INDEX `payment_correction_businessId_createdAt_idx`(`businessId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `payment_correction` ADD CONSTRAINT `payment_correction_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payment_correction` ADD CONSTRAINT `payment_correction_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `payment`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payment_correction` ADD CONSTRAINT `payment_correction_saleId_fkey` FOREIGN KEY (`saleId`) REFERENCES `sale`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payment_correction` ADD CONSTRAINT `payment_correction_tillSessionId_fkey` FOREIGN KEY (`tillSessionId`) REFERENCES `till_session`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payment_correction` ADD CONSTRAINT `payment_correction_fromMethodId_fkey` FOREIGN KEY (`fromMethodId`) REFERENCES `payment_method`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payment_correction` ADD CONSTRAINT `payment_correction_toMethodId_fkey` FOREIGN KEY (`toMethodId`) REFERENCES `payment_method`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Limits the database keeps by itself (C81): a positive amount, a real change of method, and a reason.
ALTER TABLE `payment_correction`
  ADD CONSTRAINT `payment_correction_values_check`
  CHECK (`amount` > 0 AND `fromMethodId` <> `toMethodId` AND CHAR_LENGTH(TRIM(`reason`)) > 0);

-- Corrections are add-only.
CREATE TRIGGER `payment_correction_no_update` BEFORE UPDATE ON `payment_correction`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'payment_correction is add-only: rows cannot be changed.';
CREATE TRIGGER `payment_correction_no_delete` BEFORE DELETE ON `payment_correction`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'payment_correction is add-only: rows cannot be deleted.';
