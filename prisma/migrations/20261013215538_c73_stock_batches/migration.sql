-- CreateTable
CREATE TABLE `stock_batch` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `batchNumber` VARCHAR(60) NULL,
    `expiryDate` DATE NULL,
    `batchKey` VARCHAR(80) NOT NULL,
    `receivedOn` DATE NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `stock_batch_businessId_idx`(`businessId`),
    UNIQUE INDEX `stock_batch_productId_batchKey_key`(`productId`, `batchKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_batch_balance` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `batchId` CHAR(36) NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `locationId` CHAR(36) NOT NULL,
    `quantity` DECIMAL(16, 3) NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `stock_batch_balance_productId_locationId_idx`(`productId`, `locationId`),
    INDEX `stock_batch_balance_businessId_idx`(`businessId`),
    UNIQUE INDEX `stock_batch_balance_batchId_locationId_key`(`batchId`, `locationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `stock_batch` ADD CONSTRAINT `stock_batch_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_batch` ADD CONSTRAINT `stock_batch_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `product`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_batch_balance` ADD CONSTRAINT `stock_batch_balance_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_batch_balance` ADD CONSTRAINT `stock_batch_balance_batchId_fkey` FOREIGN KEY (`batchId`) REFERENCES `stock_batch`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_batch_balance` ADD CONSTRAINT `stock_batch_balance_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `product`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `stock_batch_balance` ADD CONSTRAINT `stock_batch_balance_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `location`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- What is left of a batch in a place can never be below nothing.
ALTER TABLE `stock_batch_balance`
  ADD CONSTRAINT `stock_batch_balance_quantity_check`
  CHECK (`quantity` >= 0);
