-- Plan membership follows the recorded plan sizes and package positions, never timestamps.
ALTER TABLE packages ADD COLUMN plan_seq INTEGER;
WITH plans AS (
 SELECT seq,mission_id,
 SUM(CAST(replace(replace(message,'提交计划：',''),' 个工作包','') AS INTEGER))
 OVER (PARTITION BY mission_id ORDER BY seq) AS through_position,
 CAST(replace(replace(message,'提交计划：',''),' 个工作包','') AS INTEGER) AS size
 FROM events WHERE kind='plan'
)
UPDATE packages SET plan_seq=(SELECT seq FROM plans WHERE plans.mission_id=packages.mission_id
 AND packages.position>plans.through_position-plans.size AND packages.position<=plans.through_position);
CREATE INDEX events_timeline ON events(mission_id,seq) WHERE kind<>'progress';
CREATE INDEX events_package_kind ON events(package_id,kind,seq);
CREATE INDEX session_items_session_at ON session_items(engine,session,at,seq);
CREATE INDEX missions_owner_created ON missions(owner_engine,owner_session,created_at);
CREATE INDEX attempts_mission ON attempts(mission_id);
CREATE INDEX packages_mission_position ON packages(mission_id,position);
CREATE INDEX events_mission_at ON events(mission_id,at);
CREATE INDEX session_items_owner_speech ON session_items(engine,session,seq) WHERE role='assistant';
CREATE INDEX events_mission_kind_seq ON events(mission_id,kind,seq);
CREATE INDEX packages_dialogue_activity ON packages(mission_id,position) WHERE advisory=1;
