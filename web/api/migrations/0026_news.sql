-- Public news. Drafts have a null published_at. Future dates stay hidden
-- until that instant.

CREATE TABLE news_posts (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug         text        NOT NULL UNIQUE,
    title        text        NOT NULL,
    excerpt      text,
    body         text        NOT NULL,
    pinned       boolean     NOT NULL DEFAULT false,
    published_at timestamptz,
    author_id    uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX news_posts_public_idx
    ON news_posts (pinned DESC, published_at DESC)
    WHERE published_at IS NOT NULL;
