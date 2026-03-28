-- phpMyAdmin SQL Dump
-- version 5.2.1
-- https://www.phpmyadmin.net/
--
-- Host: 127.0.0.1
-- Generation Time: Mar 06, 2026 at 06:43 PM
-- Server version: 10.4.32-MariaDB
-- PHP Version: 8.0.30

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `freq`
--

-- --------------------------------------------------------

--
-- Table structure for table `applications`
--

CREATE TABLE `applications` (
  `id` int(11) NOT NULL,
  `package_name` varchar(255) NOT NULL,
  `app_name` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `commands`
--

CREATE TABLE `commands` (
  `id` int(11) NOT NULL,
  `device_id` int(11) NOT NULL,
  `session_id` varchar(100) DEFAULT NULL,
  `command` varchar(50) NOT NULL,
  `payload` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`payload`)),
  `status` enum('pending','sent','acknowledged','done','failed','cancelled') DEFAULT 'pending',
  `result` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`result`)),
  `error_message` text DEFAULT NULL,
  `created_at` datetime DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `executed_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `cpu_frequency_segments`
--

CREATE TABLE `cpu_frequency_segments` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `device_id` int(10) UNSIGNED NOT NULL,
  `core_type` enum('small','big') NOT NULL,
  `segment_start` bigint(20) UNSIGNED NOT NULL,
  `segment_end` bigint(20) UNSIGNED NOT NULL,
  `frequency_khz` int(10) UNSIGNED NOT NULL,
  `duration_ms` bigint(20) UNSIGNED GENERATED ALWAYS AS (`segment_end` - `segment_start`) STORED,
  `batch_id` varchar(80) DEFAULT NULL,
  `created_at` timestamp(3) NOT NULL DEFAULT current_timestamp(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci ROW_FORMAT=COMPRESSED;

-- --------------------------------------------------------

--
-- Table structure for table `devices`
--

CREATE TABLE `devices` (
  `id` int(11) NOT NULL,
  `imei` varchar(32) NOT NULL,
  `device_name` varchar(255) DEFAULT NULL,
  `group_id` int(11) DEFAULT NULL,
  `device_token` varchar(255) DEFAULT NULL,
  `device_mac` varchar(64) DEFAULT NULL,
  `device_ip` varchar(64) DEFAULT NULL,
  `last_seen` datetime DEFAULT NULL,
  `online` tinyint(1) DEFAULT 0,
  `created_at` datetime DEFAULT current_timestamp(),
  `fixer_enabled` tinyint(1) DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `device_apps`
--

CREATE TABLE `device_apps` (
  `device_id` int(11) NOT NULL,
  `application_id` int(11) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `device_app_crashes`
--

CREATE TABLE `device_app_crashes` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `device_stat_id` bigint(20) UNSIGNED NOT NULL,
  `application_id` int(11) NOT NULL,
  `crash_time` datetime NOT NULL,
  `reason` text DEFAULT NULL,
  `created_at` timestamp(3) NOT NULL DEFAULT current_timestamp(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `device_app_stats`
--

CREATE TABLE `device_app_stats` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `device_stat_id` bigint(20) UNSIGNED NOT NULL,
  `application_id` int(11) NOT NULL,
  `cpu_time_sec` double NOT NULL,
  `battery_pct` double NOT NULL,
  `received_mb` double NOT NULL DEFAULT 0,
  `transmitted_mb` double NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `device_stats`
--

CREATE TABLE `device_stats` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `device_id` int(10) UNSIGNED NOT NULL,
  `boot_time` datetime NOT NULL,
  `collected_at` timestamp(3) NOT NULL DEFAULT current_timestamp(3),
  `fixed` tinyint(1) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `device_user_actions`
--

CREATE TABLE `device_user_actions` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `device_id` int(11) NOT NULL,
  `action` enum('enable_fixer','disable_fixer','logout') NOT NULL,
  `created_at` timestamp(3) NOT NULL DEFAULT current_timestamp(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `groups`
--

CREATE TABLE `groups` (
  `id` int(11) NOT NULL,
  `name` varchar(100) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `licences`
--

CREATE TABLE `licences` (
  `id` int(11) NOT NULL,
  `device_id` int(11) NOT NULL,
  `licence_key` char(64) NOT NULL,
  `created_at` datetime DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `users`
--

CREATE TABLE `users` (
  `id` int(11) NOT NULL,
  `username` varchar(120) NOT NULL,
  `password` varchar(255) NOT NULL,
  `role` enum('admin','user') NOT NULL DEFAULT 'user',
  `first_name` varchar(120) DEFAULT NULL,
  `last_name` varchar(120) DEFAULT NULL,
  `last_login` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `processed_frequency_batches`
--

CREATE TABLE `processed_frequency_batches` (
  `batch_id` varchar(100) NOT NULL,
  `device_id` int(10) UNSIGNED NOT NULL,
  `received_at` timestamp(3) NOT NULL DEFAULT current_timestamp(3),
  `processed_at` timestamp(3) NULL DEFAULT NULL,
  `segments_count` int(10) UNSIGNED DEFAULT 0,
  `error_message` text DEFAULT NULL,
  `status` enum('received','processed','failed') DEFAULT 'received'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Indexes for dumped tables
--

--
-- Indexes for table `applications`
--
ALTER TABLE `applications`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `package_name` (`package_name`);

--
-- Indexes for table `commands`
--
ALTER TABLE `commands`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_device_status` (`device_id`,`status`),
  ADD KEY `idx_device_pending` (`device_id`,`status`,`id`),
  ADD KEY `idx_device_created` (`device_id`,`created_at`),
  ADD KEY `idx_executed_at` (`executed_at`);

--
-- Indexes for table `cpu_frequency_segments`
--
ALTER TABLE `cpu_frequency_segments`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_segment` (`device_id`,`core_type`,`segment_start`),
  ADD KEY `idx_device_time` (`device_id`,`segment_start`),
  ADD KEY `idx_device_freq` (`device_id`,`frequency_khz`,`segment_start`);

--
-- Indexes for table `devices`
--
ALTER TABLE `devices`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `imei` (`imei`),
  ADD KEY `group_id` (`group_id`),
  ADD KEY `idx_online_lastseen` (`online`,`last_seen`);

--
-- Indexes for table `device_apps`
--
ALTER TABLE `device_apps`
  ADD PRIMARY KEY (`device_id`,`application_id`),
  ADD KEY `application_id` (`application_id`),
  ADD KEY `idx_device_apps` (`device_id`);

--
-- Indexes for table `device_app_crashes`
--
ALTER TABLE `device_app_crashes`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_device_stat` (`device_stat_id`),
  ADD KEY `idx_app_crash_time` (`application_id`,`crash_time`);

--
-- Indexes for table `device_app_stats`
--
ALTER TABLE `device_app_stats`
  ADD PRIMARY KEY (`id`),
  ADD KEY `application_id` (`application_id`),
  ADD KEY `idx_stat_app` (`device_stat_id`,`application_id`);

--
-- Indexes for table `device_stats`
--
ALTER TABLE `device_stats`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_device_time` (`device_id`,`collected_at`);

--
-- Indexes for table `device_user_actions`
--
ALTER TABLE `device_user_actions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_device_time` (`device_id`,`created_at`);

--
-- Indexes for table `groups`
--
ALTER TABLE `groups`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `name` (`name`);

--
-- Indexes for table `licences`
--
ALTER TABLE `licences`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `device_id` (`device_id`),
  ADD UNIQUE KEY `licence_key` (`licence_key`);

--
-- Indexes for table `users`
--
ALTER TABLE `users`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `username` (`username`);

--
-- Indexes for table `processed_frequency_batches`
--
ALTER TABLE `processed_frequency_batches`
  ADD PRIMARY KEY (`device_id`,`batch_id`),
  ADD KEY `idx_device_received` (`device_id`,`received_at`),
  ADD KEY `idx_received_at` (`received_at`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `applications`
--
ALTER TABLE `applications`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=91;

--
-- AUTO_INCREMENT for table `commands`
--
ALTER TABLE `commands`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=94;

--
-- AUTO_INCREMENT for table `cpu_frequency_segments`
--
ALTER TABLE `cpu_frequency_segments`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=685;

--
-- AUTO_INCREMENT for table `devices`
--
ALTER TABLE `devices`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=13;

--
-- AUTO_INCREMENT for table `device_app_crashes`
--
ALTER TABLE `device_app_crashes`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=5;

--
-- AUTO_INCREMENT for table `device_app_stats`
--
ALTER TABLE `device_app_stats`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=64;

--
-- AUTO_INCREMENT for table `device_stats`
--
ALTER TABLE `device_stats`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=4;

--
-- AUTO_INCREMENT for table `device_user_actions`
--
ALTER TABLE `device_user_actions`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `groups`
--
ALTER TABLE `groups`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=13;

--
-- AUTO_INCREMENT for table `licences`
--
ALTER TABLE `licences`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `users`
--
ALTER TABLE `users`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

--
-- Constraints for dumped tables
--

--
-- Constraints for table `commands`
--
ALTER TABLE `commands`
  ADD CONSTRAINT `commands_ibfk_1` FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `devices`
--
ALTER TABLE `devices`
  ADD CONSTRAINT `devices_ibfk_1` FOREIGN KEY (`group_id`) REFERENCES `groups` (`id`);

--
-- Constraints for table `device_apps`
--
ALTER TABLE `device_apps`
  ADD CONSTRAINT `device_apps_ibfk_1` FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `device_apps_ibfk_2` FOREIGN KEY (`application_id`) REFERENCES `applications` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `device_app_crashes`
--
ALTER TABLE `device_app_crashes`
  ADD CONSTRAINT `device_app_crashes_ibfk_1` FOREIGN KEY (`device_stat_id`) REFERENCES `device_stats` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `device_app_crashes_ibfk_2` FOREIGN KEY (`application_id`) REFERENCES `applications` (`id`);

--
-- Constraints for table `device_app_stats`
--
ALTER TABLE `device_app_stats`
  ADD CONSTRAINT `device_app_stats_ibfk_1` FOREIGN KEY (`device_stat_id`) REFERENCES `device_stats` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `device_app_stats_ibfk_2` FOREIGN KEY (`application_id`) REFERENCES `applications` (`id`);

--
-- Constraints for table `device_user_actions`
--
ALTER TABLE `device_user_actions`
  ADD CONSTRAINT `fk_user_action_device` FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `licences`
--
ALTER TABLE `licences`
  ADD CONSTRAINT `fk_licence_device` FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`) ON DELETE CASCADE;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
