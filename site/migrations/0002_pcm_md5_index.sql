-- `ra probe` fills files.pcm_md5; the admin looks up other files with the same decoded audio.
CREATE INDEX files_pcm_md5 ON files (pcm_md5) WHERE pcm_md5 IS NOT NULL;
