/**
 * Hayase Nyaa Extension
 *
 * DO WHAT THE FUCK YOU WANT TO PUBLIC LICENSE
 * Version 2, December 2004
 */

/**
 * @typedef {import("./types")} HayaseExtensionTypes
 * @typedef {HayaseExtensionTypes.AnimeQuery} AnimeQuery
 * @typedef {HayaseExtensionTypes.TorrentResult} TorrentResult
 */

class Nyaa {
    #base = "https://nyaa.si/?page=rss&q=";
    #delayMs = 400;

    /**
     * @param {AnimeQuery} query
     * @param {Record<string, string | number | boolean>?} options
     * @returns {Promise<TorrentResult[]>}
     */
    async single(query, options) {
        const { titles, media, episode } = query;
        const nextAiringEpisode = media?.nextAiringEpisode;
        if (
            episode != null &&
            nextAiringEpisode?.timeUntilAiring != null &&
            nextAiringEpisode?.episode != null
        ) {
            const target = Number(episode);
            const next = nextAiringEpisode.episode;
            if (target >= next) {
                const secs = nextAiringEpisode.timeUntilAiring ?? 0;
                if (secs > 3600) {
                    console.log(`[Nyaa] Ep ${target} hasn't aired yet. Skipping.`);
                    return [];
                }
            }
        }

        const allTitles = (titles ?? []).map((t) => t.trim()).filter(Boolean);
        const synonyms = (media?.synonyms ?? []).map((s) => s.trim()).filter(Boolean);
        const fetchFn = query.fetch || globalThis.fetch;

        // --- Step 1: Get English title from AniList ---
        const anilistId = query.anilistId || media?.id;
        const englishTitle = await this.#fetchEnglishTitle(anilistId, fetchFn);
        console.log(`[Nyaa] English title: "${englishTitle || "(none)"}"`);

        // --- Step 2: Build search title variants ---
        // We need both romaji (for primary) and English (for dual audio)
        const romajiTitle = allTitles[0] || synonyms[0] || "";
        const shortRomaji = romajiTitle.split(/[:\-–—]/)[0].trim();

        // --- Step 3: Run both searches ---
        const [primaryResults, dualResults] = await Promise.all([
            this.#searchWithTitles(allTitles, synonyms, episode, fetchFn),
            this.#searchDualAudio(englishTitle, shortRomaji, episode, fetchFn),
        ]);

        console.log(`[Nyaa] Primary: ${primaryResults.length} results, Dual audio: ${dualResults.length} results`);

        // --- Step 4: Merge and score ---
        const all = [...primaryResults, ...dualResults];
        return this.#mergeAndSort(all, episode);
    }

    async batch(query, options) {
        return this.single(query, options);
    }

    async test() {
        const res = await fetch(this.#base + "one%20piece", { method: "HEAD" });
        return res.ok;
    }

    // =========================================================================
    // PRIMARY SEARCH — uses romaji titles with episode number
    // =========================================================================

    /**
     * Search using multiple title variants, return first successful batch
     */
    async #searchWithTitles(allTitles, synonyms, episode, fetchFn) {
        const primaryTitles = [];
        if (allTitles[0]) primaryTitles.push(allTitles[0]);
        if (synonyms[0] && !primaryTitles.includes(synonyms[0])) primaryTitles.push(synonyms[0]);
        const remaining = [...allTitles.slice(1), ...synonyms.slice(1)].filter(
            (t) => t && !primaryTitles.includes(t),
        );
        if (remaining.length > 0) {
            const shuffled = remaining.sort(() => Math.random() - 0.5);
            primaryTitles.push(...shuffled.slice(0, 3));
        }

        for (let i = 0; i < primaryTitles.length; i++) {
            const title = primaryTitles[i];
            if (!title) continue;
            try {
                const results = await this.#search(title, episode, fetchFn);
                if (results.length > 0) return results;
            } catch (ex) {
                console.error(`[Nyaa] Error searching "${title}":`, ex.message);
            }
            if (i < primaryTitles.length - 1) {
                await new Promise((r) => setTimeout(r, this.#delayMs));
            }
        }
        return [];
    }

    // =========================================================================
    // DUAL AUDIO SEARCH — uses English title, no episode in query
    // =========================================================================

    /**
     * Search for dual audio using English title or short romaji.
     * No episode in query (uploaders use SXXEXX format).
     * Filters strictly by anime name + episode after fetching.
     */
    async #searchDualAudio(englishTitle, shortRomaji, episode, fetchFn) {
        // Pick best search term: English > short romaji
        const searchTerm = englishTitle || (shortRomaji.length >= 3 ? shortRomaji : "");
        if (!searchTerm) return [];

        await new Promise((r) => setTimeout(r, this.#delayMs));

        let raw;
        try {
            raw = await this.#search(searchTerm + " Dual Audio", null, fetchFn);
        } catch (ex) {
            console.error(`[Nyaa] Dual audio search failed:`, ex.message);
            return [];
        }

        if (!raw.length) return [];

        // Build anime name keywords for filtering
        const keywords = [
            englishTitle,
            shortRomaji,
        ].filter((k) => k && k.length >= 3).map((k) => k.toLowerCase());

        if (!keywords.length) return [];

        // Strict episode filter
        const epPadded = episode != null ? String(episode).padStart(2, "0") : null;

        return raw.filter((item) => {
            const t = item.title.toLowerCase();

            // Must match anime name
            if (!keywords.some((kw) => t.includes(kw))) return false;

            // If episode specified, must match it
            if (epPadded) {
                // Match S03E03, E03, or "Season 03" / "S03" for batches
                const epRegex = new RegExp(
                    `(?:S\\d+E${epPadded}|\\bE${epPadded}\\b|Season\\s+0${episode}|\\bS0${episode}\\b)`,
                    "i"
                );
                if (!epRegex.test(item.title)) return false;
            }

            return true;
        });
    }

    // =========================================================================
    // CORE SEARCH — nyaa.si RSS
    // =========================================================================

    /**
     * @param {string} title
     * @param {string|number|null} episode
     * @param {typeof fetch} fetchFn
     * @returns {Promise<TorrentResult[]>}
     */
    async #search(title, episode, fetchFn) {
        let q = title.replace(/[^\w\s-]/g, " ").trim();
        if (episode) q += ` ${episode.toString().padStart(2, "0")}`;

        const url = this.#base + encodeURIComponent(q);
        console.log(`[Nyaa] → ${q}`);
        const res = await fetchFn(url);
        const xml = await res.text();

        /** @type {TorrentResult[]} */
        const results = [];
        const itemRegex = /<item>[\s\S]*?<\/item>/gi;
        let match;

        while ((match = itemRegex.exec(xml)) !== null) {
            const item = match[0];

            const getTag = (tag) => {
                const m = item.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
                return m ? m[1].trim() : "";
            };
            const getNyaa = (tag) => {
                const m = item.match(new RegExp(`<nyaa:${tag}>([\\s\\S]*?)</nyaa:${tag}>`, "i"));
                return m ? m[1].trim() : null;
            };

            const titleVal = getTag("title");
            const hash = getNyaa("infoHash") || "";
            if (!hash) continue;

            const magnet = `magnet:?xt=urn:btih:${hash.toUpperCase()}&dn=${encodeURIComponent(titleVal)}`;
            const size = this.#parseSize(getNyaa("size") || "");
            const isTrusted = getNyaa("trusted") === "Yes";
            const isRemake = getNyaa("remake") === "Yes";
            const lowerTitle = titleVal.toLowerCase();
            const categoryId = getNyaa("categoryId") || "";
            const seeders = parseInt(getNyaa("seeders")) || 0;

            let type = "alt";
            if (isRemake) {
                type = "alt";
            } else if (isTrusted && seeders >= 5) {
                type = "best";
            } else if (
                lowerTitle.includes("batch") ||
                lowerTitle.includes("complete") ||
                lowerTitle.includes("season") ||
                /\b(s\d{2}|full season)\b/i.test(lowerTitle) ||
                /s\d{2}e?0[1-9]/i.test(lowerTitle) ||
                (categoryId.startsWith("1_") &&
                    !lowerTitle.includes("480p") &&
                    !lowerTitle.includes("720p"))
            ) {
                type = "batch";
            } else if (
                isTrusted ||
                lowerTitle.includes("1080p") ||
                lowerTitle.includes("2160p") ||
                lowerTitle.includes("bluray") ||
                lowerTitle.includes("remux") ||
                lowerTitle.includes("x265") ||
                lowerTitle.includes("hevc")
            ) {
                type = "best";
            }

            results.push({
                title: titleVal,
                link: magnet,
                hash,
                seeders,
                leechers: parseInt(getNyaa("leechers")) || 0,
                downloads: parseInt(getNyaa("downloads")) || 0,
                size,
                date: getTag("pubDate") ? new Date(getTag("pubDate")) : new Date(),
                accuracy: "medium",
                type,
                dualAudio: this.#isDualAudio(titleVal),
            });
        }

        return results;
    }

    // =========================================================================
    // ANILIST
    // =========================================================================

    async #fetchEnglishTitle(anilistId, fetchFn) {
        if (!anilistId) return "";
        try {
            const gql = `query ($id: Int) { Media(id: $id, type: ANIME) { title { english } } }`;
            const res = await fetchFn("https://graphql.anilist.co", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ query: gql, variables: { id: anilistId } }),
            });
            if (!res.ok) {
                console.error(`[Nyaa] AniList HTTP ${res.status}`);
                return "";
            }
            const data = await res.json();
            return data?.data?.Media?.title?.english || "";
        } catch (ex) {
            console.error(`[Nyaa] AniList error:`, ex.message);
            return "";
        }
    }

    // =========================================================================
    // SCORING & SORTING
    // =========================================================================

    #isDualAudio(title) {
        return (
            /\[.*dual.*audio.*\]/i.test(title) ||
            /\(.*dual.*audio/i.test(title) ||
            /\bdual\b/i.test(title) ||
            /\bmulti\b.*(?:audio|aac|ddp|flac)/i.test(title) ||
            /jpn?\+eng/i.test(title) ||
            /japanese\s*\+?\s*english/i.test(title)
        );
    }

    /**
     * Merge results from primary + dual audio search.
     * Deduplicate by hash, then sort:
     *   1. Dual audio (by seeders)
     *   2. Non-dual audio (by seeders)
     */
    #mergeAndSort(results, episode) {
        const seen = new Map();

        for (const item of results) {
            const existing = seen.get(item.hash);
            if (!existing || this.#score(item, episode) > this.#score(existing, episode)) {
                seen.set(item.hash, item);
            }
        }

        const deduped = Array.from(seen.values());

        // Partition: dual audio first, then everything else
        const dual = deduped.filter((r) => r.dualAudio);
        const nonDual = deduped.filter((r) => !r.dualAudio);

        // Sort each group by score (descending)
        dual.sort((a, b) => this.#score(b, episode) - this.#score(a, episode));
        nonDual.sort((a, b) => this.#score(b, episode) - this.#score(a, episode));

        // Merge: dual audio always on top
        return [...dual, ...nonDual];
    }

    /**
     * Score a result. Higher = better.
     * Dual audio gets a massive boost to always appear first.
     */
    #score(item, episode) {
        let s = item.seeders * 10;

        // Type bonus
        if (item.type === "best") s += 1000;
        else if (item.type === "batch") s += 500;

        // Seeder tier bonus
        if (item.seeders > 50) s += 300;
        if (item.seeders > 20) s += 100;

        // Dual audio: massive boost to guarantee top placement
        if (item.dualAudio) s += 10000;

        return s;
    }

    #parseSize(sizeStr) {
        if (!sizeStr) return 0;
        const m = sizeStr.match(/^([\d.]+)\s*(B|KiB|MiB|GiB|TiB)$/i);
        if (!m) return 0;
        const num = parseFloat(m[1]);
        const unit = m[2].toUpperCase();
        const mult = { B: 1, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 };
        return Math.round(num * mult[unit]);
    }
}

export default new Nyaa();
