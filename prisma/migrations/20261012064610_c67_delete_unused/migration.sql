-- DropForeignKey
ALTER TABLE `activity_log` DROP FOREIGN KEY `activity_log_actorUserId_fkey`;

-- DropForeignKey
ALTER TABLE `credit_limit_change` DROP FOREIGN KEY `credit_limit_change_customerId_fkey`;

-- DropForeignKey
ALTER TABLE `price_change` DROP FOREIGN KEY `price_change_productId_fkey`;

-- DropForeignKey
ALTER TABLE `price_change` DROP FOREIGN KEY `price_change_productUnitId_fkey`;

-- DropIndex
DROP INDEX `activity_log_actorUserId_fkey` ON `activity_log`;

-- DropIndex
DROP INDEX `price_change_productUnitId_fkey` ON `price_change`;

-- AddForeignKey
ALTER TABLE `activity_log` ADD CONSTRAINT `activity_log_actorUserId_fkey` FOREIGN KEY (`actorUserId`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `price_change` ADD CONSTRAINT `price_change_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `product`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `price_change` ADD CONSTRAINT `price_change_productUnitId_fkey` FOREIGN KEY (`productUnitId`) REFERENCES `product_unit`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `credit_limit_change` ADD CONSTRAINT `credit_limit_change_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customer`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;


-- C67: a customer who was never used can be deleted. Customers with any sale, debt entry or
-- repayment are still protected, by the foreign keys of those tables (ON DELETE RESTRICT).
DROP TRIGGER `customer_no_delete`;
