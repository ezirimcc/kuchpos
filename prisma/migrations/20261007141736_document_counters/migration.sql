-- Document numbers move from the business record to rows of their own.
-- Reason: keeping them on the business record meant every delivery, transfer, count and
-- adjustment locked that record until it finished, which made every sale in the business
-- wait, and could deadlock with a sale. (Written by hand: the columns being removed hold
-- numbers that are copied across first, so nothing is lost.)

-- CreateTable
CREATE TABLE `document_counter` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `kind` ENUM('GOODS_RECEIPT', 'STOCK_TRANSFER', 'STOCK_COUNT', 'STOCK_ADJUSTMENT') NOT NULL,
    `next` INTEGER NOT NULL DEFAULT 1,

    UNIQUE INDEX `document_counter_businessId_kind_key`(`businessId`, `kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `document_counter` ADD CONSTRAINT `document_counter_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Carry every business's numbers across before the old columns go.
INSERT INTO `document_counter` (`id`, `businessId`, `kind`, `next`)
  SELECT UUID(), `id`, 'GOODS_RECEIPT', `nextGoodsReceiptNumber` FROM `business`;
INSERT INTO `document_counter` (`id`, `businessId`, `kind`, `next`)
  SELECT UUID(), `id`, 'STOCK_TRANSFER', `nextStockTransferNumber` FROM `business`;
INSERT INTO `document_counter` (`id`, `businessId`, `kind`, `next`)
  SELECT UUID(), `id`, 'STOCK_COUNT', `nextStockCountNumber` FROM `business`;
INSERT INTO `document_counter` (`id`, `businessId`, `kind`, `next`)
  SELECT UUID(), `id`, 'STOCK_ADJUSTMENT', `nextStockAdjustmentNumber` FROM `business`;

-- AlterTable
ALTER TABLE `business` DROP COLUMN `nextGoodsReceiptNumber`,
    DROP COLUMN `nextStockAdjustmentNumber`,
    DROP COLUMN `nextStockCountNumber`,
    DROP COLUMN `nextStockTransferNumber`;

-- A counter never goes backwards and is never removed.
ALTER TABLE `document_counter`
  ADD CONSTRAINT `document_counter_next_check`
  CHECK (`next` >= 1);
CREATE TRIGGER `document_counter_no_delete` BEFORE DELETE ON `document_counter`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'document_counter rows cannot be deleted.';
CREATE TRIGGER `document_counter_only_up` BEFORE UPDATE ON `document_counter`
  FOR EACH ROW
  IF NEW.`next` <> OLD.`next` + 1 OR NEW.`businessId` <> OLD.`businessId` OR NEW.`kind` <> OLD.`kind` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'document_counter can only go up by one.';
  END IF;
