-- CreateTable
CREATE TABLE `error_log` (
    `id` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `kind` VARCHAR(20) NOT NULL,
    `place` VARCHAR(300) NOT NULL,
    `message` VARCHAR(1000) NOT NULL,
    `detail` TEXT NULL,
    `digest` VARCHAR(100) NULL,
    `businessId` CHAR(36) NULL,
    `userId` VARCHAR(191) NULL,
    `userName` VARCHAR(191) NULL,
    `appVersion` VARCHAR(60) NULL,

    INDEX `error_log_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

