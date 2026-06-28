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
            const targetEpisode = Number(episode);
            const nextEpisode = nextAiringEpisode.episode;
            if (targetEpisode >= nextEpisode) {
                const secs = nextAiringEpisode.timeUntilAiring ?? 0;
                if (secs > 3600) {
                    console.log(`[Nyaa] Episode ${targetEpisode} hasn't aired yet. Skipping.`);
                    return [];
                }
            }
        }

        const allTitles = (titles ?? []).map((t) => t.trim()).filter(Boolean);
        const synonyms = (media?.synonyms ?? []).map((s) => s.trim()).filter(Boolean);

        // Build primary title list
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

        if (!primaryTitles.length) return [];

        console.log(`[Nyaa] Searching with ${primaryTitles.length} titles`);

        let allResults = [];

        // 1. Primary search — normal results
        for (let i = 0; i < primaryTitles.length; i++) {
            const title = primaryTitles[i];
            if (!title) continue;
            try {
                const results = await this.#search(title, episode);
                if (results.length > 0) {
                    allResults = results;
                    break;
                }
            } catch (ex) {
                console.error(`[Nyaa] Error searching "${title}":`, ex.message);
            }
            if (i < primaryTitles.length - 1) {
                await new Promise((r) => setTimeout(r, this.#delayMs));
            }
        }

        // 2. Dual audio search — fetch English title, search without episode, filter strictly
        const dualResults = await this.#searchDualAudio(query, allTitles, synonyms, episode);
        if (dualResults.length > 0) {
            allResults.push(...dualResults);
        }

        if (allResults.length > 0) {
            return this.#deduplicateAndSort(allResults);
        }

        // 3. Fallback — try other title variants
        console.log(`[Nyaa] No results. Trying fallback...`);
        const fallbackCandidates = [...allTitles.slice(1), ...synonyms.slice(1)].filter(
            (t) => t && !primaryTitles.includes(t),
        );
        const shuffled = fallbackCandidates.sort(() => Math.random() - 0.5);
        const fallbackTitles = shuffled.slice(0, 5);

        for (let i = 0; i < fallbackTitles.length; i++) {
            try {
                const results = await this.#search(fallbackTitles[i], episode);
                if (results.length > 0) allResults.push(...results);
            } catch (err) {
                console.error(`[Nyaa] Fallback failed:`, err.message);
            }
            if (i < fallbackTitles.length - 1) {
                await new Promise((r) => setTimeout(r, this.#delayMs));
            }
        }

        return this.#deduplicateAndSort(allResults);
    }

    async batch(query, options) {
        return this.single(query, options);
    }

    async test() {
        const res = await fetch(this.#base + "one%20piece", { method: "HEAD" });
        return res.ok;
    }

    /**
     * Fetch English title from AniList
     */
    async #fetchEnglishTitle(anilistId) {
        const gql = `query ($id: Int) { Media(id: $id, type: ANIME) { title { english } } }`;
        const res = await fetch("https://graphql.anilist.co", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: gql, variables: { id: anilistId } }),
        });
        if (!res.ok) return "";
        const data = await res.json();
        return data?.data?.Media?.title?.english || "";
    }

    /**
     * Search for dual audio releases.
     * Searches without episode number (uploaders use SXXEXX format),
     * then filters strictly by anime name + episode.
     */
    async #searchDualAudio(query, allTitles, synonyms, episode) {
        // Get English title from AniList
        const anilistId = query.anilistId || query.media?.id;
        let englishTitle = "";
        if (anilistId) {
            try {
                englishTitle = await this.#fetchEnglishTitle(anilistId);
            } catch (ex) {
                console.error(`[Nyaa] AniList fetch failed:`, ex.message);
            }
        }

        // Build search query: English title or short romaji + "Dual Audio"
        const baseTitle = allTitles[0] || synonyms[0] || "";
        const shortRomaji = baseTitle.split(/[:\-–—]/)[0].trim();
        const searchTitle = englishTitle || (shortRomaji.length >= 3 ? shortRomaji : baseTitle);

        if (!searchTitle) return [];

        await new Promise((r) => setTimeout(r, this.#delayMs));
        let raw;
        try {
            raw = await this.#search(searchTitle + " Dual Audio", null, false);
        } catch (ex) {
            console.error(`[Nyaa] Dual audio search failed:`, ex.message);
            return [];
        }

        if (!raw.length) return [];

        // Build keywords that must match (all title variants, before colon/dash)
        const keywords = [
            ...(englishTitle ? [englishTitle.toLowerCase()] : []),
            ...allTitles.map((t) => t.toLowerCase().split(/[:\-–—]/)[0].trim()),
            ...synonyms.map((s) => s.toLowerCase().split(/[:\-–—]/)[0].trim()),
        ].filter((k) => k && k.length >= 3);

        // Strict episode matching: SXXEXX or EXX only (no loose "- 03" matches)
        const epStr = episode != null ? String(episode) : null;
        const epPadded = epStr ? epStr.padStart(2, "0") : null;
        const epRegex = epPadded
            ? new RegExp(`(?:S\\d+E${epPadded}|\\bE${epPadded}\\b)`, "i")
            : null;

        return raw.filter((item) => {
            const t = item.title.toLowerCase();

            // Must match anime name
            const matchesAnime = keywords.some((kw) => t.includes(kw));
            if (!matchesAnime) return false;

            // Must match episode if provided
            if (epRegex) return epRegex.test(item.title);

            return true;
        });
    }

    /**
     * Core nyaa.si RSS search
     */
    async #search(title, episode) {
        let q = title.replace(/[^\w\s-]/g, " ").trim();
        if (episode) q += ` ${episode.toString().padStart(2, "0")}`;

        const url = this.#base + encodeURIComponent(q);
        const res = await fetch(url);
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

            const isDualAudio =
                /\[.*dual.*audio.*\]/i.test(titleVal) ||
                /\(.*dual.*audio/i.test(titleVal) ||
                /\bdual\b/i.test(titleVal) ||
                /\bmulti\b.*(?:audio|aac|ddp|flac)/i.test(titleVal) ||
                /jpn?\+eng/i.test(titleVal) ||
                /japanese\s*\+?\s*english/i.test(titleVal);

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
                dualAudio: isDualAudio,
            });
        }

        return results;
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

    #deduplicateAndSort(results) {
        const seen = new Map();
        for (const item of results) {
            if (!seen.has(item.hash) || this.#qualityScore(item) > this.#qualityScore(seen.get(item.hash))) {
                seen.set(item.hash, item);
            }
        }
        return Array.from(seen.values()).sort((a, b) => this.#qualityScore(b) - this.#qualityScore(a));
    }

    #qualityScore(item) {
        let score = item.seeders * 10;
        if (item.type === "best") score += 1000;
        else if (item.type === "batch") score += 500;
        if (item.seeders > 50) score += 300;
        if (item.seeders > 20) score += 100;
        // Dual audio gets a small bump — just enough to break ties, not override relevance
        if (item.dualAudio) score += 50;
        return score;
    }
}

export default new Nyaa();
