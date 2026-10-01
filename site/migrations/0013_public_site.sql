-- The public site, S1 (2026-09-30; 设计文档「公开站方案」):
--
-- 1. The four names the circle has worked under (eras) in the site's three languages: their names, years and a
--    line on each, as approved translations (entity 'era'). The eras keep their Chinese name and years; the site
--    shows a translation where there is one. The lines come from the design document's 「名义沿革」.
-- 2. meta.public_version: the catalogue's version, counted up by every saved change (ChangeSet.commit); the
--    public pages are cached per version (src/lib/public/cache.ts).

WITH v (id, field, lang, value) AS (VALUES
  ('rigel-theatre', 'years', 'ja', '2013 年〜'),
  ('rigel-theatre', 'years', 'en', '2013–'),
  ('rigel-theatre', 'description', 'zh', '2013 年起的名义。2014 年 4 月发行 1st Album，此后几乎每张新作都在 M3 首发。'),
  ('rigel-theatre', 'description', 'ja', '2013 年からの名義。2014 年 4 月に 1st Album を頒布し、以降ほぼすべての新作を M3 で発表。'),
  ('rigel-theatre', 'description', 'en', 'The name since 2013. The first album came out in April 2014; almost every release since has premiered at M3.'),
  ('grand-thaw', 'years', 'ja', '2010〜2013 年頃'),
  ('grand-thaw', 'years', 'en', 'c. 2010–2013'),
  ('grand-thaw', 'description', 'zh', 'BMS 制作组，井上⊿负责作曲。SOLROS 参加 BOF2011，Äventyr 是 BOF2012 的最高得分曲。'),
  ('grand-thaw', 'description', 'ja', '井上⊿が作曲を担当した BMS 制作チーム。SOLROS で BOF2011 に参加し、Äventyr は BOF2012 の最高得点曲。'),
  ('grand-thaw', 'description', 'en', 'A BMS team with Inoue Delta as composer. SOLROS entered BOF2011; Äventyr was the top-scoring song of BOF2012.'),
  ('delta-records', 'years', 'ja', '2004〜2010 年頃'),
  ('delta-records', 'years', 'en', 'c. 2004–2010'),
  ('delta-records', 'description', 'zh', '个人网站时期的 MIDI 与 BMS 作品；Autumn Breeze（2004）与 Maple Town Memories（2005）是 LUNA 系列的原点。'),
  ('delta-records', 'description', 'ja', '個人サイト時代の MIDI・BMS 作品。Autumn Breeze（2004）と Maple Town Memories（2005）は LUNA シリーズの原点。'),
  ('delta-records', 'description', 'en', 'MIDI and BMS works from the personal website years; Autumn Breeze (2004) and Maple Town Memories (2005) are where the LUNA series began.'),
  ('dezaemon', 'name', 'ja', 'DEZAEMON 投稿'),
  ('dezaemon', 'name', 'en', 'DEZAEMON submissions'),
  ('dezaemon', 'years', 'ja', '2003 年前後'),
  ('dezaemon', 'years', 'en', 'around 2003'),
  ('dezaemon', 'description', 'zh', '以「井上⊿」之名为 DEZAEMON 自制游戏作曲，如 Lost Vision、MID NIGHT BIRDS。'),
  ('dezaemon', 'description', 'ja', '「井上⊿」名義で DEZAEMON の自作ゲームに楽曲を提供（Lost Vision、MID NIGHT BIRDS など）。'),
  ('dezaemon', 'description', 'en', 'Music for games made with DEZAEMON, as «Inoue Delta» — Lost Vision, MID NIGHT BIRDS and others.')
)
INSERT INTO translations (entity, entity_id, field, lang, value, status)
SELECT 'era', e.id, v.field, v.lang, v.value, 'approved' FROM v JOIN eras e ON e.id = v.id
WHERE true
ON CONFLICT (entity, entity_id, field, lang) DO NOTHING;

INSERT INTO meta (key, value) VALUES ('public_version', '1') ON CONFLICT (key) DO NOTHING;
