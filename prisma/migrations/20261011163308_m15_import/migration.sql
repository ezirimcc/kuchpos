-- AlterTable
ALTER TABLE `customer_account_entry` MODIFY `type` ENUM('CREDIT_SALE', 'REPAYMENT', 'SALE_CANCELLED', 'SALE_RETURN', 'OPENING_BALANCE') NOT NULL;

-- AlterTable
ALTER TABLE `document_counter` MODIFY `kind` ENUM('GOODS_RECEIPT', 'STOCK_TRANSFER', 'STOCK_COUNT', 'STOCK_ADJUSTMENT', 'TILL_SESSION', 'REPAYMENT', 'SALE_RETURN', 'IMPORT') NOT NULL;

-- AlterTable
ALTER TABLE `stock_movement` MODIFY `type` ENUM('RECEIPT', 'RECEIPT_CORRECTION', 'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUSTMENT', 'SALE', 'SALE_CANCELLATION', 'SALE_RETURN', 'OPENING_BALANCE') NOT NULL;

-- CreateTable
CREATE TABLE `import_run` (
    `id` CHAR(36) NOT NULL,
    `businessId` CHAR(36) NOT NULL,
    `number` INTEGER NOT NULL,
    `part` ENUM('SETUP', 'HISTORY') NOT NULL,
    `fileHash` CHAR(64) NOT NULL,
    `fileName` VARCHAR(200) NOT NULL,
    `startingDay` DATE NULL,
    `summary` TEXT NOT NULL,
    `createdByUserId` VARCHAR(191) NULL,
    `createdByName` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `import_run_businessId_part_fileHash_key`(`businessId`, `part`, `fileHash`),
    UNIQUE INDEX `import_run_businessId_number_key`(`businessId`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `import_run` ADD CONSTRAINT `import_run_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `business`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------
-- Imports from Excel (added by hand). MariaDB 10.6 compatible.
-- ---------------------------------------------------------------------------

-- The record of an import is add-only.
CREATE TRIGGER `import_run_no_update` BEFORE UPDATE ON `import_run`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'import_run is add-only: rows cannot be changed.';
CREATE TRIGGER `import_run_no_delete` BEFORE DELETE ON `import_run`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'import_run is add-only: rows cannot be deleted.';
