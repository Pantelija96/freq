-- Device Efficiency schema
-- Target database: MySQL 8.0+
-- This file intentionally contains only schema objects.
-- Database creation and user creation are handled separately.

SET NAMES utf8mb4;

SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS `licences`;
DROP TABLE IF EXISTS `device_user_actions`;
DROP TABLE IF EXISTS `device_app_crashes`;
DROP TABLE IF EXISTS `device_app_stats`;
DROP TABLE IF EXISTS `device_stats`;
DROP TABLE IF EXISTS `device_apps`;
DROP TABLE IF EXISTS `commands`;
DROP TABLE IF EXISTS `processed_frequency_batches`;
DROP TABLE IF EXISTS `cpu_frequency_segments`;
DROP TABLE IF EXISTS `users`;
DROP TABLE IF EXISTS `devices`;
DROP TABLE IF EXISTS `applications`;
DROP TABLE IF EXISTS `groups`;

SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE `groups` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(100) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_groups_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `applications` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `package_name` VARCHAR(255) NOT NULL,
  `app_name` VARCHAR(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_applications_package_name` (`package_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `devices` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `imei` VARCHAR(32) NOT NULL,
  `device_name` VARCHAR(255) DEFAULT NULL,
  `group_id` INT DEFAULT NULL,
  `device_token` VARCHAR(255) DEFAULT NULL,
  `device_mac` VARCHAR(64) DEFAULT NULL,
  `device_ip` VARCHAR(64) DEFAULT NULL,
  `last_seen` DATETIME DEFAULT NULL,
  `online` TINYINT(1) DEFAULT 0,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `fixer_enabled` TINYINT(1) DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_devices_imei` (`imei`),
  KEY `idx_devices_group_id` (`group_id`),
  KEY `idx_devices_online_last_seen` (`online`, `last_seen`),
  CONSTRAINT `fk_devices_group`
    FOREIGN KEY (`group_id`) REFERENCES `groups` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `users` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `username` VARCHAR(120) NOT NULL,
  `password` VARCHAR(255) NOT NULL,
  `role` ENUM('admin', 'user') NOT NULL DEFAULT 'user',
  `first_name` VARCHAR(120) DEFAULT NULL,
  `last_name` VARCHAR(120) DEFAULT NULL,
  `last_login` DATETIME DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_users_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `cpu_frequency_segments` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `device_id` INT UNSIGNED NOT NULL,
  `core_type` ENUM('small', 'big') NOT NULL,
  `segment_start` BIGINT UNSIGNED NOT NULL,
  `segment_end` BIGINT UNSIGNED NOT NULL,
  `frequency_khz` INT UNSIGNED NOT NULL,
  `duration_ms` BIGINT UNSIGNED GENERATED ALWAYS AS (`segment_end` - `segment_start`) STORED,
  `batch_id` VARCHAR(80) DEFAULT NULL,
  `created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cpu_frequency_segments_device_core_start` (`device_id`, `core_type`, `segment_start`),
  KEY `idx_cpu_frequency_segments_device_time` (`device_id`, `segment_start`),
  KEY `idx_cpu_frequency_segments_device_freq` (`device_id`, `frequency_khz`, `segment_start`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `processed_frequency_batches` (
  `batch_id` VARCHAR(100) NOT NULL,
  `device_id` INT UNSIGNED NOT NULL,
  `received_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `processed_at` TIMESTAMP(3) NULL DEFAULT NULL,
  `segments_count` INT UNSIGNED DEFAULT 0,
  `error_message` TEXT DEFAULT NULL,
  `status` ENUM('received', 'processed', 'failed') DEFAULT 'received',
  PRIMARY KEY (`device_id`, `batch_id`),
  KEY `idx_processed_frequency_batches_device_received` (`device_id`, `received_at`),
  KEY `idx_processed_frequency_batches_received_at` (`received_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `commands` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `device_id` INT NOT NULL,
  `session_id` VARCHAR(100) DEFAULT NULL,
  `requested_by_user_id` INT DEFAULT NULL,
  `requested_by_label` VARCHAR(120) DEFAULT NULL,
  `command` VARCHAR(50) NOT NULL,
  `payload` JSON DEFAULT NULL,
  `status` ENUM('pending', 'sent', 'acknowledged', 'done', 'failed', 'cancelled') DEFAULT 'pending',
  `result` JSON DEFAULT NULL,
  `error_message` TEXT DEFAULT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `executed_at` DATETIME DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_commands_device_status` (`device_id`, `status`),
  KEY `idx_commands_device_pending` (`device_id`, `status`, `id`),
  KEY `idx_commands_device_created` (`device_id`, `created_at`),
  KEY `idx_commands_executed_at` (`executed_at`),
  KEY `idx_commands_requested_by_user_id` (`requested_by_user_id`),
  CONSTRAINT `fk_commands_device`
    FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_commands_requested_by_user`
    FOREIGN KEY (`requested_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `device_apps` (
  `device_id` INT NOT NULL,
  `application_id` INT NOT NULL,
  PRIMARY KEY (`device_id`, `application_id`),
  KEY `idx_device_apps_application_id` (`application_id`),
  KEY `idx_device_apps_device_id` (`device_id`),
  CONSTRAINT `fk_device_apps_device`
    FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_device_apps_application`
    FOREIGN KEY (`application_id`) REFERENCES `applications` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `device_stats` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `device_id` INT UNSIGNED NOT NULL,
  `boot_time` DATETIME NOT NULL,
  `collected_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `fixed` TINYINT(1) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_device_stats_device_collected_at` (`device_id`, `collected_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `device_app_stats` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `device_stat_id` BIGINT UNSIGNED NOT NULL,
  `application_id` INT NOT NULL,
  `cpu_time_sec` DOUBLE NOT NULL,
  `battery_pct` DOUBLE NOT NULL,
  `received_mb` DOUBLE NOT NULL DEFAULT 0,
  `transmitted_mb` DOUBLE NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_device_app_stats_application_id` (`application_id`),
  KEY `idx_device_app_stats_stat_app` (`device_stat_id`, `application_id`),
  CONSTRAINT `fk_device_app_stats_device_stat`
    FOREIGN KEY (`device_stat_id`) REFERENCES `device_stats` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_device_app_stats_application`
    FOREIGN KEY (`application_id`) REFERENCES `applications` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `device_app_crashes` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `device_stat_id` BIGINT UNSIGNED NOT NULL,
  `application_id` INT NOT NULL,
  `crash_time` DATETIME NOT NULL,
  `reason` TEXT DEFAULT NULL,
  `created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_device_app_crashes_device_stat` (`device_stat_id`),
  KEY `idx_device_app_crashes_app_crash_time` (`application_id`, `crash_time`),
  CONSTRAINT `fk_device_app_crashes_device_stat`
    FOREIGN KEY (`device_stat_id`) REFERENCES `device_stats` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_device_app_crashes_application`
    FOREIGN KEY (`application_id`) REFERENCES `applications` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `device_user_actions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `device_id` INT NOT NULL,
  `action` ENUM('enable_fixer', 'disable_fixer', 'logout') NOT NULL,
  `created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_device_user_actions_device_created_at` (`device_id`, `created_at`),
  CONSTRAINT `fk_device_user_actions_device`
    FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `licences` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `device_id` INT NOT NULL,
  `licence_key` CHAR(64) NOT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_licences_device_id` (`device_id`),
  UNIQUE KEY `uq_licences_licence_key` (`licence_key`),
  CONSTRAINT `fk_licences_device`
    FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
