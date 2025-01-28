CREATE TABLE `channels` (
 `ai` int(11) NOT NULL AUTO_INCREMENT,
 `id` varchar(8) NOT NULL,
 `name` text NOT NULL,
 `public` tinyint(1) NOT NULL DEFAULT 0,
 `tldadmin` tinyint(1) NOT NULL DEFAULT 0,
 `admins` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '[]' CHECK (json_valid(`admins`)),
 `fee` double DEFAULT NULL,
 `tx` varchar(64) DEFAULT NULL,
 `activated` tinyint(1) NOT NULL DEFAULT 0,
 `created` int(11) NOT NULL,
 `hidden` tinyint(1) NOT NULL DEFAULT 0,
 `registry` text DEFAULT NULL,
 `slds` tinyint(1) NOT NULL DEFAULT 0,
 `hip2` tinyint(1) NOT NULL DEFAULT 0,
 `pinned` varchar(32) DEFAULT NULL,
 PRIMARY KEY (`ai`),
 UNIQUE KEY `id` (`id`),
 KEY `tx` (`tx`,`activated`,`hidden`)
) ENGINE=InnoDB AUTO_INCREMENT=0 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `conversations` (
 `ai` int(11) NOT NULL AUTO_INCREMENT,
 `id` varchar(16) NOT NULL,
 `users` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`users`)),
 PRIMARY KEY (`ai`),
 UNIQUE KEY `id` (`id`),
 KEY `users` (`users`(768))
) ENGINE=InnoDB AUTO_INCREMENT=0 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `domains` (
 `ai` int(11) NOT NULL AUTO_INCREMENT,
 `id` varchar(16) NOT NULL,
 `domain` varchar(253) NOT NULL,
 `tld` varchar(255) GENERATED ALWAYS AS (regexp_replace(`domain`,'((.+)\\.)?(.+)','\\3')) VIRTUAL,
 `session` varchar(100) DEFAULT NULL,
 `code` varchar(32) DEFAULT NULL,
 `type` varchar(16) DEFAULT NULL,
 `eth` text DEFAULT NULL,
 `signature` text DEFAULT NULL,
 `admin` tinyint(1) NOT NULL DEFAULT 0,
 `claimed` tinyint(1) GENERATED ALWAYS AS (`session` is not null) VIRTUAL,
 `locked` tinyint(1) NOT NULL DEFAULT 0,
 `deleted` tinyint(1) NOT NULL DEFAULT 0,
 `avatar` text DEFAULT NULL,
 `address` text DEFAULT NULL,
 `bio` varchar(140) DEFAULT NULL,
 `created` int(11) DEFAULT NULL,
 PRIMARY KEY (`ai`),
 UNIQUE KEY `id` (`id`),
 UNIQUE KEY `code` (`code`),
 KEY `claimed` (`claimed`),
 KEY `locked` (`locked`),
 KEY `deleted` (`deleted`),
 KEY `domain` (`domain`),
 KEY `domain_2` (`domain`,`claimed`,`locked`,`deleted`),
 KEY `claimed_2` (`claimed`,`locked`,`deleted`),
 KEY `session` (`session`)
) ENGINE=InnoDB AUTO_INCREMENT=0 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `invites` (
 `ai` int(11) NOT NULL AUTO_INCREMENT,
 `code` varchar(100) DEFAULT NULL,
 `tld` text DEFAULT NULL,
 PRIMARY KEY (`ai`)
) ENGINE=InnoDB AUTO_INCREMENT=0 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `messages` (
 `ai` int(11) NOT NULL AUTO_INCREMENT,
 `id` varchar(32) NOT NULL,
 `time` bigint(20) NOT NULL,
 `conversation` varchar(16) NOT NULL,
 `user` varchar(263) NOT NULL,
 `message` text NOT NULL,
 `signed` tinyint(1) NOT NULL DEFAULT 0,
 `signature` varchar(88) DEFAULT NULL,
 `reply` tinyint(1) NOT NULL DEFAULT 0,
 `replying` varchar(32) DEFAULT NULL,
 `reactions` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT '{}',
 PRIMARY KEY (`ai`),
 UNIQUE KEY `id` (`id`),
 KEY `conversation` (`conversation`),
 KEY `user` (`user`),
 KEY `time` (`time`)
) ENGINE=InnoDB AUTO_INCREMENT=0 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `polls` (
 `ai` int(11) NOT NULL AUTO_INCREMENT,
 `type` varchar(12) DEFAULT NULL,
 `user` varchar(100) DEFAULT NULL,
 `name` varchar(100) DEFAULT NULL,
 `channel` tinyint(1) DEFAULT 0,
 `private` tinyint(1) NOT NULL DEFAULT 0,
 `description` text DEFAULT NULL,
 `tweet` varchar(100) DEFAULT NULL,
 `time` int(11) DEFAULT NULL,
 `outcome` tinyint(1) NOT NULL DEFAULT 0,
 PRIMARY KEY (`ai`),
 UNIQUE KEY `name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `previews` (
 `ai` int(11) NOT NULL AUTO_INCREMENT,
 `id` varchar(16) DEFAULT NULL,
 `link` varchar(1000) DEFAULT NULL,
 `title` text DEFAULT NULL,
 `description` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
 `image` text DEFAULT NULL,
 `video` text DEFAULT NULL,
 PRIMARY KEY (`ai`),
 UNIQUE KEY `link` (`link`) USING HASH,
 KEY `ai` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=0 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `sessions` (
 `ai` int(11) NOT NULL AUTO_INCREMENT,
 `id` varchar(35) NOT NULL,
 `pubkey` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
 `push` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '[]' CHECK (json_valid(`push`)),
 `seen` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`seen`)),
 PRIMARY KEY (`ai`),
 UNIQUE KEY `session` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=0 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `uploads` (
 `ai` int(11) NOT NULL AUTO_INCREMENT,
 `type` varchar(5) NOT NULL,
 `id` varchar(32) NOT NULL,
 `name` text NOT NULL,
 `size` int(11) NOT NULL DEFAULT 0,
 `session` varchar(35) NOT NULL,
 PRIMARY KEY (`ai`),
 UNIQUE KEY `id` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=0 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;