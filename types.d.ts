interface AnimeQuery {
    anilistId: number; // anilist anime id
    anidbAid?: number; // anidb anime id
    anidbEid?: number; // anidb episode id
    tvdbId?: number; // thetvdb anime id
    tvdbEId?: number; // thetvdb episode id
    imdbId?: string; // imdb id
    tmdbId?: string // tmdb anime id
    titles: string[]; // list of titles and alternative titles
    episode: number;
    episodeCount?: number; // total episode count for the series
    absoluteEpisodeNumber?: number; // absolute episode number, for anime with non-standard episode numbering
    resolution: "2160" | "1080" | "720" | "540" | "480" | "";
    exclusions: string[]; // list of keywords to exclude from searches, this might be unsupported codecs (e.g., "x265"), sources (e.g., "web-dl"), or other keywords (e.g., "uncensored")
    fetch: typeof globalThis.fetch; // fetch function to perform network requests, this function should be used instead of the global fetch to ensure CORS requests work properly

    // undocumented but present in query
    media?: {
        synonyms?: string[];

        nextAiringEpisode?: {
            id?: number;
            timeUntilAiring?: number;
            episode?: number;
        };
    };
}

interface TorrentResult {
    title: string; // torrent title
    link: string; // link to .torrent file, or magnet link or infoHash
    id?: number;
    seeders: number;
    leechers: number;
    downloads: number;
    accuracy: "high" | "medium" | "low";
    hash: string; // info hash
    size: number; // size in bytes
    date: Date; // date the torrent was uploaded
    type?: "batch" | "best" | "alt";
    dualAudio?: boolean; // whether the torrent contains dual audio tracks
}
