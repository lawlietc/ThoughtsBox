-- 0013_entity_mask.sql
--
-- Phase D / S10：词表管理。`mask_enabled` 是「这个词参不参与 L1 自动脱敏」的持久开关，
-- 不是删除：词表归零会让实体转正/关系端点一起断，而误遮只需要让它退出遮蔽集合。
--
-- 缺省 1（继续遮）保持既有行为逐字不变；存量行由 ADD COLUMN 的缺省回填。

ALTER TABLE entity ADD COLUMN mask_enabled INTEGER NOT NULL DEFAULT 1 CHECK (mask_enabled IN (0, 1));
