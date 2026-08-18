-- Logo and favicon, stored in the row rather than on a volume.
--
-- Two reasons. The site row is already the single source of truth for
-- branding, and it survives a world wipe by design (see WorldWipeService) —
-- a file on the PZ data volume would not, and losing the logo on a wipe is
-- exactly the class of bug that keeps happening here. Second, it needs no new
-- mount: the API and the UI containers do not share a writable directory.
--
-- Small by construction: the upload path caps each at 512 KB, so this never
-- turns the site row into something expensive to read. The columns are only
-- selected by the two handlers that serve the images, never by the settings
-- query the landing page makes on every load.

ALTER TABLE site_settings
    ADD COLUMN logo bytea,
    ADD COLUMN logo_type text,
    ADD COLUMN favicon bytea,
    ADD COLUMN favicon_type text;

-- An image with no content type could not be served back with the right
-- header, and a content type with no image is a dangling promise.
ALTER TABLE site_settings
    ADD CONSTRAINT site_settings_logo_complete
        CHECK ((logo IS NULL) = (logo_type IS NULL)),
    ADD CONSTRAINT site_settings_favicon_complete
        CHECK ((favicon IS NULL) = (favicon_type IS NULL));
