-- CreateTable
CREATE TABLE `backup_run` (
    `id` CHAR(36) NOT NULL,
    `kind` VARCHAR(20) NOT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,
    `fileName` VARCHAR(200) NULL,
    `sizeBytes` INTEGER NULL,
    `tableCount` INTEGER NULL,
    `rowCount` INTEGER NULL,
    `uploadedAt` DATETIME(3) NULL,
    `monthly` BOOLEAN NOT NULL DEFAULT false,
    `problem` VARCHAR(1000) NULL,

    INDEX `backup_run_startedAt_idx`(`startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

