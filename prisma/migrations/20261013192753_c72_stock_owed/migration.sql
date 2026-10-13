-- AlterTable
ALTER TABLE `stock_movement` MODIFY `type` ENUM('RECEIPT', 'RECEIPT_CORRECTION', 'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUSTMENT', 'SALE', 'SALE_CANCELLATION', 'SALE_RETURN', 'OPENING_BALANCE', 'SHORTFALL_COVERED') NOT NULL;

-- CreateTable
CREATE TABLE `stock_owed` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `locationId` CHAR(36) NOT NULL,
    `quantity` DECIMAL(16, 3) NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `stock_owed_businessId_idx`(`businessId`),
    UNIQUE INDEX `stock_owed_productId_locationId_key`(`productId`, `locationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `stock_owed` ADD CONSTRAINT `stock_owed_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_owed` ADD CONSTRAINT `stock_owed_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `product`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_owed` ADD CONSTRAINT `stock_owed_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `location`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- What a place owes can never be below nothing.
ALTER TABLE `stock_owed`
  ADD CONSTRAINT `stock_owed_quantity_check`
  CHECK (`quantity` >= 0);

-- Shortfalls recorded before this rule existed become stock owed, so that the rule
-- "owed = shortfalls of the sale lines there, less what has been covered" holds from the start.
INSERT INTO `stock_owed` (`id`, `businessId`, `productId`, `locationId`, `quantity`, `updatedAt`)
SELECT UUID(), `businessId`, `productId`, `locationId`, SUM(`stockShort`), NOW(3)
FROM `sale_line`
WHERE `stockShort` > 0
GROUP BY `businessId`, `productId`, `locationId`;
