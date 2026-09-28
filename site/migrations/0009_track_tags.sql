-- 版本页与公开页改版, 第 2 期: every row of an edition's track list has a full set of tags (Picard's
-- names), written into the files when they download. A row's tags are what it sets over the file's own
-- tags (文件原值, table embedded): {"title": ["…"], "artist": ["A", "B"], "comment": []}; a name with an
-- empty list removes that tag even when the file has it. Track and disc numbers come from the order.
ALTER TABLE edition_tracks ADD COLUMN tags TEXT NOT NULL DEFAULT '{}';
-- The row's cover when it is not the one the file carries: {"file": "<picture file id>"} or
-- {"picture": "<sha256 of an embedded picture>"}, with "mode": "replace" (the front cover; other pictures
-- stay) or "add" (one more picture). NULL: the file's own pictures.
ALTER TABLE edition_tracks ADD COLUMN cover TEXT;

-- What downloads wrote so far becomes the rows' tags: the title (the edition's own, else the track's with
-- its version label), the track's credits (artist defaulting to the album artist), the album (the
-- edition's album name, else the release title), the album artist (the release's, else the era's; for
-- DEZAEMON entries 井上⊿), date, catalog number, label and the MusicBrainz ids.
-- (json_patch onto '{}' drops the names whose value is NULL.)
UPDATE edition_tracks SET tags = coalesce((
  SELECT json_patch('{}', json_object(
    'title', CASE WHEN nullif(coalesce(edition_tracks.title, t.title || coalesce(' (' || t.version_label || ')', '')), '') IS NULL THEN NULL ELSE json_array(coalesce(edition_tracks.title, t.title || coalesce(' (' || t.version_label || ')', ''))) END,
    'artist', CASE WHEN nullif(coalesce(nullif(json_extract(t.credits, '$.artist'), ''), r.artist, CASE r.era_id WHEN 'dezaemon' THEN '井上⊿' END, er.name), '') IS NULL THEN NULL ELSE json_array(coalesce(nullif(json_extract(t.credits, '$.artist'), ''), r.artist, CASE r.era_id WHEN 'dezaemon' THEN '井上⊿' END, er.name)) END,
    'album', CASE WHEN nullif(coalesce(e.album_title, r.title), '') IS NULL THEN NULL ELSE json_array(coalesce(e.album_title, r.title)) END,
    'albumartist', CASE WHEN nullif(coalesce(r.artist, CASE r.era_id WHEN 'dezaemon' THEN '井上⊿' END, er.name), '') IS NULL THEN NULL ELSE json_array(coalesce(r.artist, CASE r.era_id WHEN 'dezaemon' THEN '井上⊿' END, er.name)) END,
    'date', CASE WHEN nullif(coalesce(e.release_date, r.release_date), '') IS NULL THEN NULL ELSE json_array(coalesce(e.release_date, r.release_date)) END,
    'catalognumber', CASE WHEN nullif(coalesce(e.catalog_no, r.catalog_no), '') IS NULL THEN NULL ELSE json_array(coalesce(e.catalog_no, r.catalog_no)) END,
    'label', CASE WHEN nullif(coalesce(r.artist, CASE r.era_id WHEN 'dezaemon' THEN '井上⊿' END, er.name), '') IS NULL THEN NULL ELSE json_array(coalesce(r.artist, CASE r.era_id WHEN 'dezaemon' THEN '井上⊿' END, er.name)) END,
    'composer', CASE WHEN nullif(json_extract(t.credits, '$.composer'), '') IS NULL THEN NULL ELSE json_array(json_extract(t.credits, '$.composer')) END,
    'lyricist', CASE WHEN nullif(json_extract(t.credits, '$.lyricist'), '') IS NULL THEN NULL ELSE json_array(json_extract(t.credits, '$.lyricist')) END,
    'arranger', CASE WHEN nullif(json_extract(t.credits, '$.arranger'), '') IS NULL THEN NULL ELSE json_array(json_extract(t.credits, '$.arranger')) END,
    'musicbrainz_albumid', CASE WHEN nullif(json_extract(e.external_ids, '$.musicbrainz_release'), '') IS NULL THEN NULL ELSE json_array(json_extract(e.external_ids, '$.musicbrainz_release')) END,
    'musicbrainz_releasegroupid', CASE WHEN nullif(json_extract(e.external_ids, '$.musicbrainz_release_group'), '') IS NULL THEN NULL ELSE json_array(json_extract(e.external_ids, '$.musicbrainz_release_group')) END,
    'musicbrainz_recordingid', CASE WHEN nullif(coalesce(json_extract(edition_tracks.external_ids, '$.musicbrainz_recording'), json_extract(t.external_ids, '$.musicbrainz_recording')), '') IS NULL THEN NULL ELSE json_array(coalesce(json_extract(edition_tracks.external_ids, '$.musicbrainz_recording'), json_extract(t.external_ids, '$.musicbrainz_recording'))) END,
    'musicbrainz_trackid', CASE WHEN nullif(json_extract(edition_tracks.external_ids, '$.musicbrainz_track'), '') IS NULL THEN NULL ELSE json_array(json_extract(edition_tracks.external_ids, '$.musicbrainz_track')) END))
  FROM tracks t, editions e JOIN releases r ON r.id = e.release_id JOIN eras er ON er.id = r.era_id
  WHERE t.id = edition_tracks.track_id AND e.id = edition_tracks.edition_id
), '{}');

-- An edition's chosen cover goes to its rows (an edition without a track list keeps it on the edition).
UPDATE edition_tracks SET cover = json_object('file', (SELECT cover_file_id FROM editions e WHERE e.id = edition_tracks.edition_id), 'mode', 'replace')
WHERE (SELECT cover_file_id FROM editions e WHERE e.id = edition_tracks.edition_id) IS NOT NULL;
UPDATE editions SET cover_file_id = NULL WHERE cover_file_id IS NOT NULL AND EXISTS (SELECT 1 FROM edition_tracks et WHERE et.edition_id = editions.id);
