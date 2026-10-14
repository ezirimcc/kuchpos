-- AlterTable
ALTER TABLE `stock_adjustment_line` ADD COLUMN `batchId` CHAR(36) NULL,
    ADD COLUMN `batchNumber` VARCHAR(60) NULL,
    ADD COLUMN `expiryDate` DATE NULL;

-- AlterTable
ALTER TABLE `stock_movement` ADD COLUMN `batchId` CHAR(36) NULL;

-- AlterTable
ALTER TABLE `stock_transfer_line` ADD COLUMN `batchId` CHAR(36) NULL,
    ADD COLUMN `batchNumber` VARCHAR(60) NULL,
    ADD COLUMN `earlierBatchWaiting` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `expiryDate` DATE NULL;

-- AddForeignKey
ALTER TABLE `stock_movement` ADD CONSTRAINT `stock_movement_batchId_fkey` FOREIGN KEY (`batchId`) REFERENCES `stock_batch`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_transfer_line` ADD CONSTRAINT `stock_transfer_line_batchId_fkey` FOREIGN KEY (`batchId`) REFERENCES `stock_batch`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_adjustment_line` ADD CONSTRAINT `stock_adjustment_line_batchId_fkey` FOREIGN KEY (`batchId`) REFERENCES `stock_batch`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- C76: batches are now recorded in the Storeroom only. The figures worked out under C75
-- (which also covered the Shelf, by estimate) are dropped; the Storeroom's are split again,
-- once, the first time each product's stock is touched.
DELETE FROM `stock_batch_balance`;
