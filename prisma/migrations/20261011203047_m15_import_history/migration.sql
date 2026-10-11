-- AlterTable
ALTER TABLE `document_counter` MODIFY `kind` ENUM('GOODS_RECEIPT', 'STOCK_TRANSFER', 'STOCK_COUNT', 'STOCK_ADJUSTMENT', 'TILL_SESSION', 'REPAYMENT', 'SALE_RETURN', 'IMPORT', 'IMPORTED_SALE') NOT NULL;

-- AlterTable
ALTER TABLE `sale` ADD COLUMN `importRunId` CHAR(36) NULL;

-- CreateIndex
CREATE INDEX `sale_importRunId_idx` ON `sale`(`importRunId`);

-- AddForeignKey
ALTER TABLE `sale` ADD CONSTRAINT `sale_importRunId_fkey` FOREIGN KEY (`importRunId`) REFERENCES `import_run`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

