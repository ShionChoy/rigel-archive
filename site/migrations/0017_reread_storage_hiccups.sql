-- The embedded tags and pictures of 26 audio files were recorded as unreadable on 2026-09-28 because storage
-- answered with a passing error (R2 10043, «look at cloudflarestatus.com»), not because of the files. Such
-- errors are no longer recorded (lib/embedded.ts StorageHiccup); forgetting these rows lets the next reads
-- (every 10 minutes) read the files again. The table only caches what the files carry.
DELETE FROM embedded WHERE error LIKE '%cloudflarestatus%' OR error LIKE 'get: %';
