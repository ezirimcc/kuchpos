-- Payment methods managed by each business, split payments, and till sessions.
-- (Written by hand: payments that already exist are moved onto the new "Cash" method
-- of their business before the old column is removed, so nothing is lost.)

-- AlterTable
ALTER TABLE `document_counter` MODIFY `kind` ENUM('GOODS_RECEIPT', 'STOCK_TRANSFER', 'STOCK_COUNT', 'STOCK_ADJUSTMENT', 'TILL_SESSION') NOT NULL;

-- CreateTable
CREATE TABLE `payment_method` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `kind` ENUM('CASH', 'TRANSFER', 'POS') NOT NULL,
    `builtIn` BOOLEAN NOT NULL DEFAULT false,
    `deactivatedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `payment_method_businessId_name_key`(`businessId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `till_session` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `number` INTEGER NOT NULL,
    `terminalId` CHAR(36) NOT NULL,
    `terminalCode` VARCHAR(6) NOT NULL,
    `openingFloat` DECIMAL(14, 2) NOT NULL,
    `openedByUserId` VARCHAR(191) NULL,
    `openedByName` VARCHAR(191) NOT NULL,
    `openedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `till_session_terminalId_openedAt_idx`(`terminalId`, `openedAt`),
    INDEX `till_session_businessId_openedAt_idx`(`businessId`, `openedAt`),
    UNIQUE INDEX `till_session_businessId_number_key`(`businessId`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `till_session_close` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `sessionId` CHAR(36) NOT NULL,
    `expectedCash` DECIMAL(14, 2) NOT NULL,
    `countedCash` DECIMAL(14, 2) NOT NULL,
    `difference` DECIMAL(14, 2) NOT NULL,
    `note` VARCHAR(300) NULL,
    `closedByUserId` VARCHAR(191) NULL,
    `closedByName` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `till_session_close_sessionId_key`(`sessionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Every business gets its "Cash" method.
INSERT INTO `payment_method` (`id`, `businessId`, `name`, `kind`, `builtIn`, `createdAt`, `updatedAt`)
  SELECT UUID(), `id`, 'Cash', 'CASH', true, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3) FROM `business`;

-- AlterTable: the new columns first, empty…
ALTER TABLE `payment`
    ADD COLUMN `kind` ENUM('CASH', 'TRANSFER', 'POS') NULL,
    ADD COLUMN `methodId` CHAR(36) NULL,
    ADD COLUMN `methodName` VARCHAR(60) NULL,
    ADD COLUMN `reference` VARCHAR(60) NULL,
    ADD COLUMN `tillSessionId` CHAR(36) NULL;

-- …then every existing payment (all were cash) is pointed at its business's Cash method.
-- Payments are add-only, so the guard is lifted for this one statement and put straight back.
DROP TRIGGER `payment_no_update`;
UPDATE `payment` p
  JOIN `payment_method` m ON m.`businessId` = p.`businessId` AND m.`builtIn` = true
  SET p.`methodId` = m.`id`, p.`methodName` = m.`name`, p.`kind` = 'CASH';
CREATE TRIGGER `payment_no_update` BEFORE UPDATE ON `payment`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'payment is add-only: rows cannot be changed.';

-- …and only then are they made compulsory and the old column removed.
ALTER TABLE `payment` DROP COLUMN `method`,
    MODIFY `kind` ENUM('CASH', 'TRANSFER', 'POS') NOT NULL,
    MODIFY `methodId` CHAR(36) NOT NULL,
    MODIFY `methodName` VARCHAR(60) NOT NULL;

-- AlterTable
ALTER TABLE `sale` ADD COLUMN `tillSessionId` CHAR(36) NULL;

-- CreateIndex
CREATE INDEX `payment_tillSessionId_idx` ON `payment`(`tillSessionId`);

-- CreateIndex
CREATE INDEX `sale_tillSessionId_idx` ON `sale`(`tillSessionId`);

-- AddForeignKey
ALTER TABLE `sale` ADD CONSTRAINT `sale_tillSessionId_fkey` FOREIGN KEY (`tillSessionId`) REFERENCES `till_session`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payment_method` ADD CONSTRAINT `payment_method_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payment` ADD CONSTRAINT `payment_methodId_fkey` FOREIGN KEY (`methodId`) REFERENCES `payment_method`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `payment` ADD CONSTRAINT `payment_tillSessionId_fkey` FOREIGN KEY (`tillSessionId`) REFERENCES `till_session`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `till_session` ADD CONSTRAINT `till_session_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `till_session` ADD CONSTRAINT `till_session_terminalId_fkey` FOREIGN KEY (`terminalId`) REFERENCES `terminal`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `till_session_close` ADD CONSTRAINT `till_session_close_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `till_session_close` ADD CONSTRAINT `till_session_close_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `till_session`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Rules the database keeps by itself. MariaDB 10.6 compatible.
-- ---------------------------------------------------------------------------

-- Only cash is "handed over" with change; a transfer or POS payment is exactly its amount.
ALTER TABLE `payment`
  ADD CONSTRAINT `payment_tender_is_cash_check`
  CHECK (`kind` = 'CASH' OR (`tendered` IS NULL AND `changeGiven` IS NULL));

-- The built-in Cash method is cash, and can never be switched off.
ALTER TABLE `payment_method`
  ADD CONSTRAINT `payment_method_built_in_check`
  CHECK (`builtIn` = false OR (`kind` = 'CASH' AND `deactivatedAt` IS NULL));

ALTER TABLE `till_session`
  ADD CONSTRAINT `till_session_float_check`
  CHECK (`openingFloat` >= 0 AND `number` >= 1);

ALTER TABLE `till_session_close`
  ADD CONSTRAINT `till_session_close_amounts_check`
  CHECK (`countedCash` >= 0 AND `expectedCash` >= 0 AND `difference` = `countedCash` - `expectedCash`);

-- A payment method is never deleted, and its kind never changes.
CREATE TRIGGER `payment_method_no_delete` BEFORE DELETE ON `payment_method`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'payment_method rows cannot be deleted.';
CREATE TRIGGER `payment_method_kind_fixed` BEFORE UPDATE ON `payment_method`
  FOR EACH ROW
  IF NEW.`kind` <> OLD.`kind` OR NEW.`businessId` <> OLD.`businessId` OR NEW.`builtIn` <> OLD.`builtIn` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The kind of a payment method cannot be changed.';
  END IF;

-- Till sessions and their closings are add-only.
CREATE TRIGGER `till_session_no_update` BEFORE UPDATE ON `till_session`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'till_session is add-only: rows cannot be changed.';
CREATE TRIGGER `till_session_no_delete` BEFORE DELETE ON `till_session`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'till_session is add-only: rows cannot be deleted.';
CREATE TRIGGER `till_session_close_no_update` BEFORE UPDATE ON `till_session_close`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'till_session_close is add-only: rows cannot be changed.';
CREATE TRIGGER `till_session_close_no_delete` BEFORE DELETE ON `till_session_close`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'till_session_close is add-only: rows cannot be deleted.';
