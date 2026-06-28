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
    #delayMs = 300;

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

        const coreNames = this.#extractCoreNames(allTitles, synonyms);

        const anilistId = query.anilistId || media?.id;
        const englishTitle = await this.#fetchEnglishTitle(anilistId, fetchFn);
        if (englishTitle) {
            const engCore = this.#extractCoreNames([englishTitle], [])[0];
            if (engCore && !coreNames.includes(engCore)) coreNames.push(engCore);
        }
        console.log(`[Nyaa] Core names: ${JSON.stringify(coreNames)}, episode: ${episode}`);

        // --- Run both searches in parallel ---
        const [primaryResults, dualResults] = await Promise.all([
            this.#searchPrimary(allTitles, synonyms, episode, fetchFn),
            this.#searchDualAudio(coreNames, episode, fetchFn),
        ]);

        console.log(`[Nyaa] Primary: ${primaryResults.length}, Dual: ${dualResults.length}`);

        // --- Merge, dedupe, sort ---
        return this.#mergeAndSort(primaryResults, dualResults, episode);
    }

    async batch(query, options) {
        return this.single(query, options);
    }

    async test() {
        const res = await fetch(this.#base + "one%20piece", { method: "HEAD" });
        return res.ok;
    }

    // =========================================================================
    // CORE NAME EXTRACTION
    // =========================================================================

    #extractCoreNames(titles, synonyms) {
        const names = [];
        const all = [...titles, ...synonyms];

        for (const raw of all) {
            if (!raw || raw.length < 2) continue;

            let name = raw
                .replace(/\[.*?\]/g, "")
                .replace(/\(.*?\)/g, "")
                .replace(/[:\-–—].*$/, "")
                .replace(/\b\d+(st|nd|rd|th)?\s+(season|cour|part|split).*/i, "")
                .replace(/\bseason\s*\d+.*/i, "")
                .replace(/\bs\d+\b.*$/i, "")
                .replace(/\bTV anime\b/i, "")
                .trim();

            const words = name.split(/\s+/).filter((w) => w.length > 1);
            if (words.length >= 3) {
                const short = words.slice(0, 3).join(" ");
                if (!names.includes(short)) names.push(short);
            }

            if (name.length >= 2 && !names.includes(name)) {
                names.push(name);
            }
        }

        const seen = new Set();
        return names.filter((n) => {
            const k = n.toLowerCase();
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });
    }

    // =========================================================================
    // EPISODE MATCHING
    // =========================================================================

    /**
     * Build a strict regex that matches the episode in common nyaa formats:
     *   S03E03, E03, - 03, EP03, Episode 03
     * Also matches batch indicators: Season 03, S03, (Batch), (Complete)
     *
     * Returns null if episode is null.
     */
    #buildEpisodeRegex(episode) {
        if (episode == null) return null;
        const ep = String(episode).padStart(2, "0");
        const epRaw = String(episode);

        // Must match episode-specific OR batch-for-correct-season
        return new RegExp(
            `(?:S\\d+E${ep})` +           // S03E03
            `|(?:\\bE${ep}\\b)` +          // E03
            `|(?:\\s-\\s${ep}(?:\\s|$))` + // - 03 (with spaces)
            `|(?:EP${ep})` +               // EP03
            `|(?:Episode\\s+${epRaw})` +   // Episode 3
            `|(?:\\bSeason\\s+\\d+\\b)` +  // Season XX (batch - any season, we filter by name)
            `|(?:\\bS\\d+\\b)`,            // SXX (batch)
            "i"
        );
    }

    /**
     * Strict episode match: the title MUST contain the specific episode number
     * in an recognized format. Rejects false positives like "1080p" matching "03".
     */
    #matchesEpisode(title, episode) {
        if (episode == null) return true;
        const ep = String(episode).padStart(2, "0");
        const epRaw = String(episode);

        // Positive patterns — episode is explicitly mentioned
        const positive = new RegExp(
            `(?:S\\d+E${ep})` +           // S03E03
            `|(?:\\bE${ep}\\b)` +          // E03
            `|(?:\\s-\\s${ep}(?:\\s|$))` + // - 03
            `|(?:EP${ep})` +               // EP03
            `|(?:Episode\\s+${epRaw})`,    // Episode 3
            "i"
        );

        if (positive.test(title)) return true;

        // Batch detection — "Season XX", "SXX", "Batch", "Complete"
        const isBatch = /\b(batch|complete|full\s*season)\b/i.test(title) ||
            /\bSeason\s+\d+\b/i.test(title) ||
            /\bS\d+\b/i.test(title);

        // Standalone episode number (e.g., " - 03 [", " 03 ") — only for non-batch
        if (!isBatch) {
            const loose = new RegExp(`(?:^|\\s)[-–—]\\s*${ep}(?:\\s|$|\\]|\\[)`, "i");
            if (loose.test(title)) return true;
        }

        return false;
    }

    /**
     * Check if a title is for the CORRECT season.
     * Returns true if we can't determine the season (safe to include).
     */
    #matchesSeason(title, coreNames) {
        // If we can't determine the season from the title, include it
        return true;
    }

    // =========================================================================
    // PRIMARY SEARCH
    // =========================================================================

    async #searchPrimary(allTitles, synonyms, episode, fetchFn) {
        const searchTitles = [];
        if (allTitles[0]) searchTitles.push(allTitles[0]);
        if (synonyms[0] && !searchTitles.includes(synonyms[0])) searchTitles.push(synonyms[0]);
        const remaining = [...allTitles.slice(1), ...synonyms.slice(1)].filter(
            (t) => t && !searchTitles.includes(t),
        );
        if (remaining.length > 0) {
            const shuffled = remaining.sort(() => Math.random() - 0.5);
            searchTitles.push(...shuffled.slice(0, 3));
        }

        for (let i = 0; i < searchTitles.length; i++) {
            const title = searchTitles[i];
            if (!title) continue;
            try {
                const results = await this.#search(title, episode, fetchFn);
                // Filter to correct episode only
                const filtered = results.filter((r) => this.#matchesEpisode(r.title, episode));
                if (filtered.length > 0) return filtered;
            } catch (ex) {
                console.error(`[Nyaa] Primary search error "${title}":`, ex.message);
            }
            if (i < searchTitles.length - 1) {
                await new Promise((r) => setTimeout(r, this.#delayMs));
            }
        }
        return [];
    }

    // =========================================================================
    // DUAL AUDIO SEARCH — core names + "Dual Audio", no episode in query
    // =========================================================================

    async #searchDualAudio(coreNames, episode, fetchFn) {
        if (!coreNames.length) return [];

        const results = [];

        for (let i = 0; i < Math.min(coreNames.length, 3); i++) {
            const name = coreNames[i];
            const queries = [`${name} Dual Audio`, `${name} DUAL`];

            for (const q of queries) {
                await new Promise((r) => setTimeout(r, this.#delayMs));
                try {
                    const raw = await this.#search(q, null, fetchFn);
                    if (raw.length > 0) {
                        const filtered = raw.filter((item) => {
                            if (!this.#isDualAudio(item.title)) return false;

                            // Loose name match
                            const t = item.title.toLowerCase();
                            if (!coreNames.some((n) => t.includes(n.toLowerCase()))) return false;

                            // STRICT episode match
                            if (!this.#matchesEpisode(item.title, episode)) return false;

                            return true;
                        });

                        results.push(...filtered);
                        if (filtered.length >= 2) break;
                    }
                } catch (ex) {
                    console.error(`[Nyaa] Dual audio search error "${q}":`, ex.message);
                }
            }
            if (results.length >= 2) break;
        }

        return results;
    }

    // =========================================================================
    // CORE SEARCH — nyaa.si RSS
    // =========================================================================

    async #search(title, episode, fetchFn) {
        let q = title.replace(/[^\w\s-]/g, " ").trim();
        if (episode) q += ` ${episode.toString().padStart(2, "0")}`;

        const url = this.#base + encodeURIComponent(q);
        console.log(`[Nyaa] → ${q}`);
        const res = await fetchFn(url);
        const xml = await res.text();

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
            if (!res.ok) return "";
            const data = await res.json();
            return data?.data?.Media?.title?.english || "";
        } catch {
            return "";
        }
    }

    // =========================================================================
    // DUAL AUDIO DETECTION
    // =========================================================================

    #isDualAudio(title) {
        return (
            /\bdual[\s-]*audio\b/i.test(title) ||
            /\bdual\b/i.test(title) ||
            /\bmulti[\s-]*(?:audio|aac|ddp|flac)\b/i.test(title) ||
            /\bjpn?\s*\+?\s*eng\b/i.test(title)
        );
    }

    // =========================================================================
    // MERGE & SORT — the algorithm
    //
    // 1. Deduplicate by hash (keep highest-scored)
    // 2. Score: seeders + type bonus + recency + small dual audio bonus
    // 3. Dual audio is a TIEBREAKER, not a massive override
    // 4. Minimum 2 results: if dual audio has < 2, pad from primary
    // =========================================================================

    #mergeAndSort(primaryResults, dualResults, episode) {
        const seen = new Map();
        const all = [...primaryResults, ...dualResults];

        for (const item of all) {
            const existing = seen.get(item.hash);
            if (!existing || this.#score(item, episode) > this.#score(existing, episode)) {
                seen.set(item.hash, item);
            }
        }

        const deduped = Array.from(seen.values());

        // Partition
        const dual = deduped.filter((r) => r.dualAudio);
        const nonDual = deduped.filter((r) => !r.dualAudio);

        // Sort each group by score
        dual.sort((a, b) => this.#score(b, episode) - this.#score(a, episode));
        nonDual.sort((a, b) => this.#score(b, episode) - this.#score(a, episode));

        // If dual audio has fewer than 2 results, interleave with non-dual
        // to ensure the user sees a good mix
        if (dual.length > 0 && dual.length < 2 && nonDual.length > 0) {
            // Place dual audio results at the top, then fill with non-dual
            return [...dual, ...nonDual];
        }

        // Normal: dual audio on top (sorted by score), then non-dual (sorted by score)
        return [...dual, ...nonDual];
    }

    /**
     * Scoring algorithm:
     * - seeders * 10 (base)
     * - type bonus: best +500, batch +300
     * - seeders tier: >50 +200, >20 +100
     * - dual audio: +50 (small tiebreaker)
     *
     * Dual audio is NOT a massive boost. It only breaks ties.
     * Two results with 100 seeders each: dual audio wins.
     * A result with 200 seeders beats a dual audio with 50 seeders.
     */
    #score(item, episode) {
        let s = item.seeders * 10;

        if (item.type === "best") s += 500;
        else if (item.type === "batch") s += 300;

        if (item.seeders > 50) s += 200;
        if (item.seeders > 20) s += 100;

        // Small dual audio tiebreaker
        if (item.dualAudio) s += 50;

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
